// api/workers/process-batch.js — Main Orchestrator
// §9 — claim batch → phase1 parse → phase2 search → phase3 QA → settle record
// Cron: every minute (vercel.json). Auth: CRON_SECRET bearer OR x-api-key.

import { supabase, logAudit, updateStatus, incrementJobCounter } from '../../lib/supabase.js';
import { requireCronOrApiKey } from '../../lib/auth.js';
import { isRoleBasedEmail, isNumericLocalPart, randomJitter, sleep } from '../../lib/utils.js';
import { parseEmail } from './phase1-parse.js';
import { triangulateLinkedIn } from './phase2-search.js';
import { runQaGate } from './phase3-qa.js';
import { checkJobCompletion } from '../../lib/jobs.js';

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? '5', 10);
const WORKER_ID = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * Vercel serverless handler — triggered by cron every minute.
 */
export default async function handler(req, res) {
  // Auth gate: cron bearer OR API key
  const auth = requireCronOrApiKey(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  // Stale lock cleanup (§12.1) — run at top of every invocation
  try {
    await supabase.rpc('reset_stale_locks');
  } catch (e) {
    console.warn('[orchestrator] reset_stale_locks failed:', e.message);
  }

  // Claim a batch of pending records
  let records;
  try {
    const { data, error } = await supabase.rpc('claim_batch', {
      batch_size: BATCH_SIZE,
      worker_id: WORKER_ID,
    });
    if (error) throw error;
    records = data ?? [];
  } catch (e) {
    console.error('[orchestrator] claim_batch failed:', e.message);
    return res.status(500).json({ error: 'Failed to claim batch', details: e.message });
  }

  if (records.length === 0) {
    return res.status(200).json({ message: 'No pending records', processed: 0 });
  }

  console.log(`[orchestrator] ${WORKER_ID} claimed ${records.length} record(s)`);

  const results = { verified: 0, manual_review: 0, errors: 0 };

  for (const record of records) {
    const { id: recordId, email, job_id: jobId } = record;

    try {
      await processRecord(record, results);
    } catch (unexpectedErr) {
      // Outer catch — should never reach here; processRecord handles its own errors
      console.error(`[orchestrator] unexpected error for record ${recordId}:`, unexpectedErr.message);
      await updateStatus(recordId, 'manual_review', `Unexpected error: ${unexpectedErr.message}`);
      await logAudit(recordId, 'orchestrator', 'unexpected_error', {}, unexpectedErr.message);
      await incrementJobCounter(jobId, 'manual_review');
      results.manual_review++;
    }

    // Check if this job is now fully complete
    if (jobId) {
      try {
        await checkJobCompletion(jobId);
      } catch (e) {
        console.warn('[orchestrator] checkJobCompletion failed:', e.message);
      }
    }

    // Polite delay between records (§6.2 anti-hammering)
    if (records.indexOf(record) < records.length - 1) {
      await sleep(randomJitter(3000, 8000));
    }
  }

  return res.status(200).json({
    processed: records.length,
    ...results,
    worker_id: WORKER_ID,
  });
}

/**
 * Process a single record through all three phases.
 * All errors are caught and result in manual_review — never throws.
 */
async function processRecord(record, results) {
  const { id: recordId, email, job_id: jobId } = record;

  // ── Fast-fails (before any LLM call) ─────────────────────────────────────
  if (isRoleBasedEmail(email)) {
    const reason = 'Role-based email — cannot resolve to individual';
    await updateStatus(recordId, 'manual_review', reason);
    await logAudit(recordId, 'pre_check', 'role_based_email', { email }, null);
    await incrementJobCounter(jobId, 'manual_review');
    results.manual_review++;
    console.log(`[record ${recordId}] → manual_review: ${reason}`);
    return;
  }

  if (isNumericLocalPart(email)) {
    const reason = 'Numeric-only local part — no name extractable';
    await updateStatus(recordId, 'manual_review', reason);
    await logAudit(recordId, 'pre_check', 'numeric_local_part', { email }, null);
    await incrementJobCounter(jobId, 'manual_review');
    results.manual_review++;
    console.log(`[record ${recordId}] → manual_review: ${reason}`);
    return;
  }

  // ── Phase 1: Parse ────────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = await parseEmail(email);
    await logAudit(recordId, 'parse', 'success', parsed, null);

    // Persist Phase 1 fields
    await supabase
      .from('verification_queue')
      .update({
        first_name: parsed.first_name,
        last_name: parsed.last_name,
        root_domain: parsed.root_domain,
        company_name: parsed.legal_company_name,
        company_aliases: parsed.known_aliases,
      })
      .eq('id', recordId);
  } catch (err) {
    const reason = `Parse failed: ${err.message}`;
    await updateStatus(recordId, 'manual_review', reason);
    await logAudit(recordId, 'parse', 'error', { email }, err.message);
    await incrementJobCounter(jobId, 'manual_review');
    results.manual_review++;
    console.log(`[record ${recordId}] → manual_review: ${reason}`);
    return;
  }

  // ── Phase 2: Search Triangulation ─────────────────────────────────────────
  let candidates;
  try {
    candidates = await triangulateLinkedIn({ ...parsed, email });
    await logAudit(recordId, 'search', 'success', { count: candidates?.length ?? 0 }, null);

    if (candidates) {
      await supabase
        .from('verification_queue')
        .update({ candidate_urls: candidates })
        .eq('id', recordId);
    }
  } catch (err) {
    const reason = `Search failed: ${err.message}`;
    await updateStatus(recordId, 'manual_review', reason);
    await logAudit(recordId, 'search', 'error', {}, err.message);
    await incrementJobCounter(jobId, 'manual_review');
    results.manual_review++;
    console.log(`[record ${recordId}] → manual_review: ${reason}`);
    return;
  }

  if (!candidates || candidates.length === 0) {
    const reason = 'No LinkedIn URL candidates found';
    await updateStatus(recordId, 'manual_review', reason);
    await logAudit(recordId, 'search', 'no_results', { email }, null);
    await incrementJobCounter(jobId, 'manual_review');
    results.manual_review++;
    console.log(`[record ${recordId}] → manual_review: ${reason}`);
    return;
  }

  // ── Phase 3: QA Gate ───────────────────────────────────────────────────────
  // Walk candidates in score order until one is verified or all fail
  let verifiedUrl = null;
  let lastQaReason = '';
  let lastMeta = { meta_title: '', meta_description: '' };

  for (const candidate of candidates) {
    try {
      const qa = await runQaGate(candidate.url, parsed, candidate);
      await logAudit(recordId, 'qa', qa.is_verified ? 'verified' : 'rejected', {
        url: candidate.url,
        score: candidate.score,
        title: qa.meta_title,
        reason: qa.reason,
        source: candidate.source?.method,
      }, null);

      lastMeta = { meta_title: qa.meta_title, meta_description: qa.meta_description };
      lastQaReason = qa.reason;

      if (qa.is_verified) {
        verifiedUrl = candidate.url;
        break;
      }
    } catch (err) {
      await logAudit(recordId, 'qa', 'error', { url: candidate.url }, err.message);
      lastQaReason = `QA error: ${err.message}`;
      // Continue to next candidate
    }
  }

  // ── Settle ─────────────────────────────────────────────────────────────────
  if (verifiedUrl) {
    await supabase
      .from('verification_queue')
      .update({
        status: 'verified',
        linkedin_url: verifiedUrl,
        primary_url: verifiedUrl,
        is_verified: true,
        qa_reason: lastQaReason,
        meta_title: lastMeta.meta_title,
        meta_description: lastMeta.meta_description,
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', recordId);

    await incrementJobCounter(jobId, 'verified');
    results.verified++;
    console.log(`[record ${recordId}] → verified: ${verifiedUrl}`);
  } else {
    const reason = lastQaReason || 'No candidate passed QA gate';
    await supabase
      .from('verification_queue')
      .update({
        status: 'manual_review',
        is_verified: false,
        qa_reason: reason,
        meta_title: lastMeta.meta_title,
        meta_description: lastMeta.meta_description,
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', recordId);

    await incrementJobCounter(jobId, 'manual_review');
    results.manual_review++;
    console.log(`[record ${recordId}] → manual_review: ${reason}`);
  }
}

// api/verify-instant.js — Synchronous single-email verification (no queue)
// Processes a single email inline and returns the LinkedIn URL within 8 seconds.
// Bypasses the cron queue entirely for instant single-email lookups.

import { requireApiKey } from '../lib/auth.js';
import { isRoleBasedEmail, isNumericLocalPart } from '../lib/utils.js';
import { parseEmail } from './workers/phase1-parse.js';
import { triangulateLinkedIn } from './workers/phase2-search.js';
import { runQaGate } from './workers/phase3-qa.js';
import { companyMatchStrength } from '../lib/utils.js';

const INSTANT_TIMEOUT_MS = 8000; // 8-second hard cap for single email

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = requireApiKey(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { email } = req.body ?? {};
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const emailLower = email.trim().toLowerCase();
  const startTime = Date.now();

  // Fast pre-checks
  if (isRoleBasedEmail(emailLower)) {
    return res.status(200).json({
      email: emailLower,
      status: 'manual_review',
      linkedin_url: null,
      reason: 'Role-based email — cannot resolve to individual',
      elapsed_ms: Date.now() - startTime,
    });
  }

  if (isNumericLocalPart(emailLower)) {
    return res.status(200).json({
      email: emailLower,
      status: 'manual_review',
      linkedin_url: null,
      reason: 'Numeric-only local part — no name extractable',
      elapsed_ms: Date.now() - startTime,
    });
  }

  try {
    // Phase 1: Parse email
    let parsed;
    try {
      parsed = await parseEmail(emailLower);
    } catch (err) {
      return res.status(200).json({
        email: emailLower,
        status: 'manual_review',
        linkedin_url: null,
        reason: `Could not parse email: ${err.message}`,
        elapsed_ms: Date.now() - startTime,
      });
    }

    // Phase 2: Search (with remaining time budget)
    const searchBudget = INSTANT_TIMEOUT_MS - (Date.now() - startTime) - 1000; // 1s for QA
    let candidates;
    try {
      candidates = await triangulateLinkedIn({ ...parsed, email: emailLower }, Math.max(3000, searchBudget));
    } catch (err) {
      return res.status(200).json({
        email: emailLower,
        status: 'manual_review',
        linkedin_url: null,
        reason: `Search failed: ${err.message}`,
        first_name: parsed.first_name,
        last_name: parsed.last_name,
        company: parsed.legal_company_name,
        elapsed_ms: Date.now() - startTime,
      });
    }

    if (!candidates || candidates.length === 0) {
      return res.status(200).json({
        email: emailLower,
        status: 'manual_review',
        linkedin_url: null,
        reason: 'No LinkedIn profile candidates found',
        first_name: parsed.first_name,
        last_name: parsed.last_name,
        company: parsed.legal_company_name,
        elapsed_ms: Date.now() - startTime,
      });
    }

    // Pre-QA re-ranking: boost by company match in snippet + slug match
    const emailSlug = emailLower.split('@')[0].replace(/[._]/g, '-');
    const firstNameLower = parsed.first_name.toLowerCase();

    for (const c of candidates) {
      const strength = companyMatchStrength(parsed.known_aliases, c.title || '', c.description || '');
      if (strength === 'title')            c.score += 2.5;
      else if (strength === 'description') c.score += 1.0;

      const urlSlug = (c.url.match(/\/in\/([\w-]+)\/?$/)?.[1] || '').toLowerCase();
      if (urlSlug === emailSlug)                    c.score += 1.5;
      else if (urlSlug.startsWith(firstNameLower))  c.score += 0.5;
    }
    candidates.sort((a, b) => b.score - a.score);

    // Phase 3: QA gate — try top 3 candidates max
    let verifiedUrl = null;
    let lastReason = 'No candidate passed verification';
    let metaTitle = '';

    for (const candidate of candidates.slice(0, 3)) {
      if (Date.now() - startTime > INSTANT_TIMEOUT_MS - 500) break; // Stop if almost out of time

      try {
        const qa = await runQaGate(candidate.url, parsed, candidate);
        metaTitle = qa.meta_title || '';
        lastReason = qa.reason;

        if (qa.is_verified) {
          verifiedUrl = candidate.url;
          break;
        }
      } catch (err) {
        lastReason = `QA error: ${err.message}`;
      }
    }

    const elapsed = Date.now() - startTime;

    if (verifiedUrl) {
      return res.status(200).json({
        email: emailLower,
        status: 'verified',
        linkedin_url: verifiedUrl,
        reason: lastReason,
        meta_title: metaTitle,
        first_name: parsed.first_name,
        last_name: parsed.last_name,
        company: parsed.legal_company_name,
        elapsed_ms: elapsed,
      });
    }

    return res.status(200).json({
      email: emailLower,
      status: 'manual_review',
      linkedin_url: null,
      reason: lastReason,
      meta_title: metaTitle,
      first_name: parsed.first_name,
      last_name: parsed.last_name,
      company: parsed.legal_company_name,
      elapsed_ms: elapsed,
    });

  } catch (err) {
    return res.status(200).json({
      email: emailLower,
      status: 'error',
      linkedin_url: null,
      reason: `Unexpected error: ${err.message}`,
      elapsed_ms: Date.now() - startTime,
    });
  }
}

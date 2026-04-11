// api/ingest.js — POST /api/ingest
// §10.1 — Accept emails, create job, upsert queue rows (MD5 idempotency)
// x-api-key auth required

import { supabase } from '../lib/supabase.js';
import { requireApiKey } from '../lib/auth.js';
import { md5 } from '../lib/utils.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = requireApiKey(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { emails, webhook_url } = req.body ?? {};
  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'emails must be a non-empty array' });
  }
  if (emails.length > 500) {
    return res.status(400).json({ error: 'Maximum 500 emails per request' });
  }

  // De-dupe and normalise
  const uniqueEmails = [...new Set(emails.map(e => String(e).trim().toLowerCase()))].filter(Boolean);

  // Create job row
  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .insert({
      total_rows: uniqueEmails.length,
      status: 'running',
      webhook_url: webhook_url ?? null,
    })
    .select()
    .single();

  if (jobErr) return res.status(500).json({ error: 'Failed to create job', details: jobErr.message });

  // Upsert queue rows (idempotency: skip if same email+job exists)
  const rows = uniqueEmails.map(email => ({
    job_id: job.id,
    email,
    idempotency_key: md5(email + job.id),
    status: 'pending',
    retry_count: 0,
  }));

  const { error: qErr } = await supabase
    .from('verification_queue')
    .upsert(rows, { onConflict: 'idempotency_key', ignoreDuplicates: true });

  if (qErr) return res.status(500).json({ error: 'Failed to queue emails', details: qErr.message });

  return res.status(202).json({
    job_id: job.id,
    queued: uniqueEmails.length,
    message: 'Processing started. Poll /api/status/' + job.id + ' for progress.',
  });
}

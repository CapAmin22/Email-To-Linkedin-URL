// lib/supabase.js — Supabase client + audit/status helpers
// §17 appendix helpers

import { createClient } from '@supabase/supabase-js';

// Lazy singleton — read env vars on first call so dotenv.config() always runs first
let _client = null;
function getClient() {
  if (!_client) {
    _client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return _client;
}

// Proxy so callers can write `supabase.from(...)` as before
export const supabase = new Proxy({}, {
  get(_target, prop) {
    return getClient()[prop];
  },
});

/**
 * Log an audit entry for a record.
 * @param {string} recordId - UUID of the verification_queue row
 * @param {string} phase    - 'parse' | 'search' | 'qa' | 'error'
 * @param {string} action   - 'success' | 'fail' | 'pass' | 'exception' | reason string
 * @param {any}    payload  - Serialisable data to store
 * @param {string} [error]  - Error message if applicable
 */
export async function logAudit(recordId, phase, action, payload, error = null) {
  try {
    await supabase.from('audit_logs').insert({
      record_id: recordId,
      phase,
      action,
      payload: payload ?? null,
      error: error ?? null,
    });
  } catch (e) {
    // Audit failures must never crash the worker
    console.error('[audit] failed to log:', e.message);
  }
}

/**
 * Update a record's status and unlock it.
 * @param {string} recordId
 * @param {string} status   - 'verified' | 'manual_review' | 'error' | 'pending'
 * @param {string} reason   - qa_reason value
 */
export async function updateStatus(recordId, status, reason) {
  await supabase.from('verification_queue').update({
    status,
    qa_reason: reason,
    locked_by: null,
    locked_at: null,
    processed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', recordId);
}

/**
 * Atomically increment job counters after a record settles.
 * @param {string} jobId
 * @param {'verified'|'manual_review'|'error'} outcome
 */
export async function incrementJobCounter(jobId, outcome) {
  const col = outcome === 'verified'
    ? 'verified'
    : outcome === 'manual_review'
      ? 'manual_review'
      : 'errors';

  await supabase.rpc('increment_job_counter', { job_id: jobId, col_name: col });
}

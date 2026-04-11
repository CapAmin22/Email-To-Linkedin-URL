// api/retry/[recordId].js — POST /api/retry/:recordId
// Reset a single record to pending for re-processing

import { supabase } from '../../lib/supabase.js';
import { requireApiKey } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = requireApiKey(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { recordId } = req.query;

  const { data, error } = await supabase
    .from('verification_queue')
    .update({
      status: 'pending',
      locked_by: null,
      locked_at: null,
      qa_reason: null,
      processed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', recordId)
    .select('id, email, status, retry_count')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Record not found' });

  return res.status(200).json({
    record_id: data.id,
    email: data.email,
    status: data.status,
    retry_count: data.retry_count,
    message: 'Record reset to pending',
  });
}

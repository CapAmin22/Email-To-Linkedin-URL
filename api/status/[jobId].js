// api/status/[jobId].js — GET /api/status/:jobId
// Returns job progress and per-status counts

import { supabase } from '../../lib/supabase.js';
import { requireApiKey } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = requireApiKey(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { jobId } = req.query;

  const { data: job, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Job not found' });

  return res.status(200).json({
    job_id: job.id,
    status: job.status,
    total: job.total_rows,
    completed: job.completed,
    verified: job.verified,
    manual_review: job.manual_review,
    errors: job.errors,
    created_at: job.created_at,
    completed_at: job.completed_at ?? null,
  });
}

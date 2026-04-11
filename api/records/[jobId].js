// api/records/[jobId].js — GET /api/records/:jobId
// JSON list of records for the dashboard table (with pagination)

import { supabase } from '../../lib/supabase.js';
import { requireApiKey } from '../../lib/auth.js';

const PAGE_SIZE = 50;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = requireApiKey(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { jobId } = req.query;
  const page = Math.max(0, parseInt(req.query.page ?? '0', 10));
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const { data: records, error, count } = await supabase
    .from('verification_queue')
    .select(
      'id, email, status, linkedin_url, first_name, last_name, company_name, qa_reason, meta_title, processed_at',
      { count: 'exact' }
    )
    .eq('job_id', jobId)
    .order('created_at', { ascending: true })
    .range(from, to);

  if (error) return res.status(500).json({ error: 'Failed to fetch records', details: error.message });

  return res.status(200).json({
    records: records ?? [],
    total: count ?? 0,
    page,
    page_size: PAGE_SIZE,
    has_more: (from + PAGE_SIZE) < (count ?? 0),
  });
}

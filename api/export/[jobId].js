// api/export/[jobId].js — GET /api/export/:jobId
// §8.3 — Stream all records for the job as CSV

import { supabase } from '../../lib/supabase.js';
import { requireApiKey } from '../../lib/auth.js';

const CSV_HEADERS = [
  'id', 'email', 'status', 'linkedin_url',
  'first_name', 'last_name', 'company_name',
  'qa_reason', 'meta_title', 'processed_at',
];

function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = requireApiKey(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { jobId } = req.query;

  const { data: records, error } = await supabase
    .from('verification_queue')
    .select(CSV_HEADERS.join(', '))
    .eq('job_id', jobId)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: 'Failed to fetch records', details: error.message });
  if (!records || records.length === 0) return res.status(404).json({ error: 'No records found for this job' });

  const lines = [
    CSV_HEADERS.join(','),
    ...records.map(r => CSV_HEADERS.map(h => escapeCsv(r[h])).join(',')),
  ];

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="job-${jobId}.csv"`);
  return res.status(200).send(lines.join('\n'));
}

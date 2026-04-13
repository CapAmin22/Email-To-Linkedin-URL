// lib/jobs.js — Job lifecycle helpers
// §8.2 checkJobCompletion

import { supabase } from './supabase.js';

/**
 * Check if all records in a job have settled.
 * If so, mark the job as completed.
 * @param {string} jobId
 */
export async function checkJobCompletion(jobId) {
  // Count records still in-flight (pending OR processing)
  const { count, error } = await supabase
    .from('verification_queue')
    .select('*', { count: 'exact', head: true })
    .eq('job_id', jobId)
    .in('status', ['pending', 'processing']);

  // Never mark complete if the query failed or count is null (ambiguous)
  if (error || count === null) return;

  if (count === 0) {
    // Fetch the job to check for webhook
    const { data: job } = await supabase
      .from('jobs')
      .select('webhook_url')
      .eq('id', jobId)
      .single();

    // Update job status
    await supabase
      .from('jobs')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', jobId);

    // Trigger webhook if configured (guarded — triggerWebhook never throws)
    if (job?.webhook_url) {
      await triggerWebhook(job.webhook_url, jobId);
    }

    console.log(`[jobs] job ${jobId} completed`);
  }
}

/**
 * POST job completion notification to a webhook URL.
 * Silently swallows errors — webhook failure must never crash the worker.
 */
async function triggerWebhook(webhookUrl, jobId) {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, status: 'completed' }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn(`[jobs] webhook failed for job ${jobId}:`, e.message);
  }
}

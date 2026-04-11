-- Migration 004: Stale lock recovery function
-- §12.1 — Workers that crash leave records stuck in 'processing'.
-- Called at the top of process-batch on every cron invocation.

CREATE OR REPLACE FUNCTION reset_stale_locks()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Records stuck in 'processing' for >10 min with retries remaining → reset to pending
  UPDATE verification_queue
  SET status     = 'pending',
      locked_by  = NULL,
      locked_at  = NULL,
      retry_count = retry_count + 1
  WHERE status = 'processing'
    AND locked_at < NOW() - INTERVAL '10 minutes'
    AND retry_count < 3;

  -- Records that have failed 3+ times → manual review
  UPDATE verification_queue
  SET status    = 'manual_review',
      qa_reason = 'Max retries exceeded'
  WHERE status = 'processing'
    AND locked_at < NOW() - INTERVAL '10 minutes'
    AND retry_count >= 3;
END;
$$;

GRANT EXECUTE ON FUNCTION reset_stale_locks() TO service_role;

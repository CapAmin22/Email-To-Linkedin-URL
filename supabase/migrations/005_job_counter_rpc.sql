-- Migration 005: Atomic job counter increment
-- Used by the orchestrator to keep jobs.completed/verified/manual_review/errors in sync

CREATE OR REPLACE FUNCTION increment_job_counter(
  job_id   UUID,
  col_name TEXT  -- 'verified' | 'manual_review' | 'errors'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF col_name = 'verified' THEN
    UPDATE jobs SET completed = completed + 1, verified = verified + 1 WHERE id = job_id;
  ELSIF col_name = 'manual_review' THEN
    UPDATE jobs SET completed = completed + 1, manual_review = manual_review + 1 WHERE id = job_id;
  ELSIF col_name = 'errors' THEN
    UPDATE jobs SET completed = completed + 1, errors = errors + 1 WHERE id = job_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION increment_job_counter(UUID, TEXT) TO service_role;

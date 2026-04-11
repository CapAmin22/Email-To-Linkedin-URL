-- Migration 003: claim_batch RPC function
-- §9.1 — FOR UPDATE SKIP LOCKED pattern to prevent duplicate processing
--
-- SPEC-BUG FIX: The PDF declares LANGUAGE sql, but FOR UPDATE SKIP LOCKED
-- inside UPDATE...WHERE id IN (SELECT...) does NOT actually skip locked rows
-- in plain SQL context. Rewrote as LANGUAGE plpgsql SECURITY DEFINER with a
-- CTE so the lock is acquired at SELECT time, before the UPDATE.

CREATE OR REPLACE FUNCTION claim_batch(
  batch_size  INT,
  worker_id   TEXT
) RETURNS SETOF verification_queue
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT id
    FROM verification_queue
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE verification_queue v
    SET status    = 'processing',
        locked_by = worker_id,
        locked_at = NOW()
  FROM claimed
  WHERE v.id = claimed.id
  RETURNING v.*;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_batch(INT, TEXT) TO service_role;

-- Migration 002: Row-Level Security
-- §4.5 — Service role bypasses RLS; anon role is blocked

ALTER TABLE verification_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs               ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if re-running
DROP POLICY IF EXISTS service_all       ON verification_queue;
DROP POLICY IF EXISTS service_all_audit ON audit_logs;
DROP POLICY IF EXISTS service_all_jobs  ON jobs;

CREATE POLICY service_all ON verification_queue
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY service_all_audit ON audit_logs
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY service_all_jobs ON jobs
  FOR ALL USING (auth.role() = 'service_role');

-- Migration 001: Core tables and indexes
-- §4.1 verification_queue (with reconstructed metadata column block — PDF formatting was corrupt)
-- §4.2 audit_logs
-- §4.3 jobs
-- §4.4 indexes

CREATE TABLE IF NOT EXISTS verification_queue (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id            UUID NOT NULL,
  email             TEXT NOT NULL,
  idempotency_key   TEXT UNIQUE NOT NULL, -- MD5(email)

  -- Phase 1 outputs
  first_name        TEXT,
  last_name         TEXT,
  root_domain       TEXT,
  company_name      TEXT,
  company_aliases   TEXT[],               -- PostgreSQL array

  -- Phase 2 outputs
  candidate_urls    JSONB,                -- [{url, score, vectors}]
  primary_url       TEXT,

  -- Phase 3 outputs
  is_verified       BOOLEAN DEFAULT FALSE,
  qa_reason         TEXT,
  meta_title        TEXT,
  meta_description  TEXT,

  -- State machine
  status            TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','processing','verified','manual_review','error')),
  retry_count       INTEGER DEFAULT 0,
  locked_by         TEXT,
  locked_at         TIMESTAMPTZ,

  -- §4.1 reconstructed metadata column block (PDF formatting was corrupt near here)
  linkedin_url      TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  processed_at      TIMESTAMPTZ
);

-- §4.2 Audit Log Table
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  record_id   UUID REFERENCES verification_queue(id),
  phase       TEXT NOT NULL,  -- 'parse', 'search', 'qa', 'error'
  action      TEXT NOT NULL,
  payload     JSONB,
  error       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- §4.3 Jobs Table
CREATE TABLE IF NOT EXISTS jobs (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  total_rows     INTEGER NOT NULL,
  completed      INTEGER DEFAULT 0,
  verified       INTEGER DEFAULT 0,
  manual_review  INTEGER DEFAULT 0,
  errors         INTEGER DEFAULT 0,
  status         TEXT DEFAULT 'running'
    CHECK (status IN ('running','completed','failed')),
  webhook_url    TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

-- §4.4 Required Indexes
CREATE INDEX IF NOT EXISTS idx_queue_status ON verification_queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_job    ON verification_queue(job_id);
CREATE INDEX IF NOT EXISTS idx_queue_locked ON verification_queue(locked_by, locked_at);
CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_logs(record_id);

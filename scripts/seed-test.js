#!/usr/bin/env node
// scripts/seed-test.js — Seed 3 known test records into verification_queue
// Usage: node scripts/seed-test.js

import { config } from 'dotenv';
config();

import { createClient } from '@supabase/supabase-js';
import { md5 } from '../lib/utils.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TEST_EMAILS = [
  'elon.musk@tesla.com',
  'info@company.com',      // role-based → fast-fail
  'john.doe@example.com',  // unknown domain → likely manual_review
];

async function run() {
  // Create a test job
  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .insert({
      total_rows: TEST_EMAILS.length,
      completed: 0,
      verified: 0,
      manual_review: 0,
      errors: 0,
      status: 'running',
    })
    .select()
    .single();

  if (jobErr) {
    console.error('Failed to create job:', jobErr.message);
    process.exit(1);
  }

  console.log(`Created job: ${job.id}`);

  // Upsert records
  const rows = TEST_EMAILS.map(email => ({
    job_id: job.id,
    email,
    idempotency_key: md5(email + job.id),
    status: 'pending',
    retry_count: 0,
  }));

  const { data: inserted, error: recErr } = await supabase
    .from('verification_queue')
    .insert(rows)
    .select('id, email, status');

  if (recErr) {
    console.error('Failed to insert records:', recErr.message);
    process.exit(1);
  }

  console.log(`Inserted ${inserted.length} record(s):`);
  inserted.forEach(r => console.log(`  ${r.id} | ${r.email} | ${r.status}`));
  console.log(`\nJob ID: ${job.id}`);
  console.log('Run the worker: node scripts/invoke-worker.js');
}

run().catch(e => { console.error(e.message); process.exit(1); });

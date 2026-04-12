#!/usr/bin/env node
// scripts/test-batch-emails.js — Test batch of specific emails
// Usage: node scripts/test-batch-emails.js [base-url]

import { config } from 'dotenv';
config();

const BASE_URL = process.argv[2] || 'https://email-to-linkedin-url.vercel.app';
const API_KEY = process.env.API_SECRET;
const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes

if (!API_KEY) {
  console.error('ERROR: API_SECRET not set in .env');
  process.exit(1);
}

const TEST_EMAILS = [
  { email: 'sofia@smartsheet.com',              note: 'Single-name, company is Smartsheet' },
  { email: 'amrita.mutha@bubble.io',            note: 'Two-part name, company is Bubble' },
  { email: 'emily.casanova@appian.com',         note: 'Two-part name, left Appian for Collibra' },
  { email: 'cindy.cheng@appian.com',            note: 'Two-part name, works at Appian' },
];

async function apiFetch(path, options = {}) {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      ...(options.headers || {}),
    },
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  console.log(`\n=== Batch Email Test ===`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Emails:   ${TEST_EMAILS.length}\n`);

  // 1. Ingest
  const emails = TEST_EMAILS.map(t => t.email);
  console.log('Step 1: Ingesting emails...');
  const ingestRes = await apiFetch('/api/ingest', {
    method: 'POST',
    body: JSON.stringify({ emails }),
  });

  if (!ingestRes.ok) {
    const body = await ingestRes.text();
    console.error(`Ingest failed (${ingestRes.status}): ${body}`);
    process.exit(1);
  }

  const { job_id, queued } = await ingestRes.json();
  console.log(`  → job_id: ${job_id}, queued: ${queued}\n`);

  // 2. Drive worker until job completes
  console.log('Step 2: Driving worker until job completes...');
  const start = Date.now();
  let jobData;

  while (true) {
    // Manually trigger one batch
    const workerRes = await apiFetch('/api/workers/process-batch', { method: 'POST' });
    if (workerRes.ok) {
      const wb = await workerRes.json();
      console.log(`  → worker processed ${wb.processed} record(s)`);
    } else {
      console.warn(`  ⚠ Worker trigger returned ${workerRes.status}`);
    }

    await sleep(2000);

    const statusRes = await apiFetch(`/api/status/${job_id}`);
    if (!statusRes.ok) { console.warn('  ⚠ Status poll failed'); continue; }
    jobData = await statusRes.json();

    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r  ${elapsed}s — completed: ${jobData.completed}/${jobData.total} | verified: ${jobData.verified} | review: ${jobData.manual_review}   `);

    if (jobData.status === 'completed' || jobData.completed >= jobData.total) {
      console.log('\n  → Job completed!\n');
      break;
    }

    if (Date.now() - start > MAX_WAIT_MS) {
      console.error('\n\nTIMEOUT: Job did not complete in 5 minutes.');
      process.exit(1);
    }
  }

  // 3. Fetch records
  console.log('Step 3: Fetching results...');
  const recordsRes = await apiFetch(`/api/records/${job_id}?page=0`);
  if (!recordsRes.ok) { console.error('Records fetch failed'); process.exit(1); }
  const { records } = await recordsRes.json();

  // 4. Display results
  console.log('Step 4: Results\n');
  console.log('─────────────────────────────────────────');
  for (const test of TEST_EMAILS) {
    const record = records.find(r => r.email === test.email);
    if (!record) {
      console.log(`\n✗ MISSING  ${test.email}`);
      console.log(`  (${test.note})`);
      continue;
    }

    console.log(`\n${record.status === 'verified' ? '✓' : '·'} ${test.email}`);
    console.log(`  Status: ${record.status}`);
    console.log(`  Note: ${test.note}`);
    if (record.linkedin_url) {
      console.log(`  URL: ${record.linkedin_url}`);
    }
    if (record.qa_reason) {
      console.log(`  Reason: ${record.qa_reason}`);
    }
    if (record.meta_title) {
      console.log(`  Title: ${record.meta_title.substring(0, 80)}`);
    }
  }
  console.log('\n─────────────────────────────────────────\n');
}

run().catch(e => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});

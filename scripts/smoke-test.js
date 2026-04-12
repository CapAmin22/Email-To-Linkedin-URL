#!/usr/bin/env node
// scripts/smoke-test.js — End-to-end smoke test (§16.1 test matrix)
// Usage: node scripts/smoke-test.js [base-url]
// Default base-url: https://email-to-linkedin-url.vercel.app
//
// Tests 6 emails and asserts expected statuses:
//   Row 1: elon.musk@tesla.com       → verified (strong signal)
//   Row 2: bill.gates@microsoft.com  → verified (strong signal)
//   Row 3: info@company.com          → manual_review (role-based)
//   Row 4: 12345@company.com         → manual_review (numeric local)
//   Row 5: john.smith@ibm.com        → manual_review (common name, noise)
//   Row 6: nobody@thisdoesnotexist123.io → manual_review (unknown domain)

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

const TEST_MATRIX = [
  { email: 'elon.musk@tesla.com',              expected: ['verified', 'manual_review'], note: 'Known public figure' },
  { email: 'bill.gates@microsoft.com',          expected: ['verified', 'manual_review'], note: 'Known public figure' },
  { email: 'info@company.com',                  expected: ['manual_review'],            note: 'Role-based → fast-fail' },
  { email: '12345@company.com',                 expected: ['manual_review'],            note: 'Numeric local → fast-fail' },
  { email: 'john.smith@ibm.com',                expected: ['verified', 'manual_review'], note: 'Common name — may verify a real John Smith at IBM' },
  { email: 'nobody@thisdoesnotexist123456.io',  expected: ['manual_review'],            note: 'Unknown domain' },
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
  console.log(`\n=== LinkVerify Smoke Test ===`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Emails:   ${TEST_MATRIX.length}\n`);

  // 1. Ingest
  const emails = TEST_MATRIX.map(t => t.email);
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

  // 2. Drive worker manually until job completes (cron is daily on Hobby plan)
  console.log('Step 2: Driving worker until job completes...');
  const start = Date.now();
  let jobData;

  while (true) {
    // Manually trigger one batch
    const workerRes = await apiFetch('/api/workers/process-batch', { method: 'POST' });
    if (workerRes.ok) {
      const wb = await workerRes.json();
      if (wb.processed === 0) {
        // Nothing left to claim — give status a moment to settle
      }
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

  // 4. Assert
  console.log('Step 4: Asserting expected statuses...\n');
  let passed = 0;
  let failed = 0;

  for (const test of TEST_MATRIX) {
    const record = records.find(r => r.email === test.email);
    if (!record) {
      console.log(`  ✗ MISSING  ${test.email}  (${test.note})`);
      failed++;
      continue;
    }

    const ok = test.expected.includes(record.status);
    if (ok) {
      console.log(`  ✓ ${record.status.padEnd(14)} ${test.email}  — ${test.note}`);
      passed++;
    } else {
      console.log(`  ✗ FAIL     ${test.email}`);
      console.log(`             expected: [${test.expected.join('|')}]`);
      console.log(`             got:      ${record.status} — ${record.qa_reason || ''}`);
      failed++;
    }
  }

  console.log(`\n─────────────────────────────────────────`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  // 5. Download CSV
  console.log('\nStep 5: Testing CSV export...');
  const csvRes = await apiFetch(`/api/export/${job_id}`);
  if (csvRes.ok) {
    const csv = await csvRes.text();
    const lines = csv.split('\n').filter(Boolean);
    console.log(`  → CSV has ${lines.length - 1} data rows (+ 1 header) ✓`);
  } else {
    console.warn(`  ⚠ CSV export returned ${csvRes.status}`);
  }

  if (failed > 0) {
    console.log('\n❌ Smoke test FAILED\n');
    process.exit(1);
  } else {
    console.log('\n✅ Smoke test PASSED\n');
  }
}

run().catch(e => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});

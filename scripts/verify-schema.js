#!/usr/bin/env node
/**
 * Post-migration schema verification.
 * Checks that all expected tables, indexes, and functions exist.
 */

import pg from 'pg';
import { config } from 'dotenv';
config();

const { Client } = pg;

async function verify() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const errors = [];

  try {
    await client.connect();

    // Check tables
    const expectedTables = ['verification_queue', 'audit_logs', 'jobs', '_migrations'];
    const { rows: tables } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const tableSet = new Set(tables.map(r => r.table_name));
    for (const t of expectedTables) {
      if (tableSet.has(t)) {
        console.log(`  ✓ table: ${t}`);
      } else {
        console.error(`  ✗ table MISSING: ${t}`);
        errors.push(`missing table: ${t}`);
      }
    }

    // Check indexes
    const expectedIndexes = ['idx_queue_status', 'idx_queue_job', 'idx_queue_locked', 'idx_audit_record'];
    const { rows: indexes } = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
    );
    const indexSet = new Set(indexes.map(r => r.indexname));
    for (const i of expectedIndexes) {
      if (indexSet.has(i)) {
        console.log(`  ✓ index: ${i}`);
      } else {
        console.error(`  ✗ index MISSING: ${i}`);
        errors.push(`missing index: ${i}`);
      }
    }

    // Check functions
    const expectedFunctions = ['claim_batch', 'reset_stale_locks'];
    const { rows: funcs } = await client.query(
      `SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace`
    );
    const funcSet = new Set(funcs.map(r => r.proname));
    for (const f of expectedFunctions) {
      if (funcSet.has(f)) {
        console.log(`  ✓ function: ${f}`);
      } else {
        console.error(`  ✗ function MISSING: ${f}`);
        errors.push(`missing function: ${f}`);
      }
    }

    if (errors.length === 0) {
      console.log('\nSchema verification PASSED ✓');
    } else {
      console.error(`\nSchema verification FAILED — ${errors.length} issue(s)`);
      process.exit(1);
    }
  } finally {
    await client.end();
  }
}

verify().catch(err => {
  console.error('Verification error:', err.message);
  process.exit(1);
});

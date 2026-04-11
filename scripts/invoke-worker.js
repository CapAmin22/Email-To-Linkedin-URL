#!/usr/bin/env node
// scripts/invoke-worker.js — Locally invoke the process-batch handler
// Simulates the Vercel cron call without needing vercel dev
// Usage: node scripts/invoke-worker.js

import { config } from 'dotenv';
config();

import handler from '../api/workers/process-batch.js';

// Minimal req/res mock
const req = {
  headers: { 'x-api-key': process.env.API_SECRET },
  method: 'GET',
};

let responseBody = null;
let statusCode = 200;

const res = {
  status(code) { statusCode = code; return this; },
  json(body) {
    responseBody = body;
    console.log(`\n[worker] Response ${statusCode}:`, JSON.stringify(body, null, 2));
    return this;
  },
};

console.log('[worker] Invoking process-batch handler...\n');

try {
  await handler(req, res);
} catch (err) {
  console.error('[worker] Handler threw:', err.message);
  process.exit(1);
}

process.exit(statusCode >= 400 ? 1 : 0);

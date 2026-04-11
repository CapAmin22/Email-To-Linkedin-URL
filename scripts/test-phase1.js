#!/usr/bin/env node
// scripts/test-phase1.js — CLI test runner for the email parser
// Usage: node scripts/test-phase1.js john.doe@tesla.com

import { config } from 'dotenv';
config();

import { parseEmail } from '../api/workers/phase1-parse.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/test-phase1.js <email>');
  process.exit(1);
}

console.log(`\nParsing: ${email}\n`);

try {
  const result = await parseEmail(email);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}

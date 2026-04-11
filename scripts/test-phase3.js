#!/usr/bin/env node
// scripts/test-phase3.js — CLI test runner for the ScraperAPI + LLM QA gate
// Usage: node scripts/test-phase3.js <linkedin-url> <first> <last> <company1> [company2 ...]
// Example: node scripts/test-phase3.js https://www.linkedin.com/in/elonmusk/ Elon Musk "Tesla, Inc." SpaceX

import { config } from 'dotenv';
config();

import { runQaGate } from '../api/workers/phase3-qa.js';

const [profileUrl, first_name, last_name, ...aliases] = process.argv.slice(2);

if (!profileUrl || !first_name || !last_name || aliases.length === 0) {
  console.error('Usage: node scripts/test-phase3.js <linkedin-url> <first> <last> <company1> [company2 ...]');
  process.exit(1);
}

const parsed = {
  first_name,
  last_name,
  known_aliases: aliases,
};

console.log(`\nQA Gate test:`);
console.log(`  URL:     ${profileUrl}`);
console.log(`  Target:  ${first_name} ${last_name}`);
console.log(`  Aliases: ${aliases.join(', ')}\n`);

try {
  const result = await runQaGate(profileUrl, parsed);
  console.log('Result:', JSON.stringify(result, null, 2));

  if (result.is_verified) {
    console.log('\n✓ VERIFIED — profile matches identity and company');
  } else {
    console.log(`\n✗ NOT VERIFIED — ${result.reason}`);
  }
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}

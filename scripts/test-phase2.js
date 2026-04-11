#!/usr/bin/env node
// scripts/test-phase2.js — CLI test runner for DDG search triangulation
// Usage: node scripts/test-phase2.js <first> <last> <domain> <company> <email>
// Example: node scripts/test-phase2.js Elon Musk tesla.com "Tesla, Inc." elon.musk@tesla.com
//
// NOTE: DuckDuckGo applies rate-limiting / anomaly-detection to repeated requests from
// the same IP (common in dev). If all 3 vectors fail with "anomaly" errors, this is
// expected dev-environment behaviour. In production (Vercel), distinct invocation IPs
// avoid this block. The worker handles all-fail gracefully: returns null → manual_review.

import { config } from 'dotenv';
config();

import { triangulateLinkedIn } from '../api/workers/phase2-search.js';

const [first_name, last_name, root_domain, legal_company_name, email] = process.argv.slice(2);

if (!first_name || !last_name || !root_domain || !legal_company_name || !email) {
  console.error('Usage: node scripts/test-phase2.js <first> <last> <domain> <company> <email>');
  console.error('Example: node scripts/test-phase2.js Elon Musk tesla.com "Tesla, Inc." elon.musk@tesla.com');
  process.exit(1);
}

console.log(`\nTriangulating LinkedIn for: ${first_name} ${last_name} <${email}>\n`);
console.log(`  domain: ${root_domain}`);
console.log(`  company: ${legal_company_name}\n`);

try {
  const results = await triangulateLinkedIn({ first_name, last_name, root_domain, legal_company_name, email });

  if (!results) {
    console.log('Result: null — no LinkedIn URLs found across all 3 vectors.');
  } else {
    console.log(`Found ${results.length} candidate(s):\n`);
    results.forEach((r, i) => {
      console.log(`  [${i + 1}] score=${r.score}  vectors=[${r.vectors.join(',')}]`);
      console.log(`      ${r.url}`);
    });
    console.log(`\nTop candidate: ${results[0].url} (score=${results[0].score})`);
  }
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}

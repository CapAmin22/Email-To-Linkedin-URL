// lib/utils.js — Shared utilities
// Sources: §6.2 normalizeLinkedInUrl · §7.2 preQaChecks · §8.1 randomJitter · §17 isRoleBasedEmail

import { createHash } from 'crypto';

/** Sleep for ms milliseconds */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Return a random jitter delay in ms (default 3–8 seconds per §8.1) */
export function randomJitter(minMs = 3000, maxMs = 8000) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Normalize a URL to a canonical linkedin.com/in/<slug>/ form.
 * Returns null if it is not a valid LinkedIn profile URL.
 * §6.2
 */
export function normalizeLinkedInUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('linkedin.com')) return null;
    const match = u.pathname.match(/^\/in\/([^/?#]+)/);
    if (!match) return null;
    return `https://www.linkedin.com/in/${match[1]}/`;
  } catch {
    return null;
  }
}

/** Role-based email prefixes that cannot be resolved to a specific person. §17 */
const ROLE_PREFIXES = new Set([
  'info', 'sales', 'support', 'admin', 'contact',
  'hello', 'help', 'team', 'office', 'marketing',
  'billing', 'accounts', 'hr', 'careers', 'press',
  'media', 'legal', 'compliance', 'noreply', 'no-reply',
]);

/** Returns true if the email is a role-based alias (not a person). §17 */
export function isRoleBasedEmail(email) {
  const local = email.split('@')[0].toLowerCase().trim();
  return ROLE_PREFIXES.has(local);
}

/** Returns true if the local part is entirely numeric (e.g. 12345@company.com). §5.4 */
export function isNumericLocalPart(email) {
  const local = email.split('@')[0];
  return /^\d+$/.test(local);
}

/**
 * Check where (title vs description) a company alias first appears.
 * Returns: 'title' | 'description' | 'none'
 * 'title' is stronger — means the current role/company is in the page title.
 * 'description' is weaker — may be a previous employer or related mention.
 * @param {string[]} aliases
 * @param {string} title
 * @param {string} description
 * @returns {'title'|'description'|'none'}
 */
export function companyMatchStrength(aliases, title, description) {
  if (!aliases?.length) return 'none';
  const titleLower = (title || '').toLowerCase();
  const descLower = (description || '').toLowerCase();
  for (const alias of aliases) {
    if (!alias) continue;
    const a = alias.toLowerCase();
    if (titleLower.includes(a)) return 'title';
  }
  for (const alias of aliases) {
    if (!alias) continue;
    const a = alias.toLowerCase();
    if (descLower.includes(a)) return 'description';
  }
  return 'none';
}

/**
 * Pre-LLM fast-fail checks on the HTML <title> tag.
 * Saves an API call when the profile is private or generic. §7.2
 */
export function preQaChecks(title) {
  if (!title || !title.trim()) {
    return { pass: false, reason: 'Empty title — profile not accessible' };
  }
  if (/^LinkedIn Member$/i.test(title.trim())) {
    return { pass: false, reason: 'Private profile - title is LinkedIn Member' };
  }
  if (/^LinkedIn$/i.test(title.trim())) {
    return { pass: false, reason: 'Generic LinkedIn page - no profile data' };
  }
  return { pass: true };
}

/** MD5 hex digest of a string (used for idempotency keys). */
export function md5(str) {
  return createHash('md5').update(str).digest('hex');
}

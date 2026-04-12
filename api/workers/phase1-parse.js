// api/workers/phase1-parse.js — Phase 1: Intelligent Parsing & Entity Resolution
// §5.2 / §5.3 — LLM extracts first_name, last_name, root_domain, legal_company_name, known_aliases

import { callLLM } from '../../lib/llm.js';
import { PARSE_SYSTEM_PROMPT } from '../../lib/prompts.js';

/**
 * Parse a professional email address into structured identity data.
 * @param {string} email - e.g. "john.doe@company.com"
 * @returns {Promise<{
 *   first_name: string,
 *   last_name: string,
 *   root_domain: string,
 *   legal_company_name: string,
 *   known_aliases: string[]
 * }>}
 */
export async function parseEmail(email) {
  const userPrompt = `Parse this email: ${email}`;

  const parsed = await callLLM(PARSE_SYSTEM_PROMPT, userPrompt);

  // Hard-required: first_name + a resolvable company. last_name may be empty
  // for single-token local parts like `amin@passionbits.io`.
  if (!parsed.first_name || typeof parsed.first_name !== 'string' || !parsed.first_name.trim()) {
    // Fallback: use the local part itself as the first name
    const local = email.split('@')[0]?.split(/[._-]/)[0] || '';
    if (!local) throw new Error('Unable to derive first_name from email');
    parsed.first_name = local;
  }
  if (!parsed.legal_company_name || typeof parsed.legal_company_name !== 'string' || !parsed.legal_company_name.trim()) {
    // Fallback: use the title-cased domain prefix
    const dom = email.split('@')[1]?.split('.')[0] || '';
    if (!dom) throw new Error('Unable to derive legal_company_name from email');
    parsed.legal_company_name = dom.charAt(0).toUpperCase() + dom.slice(1).toLowerCase();
  }
  if (typeof parsed.last_name !== 'string') parsed.last_name = '';

  // Ensure known_aliases is an array — and include the bare domain root
  if (!Array.isArray(parsed.known_aliases)) {
    parsed.known_aliases = [];
  }
  const domainRoot = email.split('@')[1]?.split('.')[0] || '';
  const domainTitle = domainRoot ? domainRoot.charAt(0).toUpperCase() + domainRoot.slice(1).toLowerCase() : '';

  // Build company_aliases: legal name + LLM aliases + domain forms
  const allAliases = Array.from(new Set([
    parsed.legal_company_name,
    ...parsed.known_aliases,
    domainTitle,
    domainRoot,
  ].filter(Boolean)));

  // Reconstruct root_domain from the email itself if LLM dropped the TLD
  const emailDomain = email.split('@')[1]?.toLowerCase() || '';
  let rootDomain = (parsed.root_domain || '').trim().toLowerCase();
  if (rootDomain && !rootDomain.includes('.') && emailDomain.includes('.')) {
    rootDomain = emailDomain;
  } else if (!rootDomain) {
    rootDomain = emailDomain;
  }

  // Title-case first/last name (LLMs sometimes return all-lowercase)
  const toTitleCase = (s) => {
    if (!s || !s.trim()) return '';
    return s.trim().split(/[\s-]/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(s.includes('-') ? '-' : ' ');
  };

  return {
    first_name: toTitleCase(parsed.first_name),
    last_name: toTitleCase(parsed.last_name),
    root_domain: rootDomain,
    legal_company_name: parsed.legal_company_name.trim(),
    known_aliases: allAliases,
  };
}

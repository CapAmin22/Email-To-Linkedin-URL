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

  // Validate required fields per §5.3
  const required = ['first_name', 'last_name', 'root_domain', 'legal_company_name'];
  for (const field of required) {
    if (!parsed[field] || typeof parsed[field] !== 'string' || !parsed[field].trim()) {
      throw new Error(`Missing or empty field: ${field}`);
    }
  }

  // Ensure known_aliases is an array
  if (!Array.isArray(parsed.known_aliases)) {
    parsed.known_aliases = [];
  }

  // Build company_aliases: include legal_company_name + all aliases for robust matching
  const allAliases = Array.from(new Set([
    parsed.legal_company_name,
    ...parsed.known_aliases,
  ]));

  // Reconstruct root_domain from the email itself if LLM dropped the TLD
  const emailDomain = email.split('@')[1]?.toLowerCase() || '';
  let rootDomain = parsed.root_domain.trim().toLowerCase();
  if (rootDomain && !rootDomain.includes('.') && emailDomain.includes('.')) {
    rootDomain = emailDomain;
  } else if (!rootDomain) {
    rootDomain = emailDomain;
  }

  // Title-case first/last name (LLMs sometimes return all-lowercase)
  const toTitleCase = (s) => s.trim().split(/[\s-]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(s.includes('-') ? '-' : ' ');

  return {
    first_name: toTitleCase(parsed.first_name),
    last_name: toTitleCase(parsed.last_name),
    root_domain: rootDomain,
    legal_company_name: parsed.legal_company_name.trim(),
    known_aliases: allAliases,
  };
}

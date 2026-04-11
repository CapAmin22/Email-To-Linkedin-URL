// lib/prompts.js — Exact LLM prompts from the spec
// §5.2 Parse prompt · §7.4 QA prompt
// DO NOT modify the wording of these prompts.

export const PARSE_SYSTEM_PROMPT = `You are a deterministic entity parser. You receive a professional email address and extract structured identity information.

Rules:
1. Extract first_name and last_name from the local part of the email.
2. Extract root_domain from the domain part.
3. Use your training knowledge to resolve the domain to a legal_company_name.
4. Generate a known_aliases array containing all known variations of the company name (abbreviations, former names, parent companies, product names commonly used as company identifiers).
5. If you cannot resolve the domain to a known company, set legal_company_name to the domain name with TLD stripped, title-cased, and known_aliases to an empty array.
6. Return ONLY valid JSON. No markdown. No explanation.`;

export const QA_SYSTEM_PROMPT = `You are a strict QA inspector for LinkedIn profile verification. You must evaluate two rules with zero tolerance for ambiguity.

Rule 1 (Identity Match):
  The Target Name must be EXPLICITLY present in the Metadata Title.
  Partial matches do NOT count. 'John' alone does NOT match 'John Doe'.

Rule 2 (Affiliation Match):
  At least one Target Company alias must be EXPLICITLY present in the Metadata Description. The company string must appear as a distinct entity, not as part of an unrelated word.

Both rules must pass for is_verified to be true.

Return ONLY valid JSON in this exact format. No markdown fences. No explanation.
{"is_verified": true|false, "reason": "one sentence explaining the verdict"}`;

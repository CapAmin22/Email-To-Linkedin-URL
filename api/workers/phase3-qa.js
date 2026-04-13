// api/workers/phase3-qa.js — Phase 3: ScraperAPI Fetch + LLM Bipartite QA Gate
// §7.3 / §7.4 — fetch LinkedIn HTML, extract meta, strict identity+affiliation check

import { callLLM } from '../../lib/llm.js';
import { QA_SYSTEM_PROMPT } from '../../lib/prompts.js';
import { preQaChecks, companyMatchStrength } from '../../lib/utils.js';

const FETCH_TIMEOUT_MS = 15_000;

// User-Agent pool for the direct-fetch fallback. Googlebot is first because
// LinkedIn serves rich OG-tagged HTML to known crawlers without auth-walling.
const USER_AGENTS = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.69 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

/**
 * Extract <title> and meta[name=description] from raw HTML.
 * @param {string} html
 * @returns {{ title: string, description: string }}
 */
function extractMeta(html) {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)
    || html.match(/<meta[^>]+content=["']([^"']*)[^>]+name=["']description["']/i);

  return {
    title: titleMatch ? titleMatch[1].trim() : '',
    description: descMatch ? descMatch[1].trim() : '',
  };
}

/**
 * Fetch LinkedIn profile HTML via ScraperAPI proxy (§7.3).
 * @param {string} profileUrl
 * @returns {Promise<{ title: string, description: string }>}
 */
export async function fetchLinkedInMeta(profileUrl) {
  const apiKey = process.env.SCRAPER_API_KEY;
  if (!apiKey) {
    console.warn('[qa] SCRAPER_API_KEY not set, falling back to direct fetch');
    return fetchLinkedInMetaFallback(profileUrl);
  }

  // ScraperAPI params tuned for LinkedIn anti-bot:
  // - render=true → headless browser (executes JS)
  // - country_code=us → US residential exit IP (LinkedIn shows full meta to US)
  // - keep_headers=true → forwards our Accept-Language for proper title
  // - device_type=desktop → desktop user agent (mobile pages omit meta)
  const params = new URLSearchParams({
    api_key: apiKey,
    url: profileUrl,
    render: 'true',
    country_code: 'us',
    device_type: 'desktop',
  });
  const scraperUrl = `http://api.scraperapi.com/?${params.toString()}`;

  try {
    const res = await fetch(scraperUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    // Treat quota / server errors as a soft failure → fallback
    if (res.status === 429 || res.status >= 500) {
      console.warn(`[qa] ScraperAPI returned ${res.status}, falling back to direct fetch`);
      return fetchLinkedInMetaFallback(profileUrl);
    }

    const html = await res.text();
    const meta = extractMeta(html);

    // If ScraperAPI returned a page with no usable title, try the direct
    // fetch fallback once before giving up — LinkedIn often serves the raw
    // OG-tagged HTML to non-headless requests with a Googlebot-style UA.
    if (!meta.title || !meta.title.trim()) {
      console.warn('[qa] ScraperAPI returned empty title, trying direct fetch');
      const fallbackMeta = await fetchLinkedInMetaFallback(profileUrl);
      if (fallbackMeta.title && fallbackMeta.title.trim()) {
        return fallbackMeta;
      }
    }
    return meta;
  } catch (err) {
    console.warn('[qa] ScraperAPI fetch failed:', err.message, '— falling back');
    return fetchLinkedInMetaFallback(profileUrl);
  }
}

/**
 * Direct LinkedIn fetch with a rotating User-Agent (§12 Proxy Exhaustion fallback).
 * @param {string} profileUrl
 * @returns {Promise<{ title: string, description: string }>}
 */
export async function fetchLinkedInMetaFallback(profileUrl) {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

  const res = await fetch(profileUrl, {
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const html = await res.text();
  return extractMeta(html);
}

/**
 * Check if name matches perfectly in the title (both first and last).
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} title
 * @returns {boolean}
 */
function isPerfectNameMatch(firstName, lastName, title) {
  if (!firstName || !title) return false;
  const titleLower = title.toLowerCase();
  const firstLower = firstName.toLowerCase();
  const lastLower = lastName ? lastName.toLowerCase() : '';

  // Both first and last name must be present
  if (lastName) {
    return titleLower.includes(firstLower) && titleLower.includes(lastLower);
  }
  // Single name must be exact word match (not substring)
  return /\b\w*/.test(firstName) && titleLower.includes(firstLower);
}

/**
 * Check if any of the target company aliases are mentioned in the description.
 * Useful for catching job changes: person still at correct company mentioned in description.
 * @param {string[]} aliases
 * @param {string} text
 * @returns {boolean}
 */
function hasAnyCompanyMention(aliases, text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return aliases.some(alias => lower.includes(alias.toLowerCase()));
}

/**
 * Run the strict bipartite LLM QA gate (§7.4).
 * Both identity (Rule 1) and affiliation (Rule 2) must match.
 * Special case: if name is perfect match, allow verification even if company changed.
 *
 * @param {{
 *   first_name: string,
 *   last_name: string,
 *   known_aliases: string[]
 * }} parsed
 * @param {{ title: string, description: string }} meta
 * @returns {Promise<{ is_verified: boolean, reason: string }>}
 */
export async function llmQaValidation(parsed, meta) {
  const { first_name, last_name, known_aliases } = parsed;
  const targetName = [first_name, last_name].filter(Boolean).join(' ');

  const userPrompt = [
    `Target Name: ${targetName}`,
    last_name ? '' : `Note: Only first name is known (no last name available). Match first name + company affiliation.`,
    `Target Company Aliases: ${known_aliases.join(', ')}`,
    `Metadata Title: ${meta.title}`,
    `Metadata Description: ${meta.description}`,
  ].filter(Boolean).join('\n');

  const result = await callLLM(QA_SYSTEM_PROMPT, userPrompt);

  // Normalise the response — LLMs sometimes return string "true"/"false"
  let isVerified = result.is_verified === true || result.is_verified === 'true';
  let reason = typeof result.reason === 'string' ? result.reason.trim() : String(result.reason ?? '');

  // ── Programmatic safety net ──────────────────────────────────────────────
  // LLMs sometimes hallucinate and ignore Rule 2 (company match).
  // Use companyMatchStrength to distinguish title vs description match.
  const strength = companyMatchStrength(known_aliases, meta.title, meta.description);
  const companyFoundInMeta = strength !== 'none';

  if (isVerified && !companyFoundInMeta) {
    console.log('[qa] Safety net: LLM said verified but no company alias found in metadata. Overriding to false.');
    isVerified = false;
    reason = `Name may match but no Target Company alias found in title or description. LLM overridden by safety net.`;
  }

  // Annotate when company is only in description (weaker signal — may be past employer)
  if (isVerified && strength === 'description') {
    reason = `${reason} (Note: company found in description only — current role may differ)`;
    console.log('[qa] Company found in description only — weaker match');
  }

  // ── Job-change recovery ──────────────────────────────────────────────────
  // If LLM says no, but we have PERFECT name match (first+last) AND company
  // IS mentioned somewhere in the metadata, it may be a job change.
  if (!isVerified && last_name && isPerfectNameMatch(first_name, last_name, meta.title)) {
    if (companyFoundInMeta) {
      const loc = strength === 'title' ? 'title' : 'description';
      isVerified = true;
      reason = `Perfect name match (${targetName}) with company reference found in ${loc}; may have changed roles or title.`;
    }
  }

  // ── Single-name recovery ────────────────────────────────────────────────
  // For single-name emails (e.g. amin@passionbits.io), the LLM often rejects
  // because title says "Amin Shaikh" which "implies a full name" not just "Amin".
  // But if first name IS in the title AND company IS confirmed, that's a match.
  if (!isVerified && !last_name && first_name) {
    const titleLower = (meta.title || '').toLowerCase();
    const hasFirstName = titleLower.includes(first_name.toLowerCase());
    if (hasFirstName && companyFoundInMeta) {
      const loc = strength === 'title' ? 'title' : 'description';
      isVerified = true;
      reason = `First name "${first_name}" found in title with company confirmed in ${loc}. Single-name email — full name on profile is expected.`;
      console.log(`[qa] Single-name recovery: "${first_name}" + company match → verified`);
    }
  }

  return { is_verified: isVerified, reason, companyMatchStrength: strength };
}

/**
 * Full Phase 3 pipeline: fetch meta → pre-QA checks → LLM gate.
 *
 * @param {string} profileUrl
 * @param {{
 *   first_name: string,
 *   last_name: string,
 *   known_aliases: string[]
 * }} parsed
 * @returns {Promise<{
 *   pass: boolean,
 *   is_verified: boolean,
 *   reason: string,
 *   meta_title: string,
 *   meta_description: string
 * }>}
 */
export async function runQaGate(profileUrl, parsed, candidate = {}) {
  // Metadata resolution priority:
  // 1. Serper/DDG snippet title — rich and directly from Google results
  // 2. Web mention synthetic metadata — from external sources (RocketReach etc.)
  // 3. ScraperAPI fetch / direct fetch — last resort (often blocked or exhausted)
  let meta;
  const source = candidate.source?.method || 'unknown';

  if (candidate.title && candidate.title.trim()) {
    const label = source === 'web_confirmed' ? 'web mention' : 'search snippet';
    console.log(`[qa] Using ${label} metadata (title: ${candidate.title.slice(0, 60)})`);
    meta = { title: candidate.title, description: candidate.description || '' };
  } else {
    // Pattern-only candidate or no search snippet — try the (likely-blocked) fetch.
    meta = await fetchLinkedInMeta(profileUrl);
  }

  // Pre-QA structural checks (§7.2) — fast-fail before spending an LLM call
  const preCheck = preQaChecks(meta.title);
  if (!preCheck.pass) {
    return {
      pass: false,
      is_verified: false,
      reason: preCheck.reason,
      meta_title: meta.title,
      meta_description: meta.description,
    };
  }

  const { is_verified, reason } = await llmQaValidation(parsed, meta);

  return {
    pass: is_verified,
    is_verified,
    reason,
    meta_title: meta.title,
    meta_description: meta.description,
  };
}

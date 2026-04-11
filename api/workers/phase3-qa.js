// api/workers/phase3-qa.js — Phase 3: ScraperAPI Fetch + LLM Bipartite QA Gate
// §7.3 / §7.4 — fetch LinkedIn HTML, extract meta, strict identity+affiliation check

import { callLLM } from '../../lib/llm.js';
import { QA_SYSTEM_PROMPT } from '../../lib/prompts.js';
import { preQaChecks } from '../../lib/utils.js';

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
 * Run the strict bipartite LLM QA gate (§7.4).
 * Both identity (Rule 1) and affiliation (Rule 2) must match.
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
  const targetName = `${first_name} ${last_name}`;

  const userPrompt = [
    `Target Name: ${targetName}`,
    `Target Company Aliases: ${known_aliases.join(', ')}`,
    `Metadata Title: ${meta.title}`,
    `Metadata Description: ${meta.description}`,
  ].join('\n');

  const result = await callLLM(QA_SYSTEM_PROMPT, userPrompt);

  // Normalise the response — LLMs sometimes return string "true"/"false"
  const isVerified = result.is_verified === true || result.is_verified === 'true';
  const reason = typeof result.reason === 'string' ? result.reason.trim() : String(result.reason ?? '');

  return { is_verified: isVerified, reason };
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
  // ScraperAPI's free tier 403s on LinkedIn ("paid plan only"), and direct
  // fetch hits LinkedIn's HTTP 999 anti-bot wall. The only zero-cost source
  // of LinkedIn metadata is search-engine snippets — DDG already returns
  // the page title + meta description in each candidate, so we use those
  // directly for the QA gate. Identity-via-metadata still applies; the only
  // change is *where* the metadata comes from.
  let meta;
  if (candidate.title && candidate.title.trim()) {
    console.log('[qa] Using DDG snippet metadata (title:', candidate.title.slice(0, 60) + ')');
    meta = { title: candidate.title, description: candidate.description || '' };
  } else {
    // Pattern-only candidate or no DDG snippet — try the (likely-blocked) fetch.
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

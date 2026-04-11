// api/workers/phase2-search.js — Phase 2: Multi-Vector Search Triangulation
// §6.2 — 3 parallel DuckDuckGo queries, URL normalization, scoring

import { search } from 'duck-duck-scrape';
import { normalizeLinkedInUrl, sleep, randomJitter } from '../../lib/utils.js';

/**
 * Triangulate the LinkedIn profile URL for an entity.
 * Caller must pass { ...parsed, email } — email is not returned by parseEmail.
 *
 * @param {{
 *   first_name: string,
 *   last_name: string,
 *   root_domain: string,
 *   legal_company_name: string,
 *   email: string
 * }} params
 * @returns {Promise<Array<{url: string, score: number, vectors: number[]}>|null>}
 *   Ranked candidates, or null if no LinkedIn URLs found at all.
 */
export async function triangulateLinkedIn(params) {
  const { first_name, last_name, root_domain, legal_company_name, email } = params;
  const fullName = `${first_name} ${last_name}`;

  // §6.1 Three search vectors
  const queries = [
    `"${email}" site:linkedin.com/in/`,                                       // A: direct email match
    `"${fullName}" AND "${root_domain}" site:linkedin.com/in/`,               // B: name + domain
    `"${fullName}" "${legal_company_name}" site:linkedin.com/in/`,            // C: name + company
  ];

  // Execute all three in parallel (Promise.allSettled so one failure doesn't kill the rest)
  const results = await Promise.allSettled(
    queries.map(q => search(q, { safeSearch: 0 }))
  );

  // Aggregate URLs with scoring
  const urlMap = new Map();

  results.forEach((result, vectorIndex) => {
    if (result.status !== 'fulfilled') {
      console.warn(`[search] vector ${vectorIndex} failed:`, result.reason?.message);
      return;
    }

    const searchResults = result.value?.results ?? [];
    for (const r of searchResults) {
      const url = normalizeLinkedInUrl(r.url);
      if (!url) continue;

      if (!urlMap.has(url)) {
        urlMap.set(url, { url, score: 0, vectors: [] });
      }
      const entry = urlMap.get(url);
      if (!entry.vectors.includes(vectorIndex)) {
        entry.score += 1;
        entry.vectors.push(vectorIndex);
      }
    }
  });

  // Sort by score (higher = more vectors matched = higher confidence)
  const ranked = [...urlMap.values()].sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return null;
  return ranked;
}

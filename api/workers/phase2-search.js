// api/workers/phase2-search.js — Phase 2: Multi-Source Search with FREE Fallbacks
// §6.2 + Enhanced — Nubela → GitHub → Apollo → Hunter → Pattern Predict → DDG

import { search } from 'duck-duck-scrape';
import { normalizeLinkedInUrl, sleep, randomJitter } from '../../lib/utils.js';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const APOLLO_KEY = process.env.APOLLO_API_KEY;
const HUNTER_KEY = process.env.HUNTER_API_KEY;
const NUBELA_KEY = process.env.PROXYCURL_API_KEY;

// ─ Fallback 1: Nubela/Proxycurl (direct email lookup) ─────────────────────
async function searchNubela(email) {
  if (!NUBELA_KEY) return null;

  try {
    const res = await fetch('https://nubela.co/proxycurl/api/find/email_to_profile', {
      headers: { 'Authorization': `Bearer ${NUBELA_KEY}` },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.linkedin_profile_url) {
        const url = normalizeLinkedInUrl(data.linkedin_profile_url);
        if (url) {
          console.log('[search] ✓ Nubela found:', url);
          return [{ url, score: 3, vectors: [0, 1, 2] }];
        }
      }
    }
  } catch (err) {
    console.warn('[search] Nubela timeout/error:', err.message);
  }
  return null;
}

// ─ Fallback 2: GitHub API (FREE - 5000 req/hour with token) ───────────────
async function searchGitHub(email, firstName, lastName) {
  if (!GITHUB_TOKEN) return null;

  try {
    // Extract company name from email domain
    const domain = email.split('@')[1];
    const company = domain.split('.')[0]; // company.com → company

    const searchQueries = [
      `${firstName} ${lastName} type:user location:${company}`,
      `${firstName} ${lastName} type:user`,
      email.split('@')[0], // username part
    ];

    const results = [];

    for (const query of searchQueries) {
      try {
        const searchRes = await fetch(
          `https://api.github.com/search/users?q=${encodeURIComponent(query)}&per_page=3`,
          {
            headers: {
              'Accept': 'application/vnd.github.v3+json',
              'Authorization': `token ${GITHUB_TOKEN}`,
            },
            signal: AbortSignal.timeout(8000),
          }
        );

        if (!searchRes.ok) continue;

        const searchData = await searchRes.json();
        for (const user of searchData.items || []) {
          // Fetch full profile (bio often contains LinkedIn URL)
          const profileRes = await fetch(user.url, {
            headers: {
              'Accept': 'application/vnd.github.v3+json',
              'Authorization': `token ${GITHUB_TOKEN}`,
            },
            signal: AbortSignal.timeout(5000),
          });

          if (profileRes.ok) {
            const profile = await profileRes.json();
            // Look for LinkedIn in bio
            if (profile.bio) {
              const bioMatch = profile.bio.match(/linkedin\.com\/in\/([\w-]+)/i);
              if (bioMatch) {
                const url = normalizeLinkedInUrl(`https://www.linkedin.com/in/${bioMatch[1]}/`);
                if (url) {
                  console.log('[search] ✓ GitHub bio match:', url);
                  results.push({ url, score: 2.5, vectors: [0, 1] });
                }
              }
            }
          }
        }

        if (results.length > 0) {
          console.log('[search] ✓ GitHub found:', results.length, 'result(s)');
          return results;
        }
      } catch (err) {
        // Continue to next query
      }
    }
  } catch (err) {
    console.warn('[search] GitHub failed:', err.message);
  }
  return null;
}

// ─ Fallback 3: Apollo.io (free tier) ──────────────────────────────────────
async function searchApollo(email, firstName, lastName) {
  if (!APOLLO_KEY) return null;

  try {
    const res = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': APOLLO_KEY,
      },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.person?.linkedin_url) {
        const url = normalizeLinkedInUrl(data.person.linkedin_url);
        if (url) {
          console.log('[search] ✓ Apollo found:', url);
          return [{ url, score: 3, vectors: [0, 1, 2] }];
        }
      }
    }
  } catch (err) {
    console.warn('[search] Apollo error:', err.message);
  }
  return null;
}

// ─ Fallback 4: Hunter.io (free tier - email verification) ────────────────
async function searchHunter(email, firstName, lastName) {
  if (!HUNTER_KEY) return null;

  try {
    // Hunter can verify emails and return professional data
    const res = await fetch(
      `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&domain=${email.split('@')[1]}`,
      {
        headers: { 'Authorization': `Bearer ${HUNTER_KEY}` },
        signal: AbortSignal.timeout(8000),
      }
    );

    if (res.ok) {
      const data = await res.json();
      // Hunter sometimes includes LinkedIn in verification results
      if (data.data?.linkedin) {
        const url = normalizeLinkedInUrl(data.data.linkedin);
        if (url) {
          console.log('[search] ✓ Hunter found:', url);
          return [{ url, score: 2.5, vectors: [0, 1] }];
        }
      }
    }
  } catch (err) {
    console.warn('[search] Hunter error:', err.message);
  }
  return null;
}

// ─ Fallback 5: LinkedIn URL Pattern Prediction (COMPLETELY FREE) ──────────
function predictLinkedInUrl(email, firstName, lastName) {
  const patterns = [
    `${firstName.toLowerCase()}-${lastName.toLowerCase()}`,
    `${firstName.toLowerCase()}${lastName.toLowerCase()}`,
    `${firstName.toLowerCase()}.${lastName.toLowerCase()}`,
    `${firstName.toLowerCase()}_${lastName.toLowerCase()}`,
    `${firstName.charAt(0).toLowerCase()}${lastName.toLowerCase()}`,
    `${firstName.charAt(0).toLowerCase()}.${lastName.toLowerCase()}`,
    `${firstName.charAt(0).toLowerCase()}-${lastName.toLowerCase()}`,
  ];

  return patterns.map(pattern => ({
    url: `https://www.linkedin.com/in/${pattern}/`,
    score: 1.5,
    vectors: [0],
  }));
}

// ─ Verify LinkedIn URL exists (FREE - HEAD request) ───────────────────────
async function verifyLinkedInUrl(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    });

    // 200 = exists, 30x = redirect (valid), 404/410 = gone
    const exists = res.status !== 404 && res.status !== 410 && res.status !== 403;
    if (exists) {
      console.log('[search] ✓ URL verified:', url);
    }
    return exists;
  } catch (err) {
    console.warn('[search] Verification timeout:', url);
    return false;
  }
}

// ─ Fallback 6: DuckDuckGo (original) ──────────────────────────────────────
async function searchDDG(email, firstName, lastName, domain) {
  const fullName = `${firstName} ${lastName}`;
  const queries = [
    `"${email}" site:linkedin.com/in/`,
    `"${fullName}" AND "${domain}" site:linkedin.com/in/`,
    `"${fullName}" site:linkedin.com/in/`,
  ];

  const urlMap = new Map();
  const results = await Promise.allSettled(
    queries.map(q => search(q, { safeSearch: 0 }))
  );

  results.forEach((result, vectorIndex) => {
    if (result.status !== 'fulfilled') {
      console.warn(`[search] DDG vector ${vectorIndex} failed`);
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

  const ranked = [...urlMap.values()].sort((a, b) => b.score - a.score);
  if (ranked.length > 0) {
    console.log('[search] ✓ DDG found:', ranked.length, 'result(s)');
    return ranked;
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
/**
 * Main triangulation with full FREE fallback chain
 */
export async function triangulateLinkedIn(params) {
  const { first_name, last_name, root_domain, legal_company_name, email } = params;
  const fullName = `${first_name} ${last_name}`;

  console.log(`\n[search] Starting triangulation for: ${email}`);
  console.log(`[search] Target: ${fullName} @ ${legal_company_name}`);

  // ① Nubela (direct email match - strongest signal)
  console.log('[search] [1/6] Trying Nubela...');
  let results = await searchNubela(email);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ② GitHub (free - find professionals with LinkedIn in bio)
  console.log('[search] [2/6] Trying GitHub...');
  results = await searchGitHub(email, first_name, last_name);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ③ Apollo (email-to-profile lookup)
  console.log('[search] [3/6] Trying Apollo...');
  results = await searchApollo(email, first_name, last_name);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ④ Hunter (email verification with data)
  console.log('[search] [4/6] Trying Hunter...');
  results = await searchHunter(email, first_name, last_name);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ⑤ Pattern Prediction + Verification (COMPLETELY FREE!)
  console.log('[search] [5/6] Trying pattern prediction...');
  const predicted = predictLinkedInUrl(email, first_name, last_name);
  for (const candidate of predicted) {
    const exists = await verifyLinkedInUrl(candidate.url);
    if (exists) {
      return [candidate];
    }
  }

  await sleep(randomJitter(500, 1500));

  // ⑥ DuckDuckGo (final fallback)
  console.log('[search] [6/6] Trying DuckDuckGo...');
  results = await searchDDG(email, first_name, last_name, root_domain);
  if (results?.length > 0) return results;

  console.log('[search] ✗ All sources exhausted → manual_review');
  return null;
}

// api/workers/phase2-search.js — Phase 2: Multi-Source Search with FREE Fallbacks
// §6.2 + Enhanced — Gemini Search → Nubela → GitHub → Apollo → Hunter → Pattern → DDG

import { search } from 'duck-duck-scrape';
import { normalizeLinkedInUrl, sleep, randomJitter } from '../../lib/utils.js';

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const APOLLO_KEY = process.env.APOLLO_API_KEY;
const HUNTER_KEY = process.env.HUNTER_API_KEY;
const NUBELA_KEY = process.env.API_NUBELA || process.env.PROXYCURL_API_KEY;

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;

// ─ Source 0a: ScraperAPI Google Search (structured, very reliable) ─────────
// ScraperAPI's structured Google search endpoint is fast, returns clean JSON,
// and works for linkedin.com site-restricted queries (unlike LinkedIn scraping
// which requires a paid plan). Free tier: 1000 requests.
async function searchGoogle(email, firstName, lastName, companyName, domain) {
  if (!SCRAPER_API_KEY) return null;

  const localPart = email.split('@')[0];
  const fullName = [firstName, lastName].filter(Boolean).join(' ');

  // Build a diverse set of queries. Order matters — scoring prioritizes queries that appear together.
  // For generic company names (like "Bubble"), we rely more on name + email patterns.
  const queries = [];

  if (lastName) {
    // Query 1: Full name alone (catches most profiles)
    queries.push(`"${firstName} ${lastName}" site:linkedin.com/in`);
    // Query 2: Full name + company (best case, but may return wrong results for generic names)
    queries.push(`"${firstName} ${lastName}" "${companyName}" site:linkedin.com/in`);
    // Query 3: Email local part + last name (catches email-based naming patterns like amrita.mutha)
    queries.push(`"${localPart}" "${lastName}" site:linkedin.com/in`);
  } else {
    // Single-name: use company to disambiguate
    queries.push(`"${firstName}" "${companyName}" site:linkedin.com/in`);
    // Also try name alone for unique first names
    queries.push(`"${firstName}" site:linkedin.com/in`);
  }
  // Email local part + domain (catches non-obvious slug patterns)
  queries.push(`"${localPart}" "${domain}" site:linkedin.com/in`);

  const urlMap = new Map();

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    try {
      const apiUrl = `https://api.scraperapi.com/structured/google/search?api_key=${SCRAPER_API_KEY}&query=${encodeURIComponent(q)}&num=5`;
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(20000) });

      if (!res.ok) {
        console.warn(`[search] Google q${i} returned ${res.status}`);
        continue;
      }

      const data = await res.json();
      for (const result of data.organic_results || []) {
        const url = normalizeLinkedInUrl(result.link);
        if (!url) continue;

        if (!urlMap.has(url)) {
          urlMap.set(url, {
            url,
            score: 0,
            vectors: [],
            title: '',
            description: '',
            source: { method: 'google' },
          });
        }
        const entry = urlMap.get(url);
        // Weight by query index — earlier (more specific) queries get higher weight if they match
        entry.score += (queries.length - i);
        if (!entry.vectors.includes(i)) entry.vectors.push(i);
        if (result.title && result.title.length > entry.title.length) entry.title = result.title;
        if (result.snippet && result.snippet.length > entry.description.length) entry.description = result.snippet;
      }
    } catch (err) {
      console.warn(`[search] Google q${i} error:`, err.message);
    }

    await sleep(randomJitter(500, 1200));
  }

  const ranked = [...urlMap.values()].sort((a, b) => b.score - a.score);
  if (ranked.length > 0) {
    console.log('[search] ✓ Google found:', ranked.length, 'result(s), top score:', ranked[0].score);
    // Only return high-confidence results; otherwise let other sources try
    if (ranked[0].score >= 3) {
      return ranked;
    } else {
      console.warn('[search] Google results have low confidence score, continuing to next source');
    }
  }
  return null;
}

// ─ Source 0b: Gemini Search Grounding (FREE — Google Search via LLM) ──────
// Gemini with google_search tool executes real Google searches and returns
// grounded results. Unlike DDG, this works from Vercel serverless IPs.
// Returns candidates with DDG-compatible {url, title, description} fields
// so the QA gate can use snippet metadata directly.
async function searchGemini(email, firstName, lastName, companyName) {
  if (!GEMINI_KEY) return null;

  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  // Natural-language prompt that triggers Google Search grounding. Do NOT
  // ask for JSON — grounding fires more reliably for conversational queries.
  const prompt = `Search the internet and find the LinkedIn profile page for ${fullName} who works at ${companyName}. Their work email is ${email}. Provide any linkedin.com/in/ URLs you find, with the page title shown in Google results.`;

  try {
    // Try gemini-2.0-flash first (most reliable grounding), fall back to 2.5-flash
    const models = ['gemini-2.0-flash', 'gemini-2.5-flash'];
    for (const model of models) {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (res.status === 429) {
        console.warn(`[search] Gemini ${model} rate-limited, trying next model`);
        await sleep(2000);
        continue;
      }
      if (!res.ok) {
        console.warn(`[search] Gemini ${model} returned ${res.status}`);
        continue;
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts
        ?.filter(p => p.text)
        ?.map(p => p.text)
        ?.join('') || '';

      // Extract all linkedin.com/in/ URLs from the response text
      const urlMap = new Map();
      const linkedinMatches = text.matchAll(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w-]+\/?/gi);
      for (const m of linkedinMatches) {
        const normalized = normalizeLinkedInUrl(m[0]);
        if (normalized && !urlMap.has(normalized)) {
          // Try to extract the surrounding context as title/description
          const idx = text.indexOf(m[0]);
          const context = text.slice(Math.max(0, idx - 200), idx + m[0].length + 200);
          urlMap.set(normalized, {
            url: normalized,
            score: 2.5,
            vectors: [0, 1],
            title: '',
            description: context.replace(/\n/g, ' ').trim().slice(0, 300),
            source: { method: 'gemini_search' },
          });
        }
      }

      // Also extract from grounding search suggestions if any
      const suggestions = data.candidates?.[0]?.groundingMetadata?.webSearchQueries || [];
      if (suggestions.length > 0) {
        console.log('[search] Gemini search queries:', suggestions.join(' | '));
      }

      if (urlMap.size > 0) {
        const results = [...urlMap.values()];
        console.log(`[search] ✓ Gemini Search (${model}) found:`, results.length, 'result(s)');
        return results;
      }

      console.log(`[search] Gemini ${model} searched but found no LinkedIn URLs in response`);
      // Don't try next model if this one ran successfully
      break;
    }
  } catch (err) {
    console.warn('[search] Gemini Search error:', err.message);
  }
  return null;
}

// ─ Fallback 1: Nubela/NinjaPear (direct email lookup) ────────────────────
// Proxycurl was sunset; the key now works with the NinjaPear employee API.
async function searchNubela(email) {
  if (!NUBELA_KEY) return null;

  try {
    const apiUrl = `https://nubela.co/api/v1/employee/profile?work_email=${encodeURIComponent(email)}`;
    const res = await fetch(apiUrl, {
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

    const fullName = [firstName, lastName].filter(Boolean).join(' ');
    const searchQueries = [
      `${fullName} type:user location:${company}`,
      `${fullName} type:user`,
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

// ─ Fallback 6: DuckDuckGo (captures title + description from snippets) ───
// DDG search snippets contain LinkedIn page <title> + meta description, so
// we can verify identity without ever scraping LinkedIn directly. This is
// the only zero-cost path because ScraperAPI's free tier blocks LinkedIn
// (returns 403 "domain only accessible via paid plan").
async function searchDDG(email, firstName, lastName, domain) {
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
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
      console.warn(`[search] DDG vector ${vectorIndex} failed:`, result.reason?.message);
      return;
    }

    const searchResults = result.value?.results ?? [];
    for (const r of searchResults) {
      const url = normalizeLinkedInUrl(r.url);
      if (!url) continue;

      if (!urlMap.has(url)) {
        urlMap.set(url, {
          url,
          score: 0,
          vectors: [],
          title: '',
          description: '',
          source: { method: 'ddg' },
        });
      }
      const entry = urlMap.get(url);
      if (!entry.vectors.includes(vectorIndex)) {
        entry.score += 1;
        entry.vectors.push(vectorIndex);
      }
      // Prefer the longest title/description (richest snippet) across vectors
      if (r.title && r.title.length > entry.title.length) entry.title = r.title;
      if (r.description && r.description.length > entry.description.length) {
        entry.description = r.description;
      }
    }
  });

  const ranked = [...urlMap.values()].sort((a, b) => b.score - a.score);
  if (ranked.length > 0) {
    console.log('[search] ✓ DDG found:', ranked.length, 'result(s) with snippets');
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
  const fullName = [first_name, last_name].filter(Boolean).join(' ');

  console.log(`\n[search] Starting triangulation for: ${email}`);
  console.log(`[search] Target: ${fullName} @ ${legal_company_name}`);

  // ① Google Search via ScraperAPI (structured, reliable, gets title+snippet)
  console.log('[search] [1/8] Trying Google Search (ScraperAPI)...');
  let results = await searchGoogle(email, first_name, last_name, legal_company_name, root_domain);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ② Gemini Search Grounding (backup Google Search)
  console.log('[search] [2/8] Trying Gemini Search Grounding...');
  results = await searchGemini(email, first_name, last_name, legal_company_name);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ③ Nubela (direct email match)
  console.log('[search] [3/8] Trying Nubela...');
  results = await searchNubela(email);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ④ GitHub (free - find professionals with LinkedIn in bio)
  console.log('[search] [4/8] Trying GitHub...');
  results = await searchGitHub(email, first_name, last_name);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ⑤ Apollo (email-to-profile lookup)
  console.log('[search] [5/8] Trying Apollo...');
  results = await searchApollo(email, first_name, last_name);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ⑥ Hunter (email verification with data)
  console.log('[search] [6/8] Trying Hunter...');
  results = await searchHunter(email, first_name, last_name);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ⑦ Pattern Prediction — skip if no last_name (too many false-positive slugs).
  let patternHits = [];
  if (last_name) {
    console.log('[search] [7/8] Trying pattern prediction...');
    const predicted = predictLinkedInUrl(email, first_name, last_name);
    for (const candidate of predicted) {
      const exists = await verifyLinkedInUrl(candidate.url);
      if (exists) {
        candidate.source = { method: 'pattern', verified: true };
        patternHits.push(candidate);
      }
    }
  } else {
    console.log('[search] [7/8] Skipping pattern prediction (no last name)');
  }

  await sleep(randomJitter(500, 1500));

  // ⑧ DuckDuckGo — additional candidates (merged with pattern hits)
  console.log('[search] [8/8] Trying DuckDuckGo...');
  const ddgResults = await searchDDG(email, first_name, last_name, root_domain);

  const merged = [...patternHits, ...(ddgResults ?? [])]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  if (merged.length > 0) {
    console.log(`[search] ✓ Returning ${merged.length} candidate(s) for QA gate`);
    return merged;
  }

  console.log('[search] ✗ All sources exhausted → manual_review');
  return null;
}

// api/workers/phase2-search.js — Phase 2: Multi-Source Search with FREE Fallbacks
// Powerhouse pipeline: LLM X-ray Queries → Google (ScraperAPI) → Serper → Gemini Search
// → Nubela → GitHub → Apollo → Hunter → Pattern → DDG

import { search } from 'duck-duck-scrape';
import { normalizeLinkedInUrl, sleep, randomJitter } from '../../lib/utils.js';
import { callLLM } from '../../lib/llm.js';

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const APOLLO_KEY = process.env.APOLLO_API_KEY;
const HUNTER_KEY = process.env.HUNTER_API_KEY;
const NUBELA_KEY = process.env.API_NUBELA || process.env.PROXYCURL_API_KEY;

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const GOOGLE_CSE_KEY = process.env.GOOGLE_CSE_API_KEY;
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX;

// ─ LLM-Powered X-Ray Query Generator ────────────────────────────────────────
// Uses LLM to generate diverse, tailored Google X-ray queries for each person.
// This is the key breakthrough: instead of 2-3 hardcoded patterns, we get 5
// contextually-aware queries that handle generic company names, common names,
// single-name emails, and varied LinkedIn URL slug patterns.
const XRAY_SYSTEM_PROMPT = `You are a LinkedIn profile search expert. Generate exactly 5 diverse Google X-ray search queries to find a specific person's LinkedIn profile.

Rules:
1. Every query MUST start with: site:linkedin.com/in
2. Use double quotes around names and companies for exact match
3. Vary your approach across queries:
   - Query 1: Full name + company name (most specific)
   - Query 2: Full name + company domain/variations (handles rebranding)
   - Query 3: Full name only (catches people who changed companies)
   - Query 4: Email local part as potential LinkedIn slug pattern (e.g., "john.doe" → "john-doe")
   - Query 5: Creative variation (initials, name without quotes, company abbreviation)
4. For single-name emails (no last name), focus on first name + company combinations
5. For generic company names (like "Bubble", "Slack", "Monday"), also include the domain form
6. Return ONLY a JSON array of 5 query strings. No explanation.

Example output: ["site:linkedin.com/in \\"John Doe\\" \\"Acme Corp\\"", "site:linkedin.com/in \\"John Doe\\" acme.com", ...]`;

async function generateXrayQueries(email, firstName, lastName, companyName, domain) {
  const localPart = email.split('@')[0];
  const fullName = [firstName, lastName].filter(Boolean).join(' ');

  const userPrompt = `Generate 5 LinkedIn X-ray queries for:
- Email: ${email}
- First Name: ${firstName}
- Last Name: ${lastName || '(unknown)'}
- Company: ${companyName}
- Domain: ${domain}
- Email local part: ${localPart}`;

  try {
    const result = await callLLM(XRAY_SYSTEM_PROMPT, userPrompt);
    const queries = Array.isArray(result) ? result : result.queries || result.q || [];
    if (queries.length > 0) {
      console.log(`[search] LLM generated ${queries.length} X-ray queries`);
      return queries.slice(0, 5);
    }
  } catch (err) {
    console.warn('[search] LLM query generation failed:', err.message);
  }

  // Fallback to hardcoded queries if LLM fails
  console.log('[search] Using fallback hardcoded queries');
  const queries = [];
  if (lastName) {
    queries.push(`site:linkedin.com/in "${firstName} ${lastName}" "${companyName}"`);
    queries.push(`site:linkedin.com/in "${firstName} ${lastName}" "${domain}"`);
    queries.push(`site:linkedin.com/in "${firstName} ${lastName}"`);
    queries.push(`site:linkedin.com/in "${localPart.replace(/[._]/g, '-')}" "${companyName}"`);
    queries.push(`site:linkedin.com/in ${firstName} ${lastName} ${companyName}`);
  } else {
    queries.push(`site:linkedin.com/in "${firstName}" "${companyName}"`);
    queries.push(`site:linkedin.com/in "${firstName}" "${domain}"`);
    queries.push(`site:linkedin.com/in "${localPart}" "${companyName}"`);
  }
  return queries;
}

// ─ Shared: Execute queries via a Google search backend ───────────────────────
function collectLinkedInResults(organicResults, queryIndex, urlMap, method) {
  for (const result of organicResults) {
    const url = normalizeLinkedInUrl(result.link || result.url);
    if (!url) continue;

    if (!urlMap.has(url)) {
      urlMap.set(url, {
        url,
        score: 0,
        vectors: [],
        title: '',
        description: '',
        source: { method },
      });
    }
    const entry = urlMap.get(url);
    entry.score += 1;
    if (!entry.vectors.includes(queryIndex)) entry.vectors.push(queryIndex);
    const title = result.title || '';
    const desc = result.snippet || result.description || '';
    if (title.length > entry.title.length) entry.title = title;
    if (desc.length > entry.description.length) entry.description = desc;
  }
}

// ─ Source 1: ScraperAPI Google Search (structured, very reliable) ─────────
async function searchGoogle(queries) {
  if (!SCRAPER_API_KEY) return null;

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
      collectLinkedInResults(data.organic_results || [], i, urlMap, 'google');
    } catch (err) {
      console.warn(`[search] Google q${i} error:`, err.message);
    }

    if (i < queries.length - 1) await sleep(randomJitter(500, 1200));
  }

  const ranked = [...urlMap.values()].sort((a, b) => b.score - a.score);
  if (ranked.length > 0) {
    console.log('[search] ✓ Google found:', ranked.length, 'result(s), top score:', ranked[0].score);
    return ranked;
  }
  return null;
}

// ─ Source 2: Serper.dev (fast, 2500 free queries) ────────────────────────
async function searchSerper(queries) {
  if (!SERPER_API_KEY) return null;

  const urlMap = new Map();

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': SERPER_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q, num: 5 }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        console.warn(`[search] Serper q${i} returned ${res.status}`);
        continue;
      }

      const data = await res.json();
      // Serper returns { organic: [{ title, link, snippet }] }
      const results = (data.organic || []).map(r => ({
        link: r.link,
        title: r.title,
        snippet: r.snippet,
      }));
      collectLinkedInResults(results, i, urlMap, 'serper');
    } catch (err) {
      console.warn(`[search] Serper q${i} error:`, err.message);
    }

    if (i < queries.length - 1) await sleep(randomJitter(300, 800));
  }

  const ranked = [...urlMap.values()].sort((a, b) => b.score - a.score);
  if (ranked.length > 0) {
    console.log('[search] ✓ Serper found:', ranked.length, 'result(s), top score:', ranked[0].score);
    return ranked;
  }
  return null;
}

// ─ Source 3: Google Custom Search API (100 free/day, restricted to linkedin.com) ─
async function searchGoogleCSE(queries) {
  if (!GOOGLE_CSE_KEY || !GOOGLE_CSE_CX) return null;

  const urlMap = new Map();

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    try {
      // CSE is already restricted to linkedin.com, so strip site: prefix
      const cleanQuery = q.replace(/site:linkedin\.com\/in\s*/i, '').trim();
      const params = new URLSearchParams({
        key: GOOGLE_CSE_KEY,
        cx: GOOGLE_CSE_CX,
        q: cleanQuery,
        num: '5',
      });
      const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`, {
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        console.warn(`[search] Google CSE q${i} returned ${res.status}`);
        continue;
      }

      const data = await res.json();
      const results = (data.items || []).map(item => ({
        link: item.link,
        title: item.title,
        snippet: item.snippet,
      }));
      collectLinkedInResults(results, i, urlMap, 'google_cse');
    } catch (err) {
      console.warn(`[search] Google CSE q${i} error:`, err.message);
    }

    if (i < queries.length - 1) await sleep(randomJitter(300, 800));
  }

  const ranked = [...urlMap.values()].sort((a, b) => b.score - a.score);
  if (ranked.length > 0) {
    console.log('[search] ✓ Google CSE found:', ranked.length, 'result(s), top score:', ranked[0].score);
    return ranked;
  }
  return null;
}

// ─ Source 4: Gemini Search Grounding (FREE — Google Search via LLM) ──────
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
 * Main triangulation with full FREE fallback chain.
 *
 * The key innovation: LLM generates 5 diverse X-ray queries tailored to
 * each person. These queries are then executed across multiple Google search
 * backends (ScraperAPI, Serper). URLs that appear across multiple queries
 * get higher scores, making the top result very likely to be correct.
 */
export async function triangulateLinkedIn(params) {
  const { first_name, last_name, root_domain, legal_company_name, email } = params;
  const fullName = [first_name, last_name].filter(Boolean).join(' ');

  console.log(`\n[search] Starting triangulation for: ${email}`);
  console.log(`[search] Target: ${fullName} @ ${legal_company_name}`);

  // Step 0: Generate diverse X-ray queries via LLM
  console.log('[search] [0/9] Generating X-ray queries via LLM...');
  const xrayQueries = await generateXrayQueries(
    email, first_name, last_name, legal_company_name, root_domain
  );
  console.log('[search] Queries:', xrayQueries.map((q, i) => `\n  q${i}: ${q}`).join(''));

  // ① Google Search via ScraperAPI (structured, reliable, gets title+snippet)
  console.log('[search] [1/9] Trying Google Search (ScraperAPI)...');
  let results = await searchGoogle(xrayQueries);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ② Serper.dev (fast, 2500 free queries, second Google backend)
  console.log('[search] [2/10] Trying Serper.dev...');
  results = await searchSerper(xrayQueries);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ③ Google Custom Search API (100 free/day, restricted to linkedin.com)
  console.log('[search] [3/10] Trying Google Custom Search API...');
  results = await searchGoogleCSE(xrayQueries);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ④ Gemini Search Grounding (backup Google Search via LLM)
  console.log('[search] [4/10] Trying Gemini Search Grounding...');
  results = await searchGemini(email, first_name, last_name, legal_company_name);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ④ Nubela (direct email match)
  console.log('[search] [5/10] Trying Nubela...');
  results = await searchNubela(email);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ⑤ GitHub (free - find professionals with LinkedIn in bio)
  console.log('[search] [6/10] Trying GitHub...');
  results = await searchGitHub(email, first_name, last_name);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ⑥ Apollo (email-to-profile lookup)
  console.log('[search] [7/10] Trying Apollo...');
  results = await searchApollo(email, first_name, last_name);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ⑦ Hunter (email verification with data)
  console.log('[search] [8/10] Trying Hunter...');
  results = await searchHunter(email, first_name, last_name);
  if (results?.length > 0) return results;

  await sleep(randomJitter(300, 800));

  // ⑧ Pattern Prediction — skip if no last_name (too many false-positive slugs).
  let patternHits = [];
  if (last_name) {
    console.log('[search] [9/10] Trying pattern prediction...');
    const predicted = predictLinkedInUrl(email, first_name, last_name);
    for (const candidate of predicted) {
      const exists = await verifyLinkedInUrl(candidate.url);
      if (exists) {
        candidate.source = { method: 'pattern', verified: true };
        patternHits.push(candidate);
      }
    }
  } else {
    console.log('[search] [9/10] Skipping pattern prediction (no last name)');
  }

  await sleep(randomJitter(500, 1500));

  // ⑨ DuckDuckGo — additional candidates (merged with pattern hits)
  console.log('[search] [10/10] Trying DuckDuckGo...');
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

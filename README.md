# Email → LinkedIn URL Verifier

Zero-cost deterministic LinkedIn URL verification agent. Input a professional email address, get a verified LinkedIn profile URL with **100% confidence** — or the record is flagged for manual review. No probabilistic guessing.

**Design principle: precision over recall.** The system never produces a false positive — any uncertainty routes to `manual_review`.

## How It Works

1. **Fast-fail** — role-based emails (`info@`, `sales@`) and numeric local parts skip the LLM entirely.
2. **Parse** — LLM (Groq → Gemini fallback) extracts name + company + aliases from the email.
3. **Search** — 6-source triangulation: Nubela → GitHub → Apollo → Hunter → pattern prediction → DuckDuckGo. The first source that returns candidates wins.
4. **QA Gate** — for each candidate, fetch LinkedIn metadata (search-engine snippet preferred; ScraperAPI fallback) and run a strict bipartite LLM check: name **AND** company affiliation must both pass.
5. **Route** — `VERIFIED` (with the URL) or `MANUAL_REVIEW` (with the rejection reason). No middle ground.

## Stack

- **Vercel** (Hobby) — serverless API + dashboard + daily cron
- **Supabase** — PostgreSQL state machine, job queue, audit log
- **Groq** (Llama-3) — primary LLM inference
- **Gemini** — fallback LLM
- **DuckDuckGo** — programmatic search (no API key)
- **ScraperAPI** — LinkedIn HTML proxy (paid plan required for LinkedIn — free tier returns 403)

All free-tier compatible. Add a paid ScraperAPI plan (or any LinkedIn-accessible proxy) to unlock recall on profiles that DDG doesn't index.

## Usage

See the web dashboard at your Vercel deployment URL, or use the API directly:

```bash
# Ingest emails
curl -X POST https://your-app.vercel.app/api/ingest \
  -H "x-api-key: YOUR_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"emails": ["john.doe@company.com"]}'

# Check status
curl https://your-app.vercel.app/api/status/JOB_ID \
  -H "x-api-key: YOUR_API_SECRET"

# Download results
curl https://your-app.vercel.app/api/export/JOB_ID \
  -H "x-api-key: YOUR_API_SECRET" -o results.csv
```

## Setup

1. Clone this repo
2. Copy `.env.example` to `.env` and fill in all values
3. Run `npm install`
4. Run `npm run migrate` to apply the database schema
5. Deploy to Vercel: set all env vars in Vercel Dashboard → push to main

## Verification

```bash
npm test                          # 46 unit tests on helpers + parsers
node scripts/test-phase1.js elon.musk@tesla.com   # parse a single email
node scripts/test-phase2.js elon.musk@tesla.com   # search candidates
node scripts/seed-test.js && node scripts/invoke-worker.js   # local end-to-end
node scripts/smoke-test.js https://your-app.vercel.app       # production smoke test (6-email matrix)
```

## Architecture notes

- **Stale lock cleanup** runs at the top of every cron invocation via `reset_stale_locks()` RPC.
- **Atomic job counters** (`completed`, `verified`, `manual_review`) update in a single SQL statement to keep the dashboard in sync.
- **Cron auth**: cron uses `Authorization: Bearer ${CRON_SECRET}`; manual triggers use `x-api-key`.
- **DDG snippet metadata** is captured at search time and reused at QA time, which avoids the LinkedIn fetch entirely when DDG returns the candidate.

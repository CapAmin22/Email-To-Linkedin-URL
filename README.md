# Email → LinkedIn URL Verifier

Zero-cost deterministic LinkedIn URL verification agent. Input a professional email address, get a verified LinkedIn profile URL with **100% confidence** — or the record is flagged for manual review. No probabilistic guessing.

## How It Works

1. **Parse** — LLM (Groq/Gemini) extracts name + company from the email
2. **Search** — 3 parallel DuckDuckGo queries triangulate the LinkedIn profile URL
3. **Verify** — ScraperAPI fetches HTML metadata; strict bipartite matching confirms name AND company
4. **Route** — `VERIFIED` or `MANUAL_REVIEW`. No middle ground.

## Stack

- **Vercel** (Hobby) — serverless API + cron
- **Supabase** — PostgreSQL state machine + job queue
- **Groq** (Llama-3) — LLM inference
- **Gemini** — fallback LLM
- **DuckDuckGo** — programmatic search (no API key)
- **ScraperAPI** — LinkedIn HTML proxy

All free-tier. $0 infrastructure.

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

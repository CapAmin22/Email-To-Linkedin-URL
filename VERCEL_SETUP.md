# Vercel Deployment Checklist

## ✅ GitHub Status
- **Latest commit**: `98bc6a1` (fix: enforce per-query timeout on Serper searches)
- **Branch**: `main` (fully up-to-date)
- **Status**: All changes committed and pushed ✓

## 📋 Required Environment Variables (17 total)

**Copy each value from your local `.env` file into Vercel:**

### Database & Authentication (6 variables)
1. `SUPABASE_URL` — Supabase project URL
2. `SUPABASE_SERVICE_KEY` — Supabase service role key
3. `SUPABASE_ANON_KEY` — Supabase anonymous key
4. `DATABASE_URL` — PostgreSQL connection string
5. `API_SECRET` — Secret for API authentication
6. `CRON_SECRET` — Secret for cron job authorization

### Search APIs - PRIMARY (4 variables)
7. `SERPER_API` — Serper.dev API key (2,500 free/month)
8. `SERPER_API_KEY` — Same as SERPER_API
9. `GOOGLE_CSE_KEY` — Google Custom Search API key
10. `GOOGLE_CSE_CX` — Google Custom Search Engine ID

### AI & LLM (2 variables)
11. `GROQ_API_KEY` — Groq API for fast LLM queries
12. `GEMINI_API_KEY` — Google Gemini API for backup search

### Email-to-Profile Data Sources (5 variables)
13. `SCRAPER_API_KEY` — ScraperAPI key (Google search scraping)
14. `API_NUBELA` — Nubela/ProxyCurl API key
15. `APOLLO_API_KEY` — Apollo.io email-to-LinkedIn API
16. `HUNTER_API_KEY` — Hunter.io email verification API
17. `GITHUB_TOKEN` — GitHub token for user search

## 🚀 Vercel Deployment Steps

1. Go to **https://vercel.com/dashboard**
2. Select your **`Email-To-Linkedin-URL`** project
3. Click **Settings** → **Environment Variables**
4. Add each of the 17 variables from `.env` file
5. **Redeploy** → Click "Deployments" → "Redeploy" (or push to GitHub for auto-deploy)

## ✅ User-Visible Features

### Dashboard Table Columns

| Column | Shows | When Visible |
|--------|-------|--------------|
| **Status** | Verified / Review / Error / Pending | Always |
| **Email** | User's work email with copy button | Always |
| **LinkedIn URL** | Clickable link to profile | ✅ If verified |
| **Reason** | Why URL was accepted or rejected | Always (truncated + hover tooltip) |

### Example Reasons Users See

**Verified ✅**
- `"Perfect name match (Sofia Johnson) found with Smartsheet mention in metadata"`
- `"Name and company verified via LinkedIn page title"`
- `"Pattern+WebConfirm: linkedin.com/in/amrita-mutha confirmed via RocketReach"`

**Manual Review ⚠️**
- `"Multiple people with matching name found, cannot distinguish"`
- `"No verifiable name mention in page metadata"`
- `"Name may match but no Target Company alias found in title or description"`
- `"No candidates found from any search source"`

**Error ❌**
- `"LinkedIn profile not accessible — HTTP 999 or 403"`
- `"All search sources exhausted, timeout reached"`

## ⏱️ Performance Guarantees

- **Response Time**: < 10 seconds per email (or returns "manual_review")
- **Search Pipeline**:
  1. Serper.dev (primary, fast)
  2. Google Custom Search API (restricted to linkedin.com)
  3. Direct APIs (Apollo/Nubela/Hunter in parallel)
  4. Fallback sources (Gemini, GitHub, DuckDuckGo, Pattern prediction)

## 🔄 Auto-Deployment

Once environment variables are set:
- **GitHub push** → Vercel auto-deploys
- **Production URL**: https://email-to-linkedin-url.vercel.app
- **Features Active**: 10-second timeout, Google CSE, web mention confirmation

## 📊 API Endpoints

All endpoints return `qa_reason` for transparency:

```
POST   /api/ingest              — Submit email batch
GET    /api/status/:jobId       — Check processing progress
GET    /api/records/:jobId      — Fetch results (with qa_reason)
POST   /api/workers/process-batch — Manually trigger worker
GET    /api/export/:jobId       — Download CSV
```

## 🔐 Security Notes

- Never commit `.env` to GitHub (use `.gitignore`)
- API keys stored only in Vercel environment (encrypted)
- All secrets already blocked from push via GitHub push protection
- `.env` file included in `.gitignore` automatically

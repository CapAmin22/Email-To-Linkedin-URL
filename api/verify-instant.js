// api/verify-instant.js — Synchronous single-email verification (no queue)
// Returns the best match + up to 5 ranked candidates, all within 10 seconds.

import { requireApiKey } from '../lib/auth.js';
import { isRoleBasedEmail, isNumericLocalPart, companyMatchStrength } from '../lib/utils.js';
import { parseEmail } from './workers/phase1-parse.js';
import { triangulateLinkedIn } from './workers/phase2-search.js';
import { runQaGate } from './workers/phase3-qa.js';

const INSTANT_TIMEOUT_MS = 10000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = requireApiKey(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { email } = req.body ?? {};
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const emailLower = email.trim().toLowerCase();
  const startTime = Date.now();

  // Fast pre-checks
  if (isRoleBasedEmail(emailLower)) {
    return res.status(200).json({
      email: emailLower, status: 'manual_review', linkedin_url: null, candidates: [],
      reason: 'Role-based email — cannot resolve to individual',
      elapsed_ms: Date.now() - startTime,
    });
  }
  if (isNumericLocalPart(emailLower)) {
    return res.status(200).json({
      email: emailLower, status: 'manual_review', linkedin_url: null, candidates: [],
      reason: 'Numeric-only local part — no name extractable',
      elapsed_ms: Date.now() - startTime,
    });
  }

  try {
    // ── Phase 1: Parse ────────────────────────────────────────────────
    let parsed;
    try {
      parsed = await parseEmail(emailLower);
    } catch (err) {
      return res.status(200).json({
        email: emailLower, status: 'error', linkedin_url: null, candidates: [],
        reason: `Could not parse email: ${err.message}`,
        elapsed_ms: Date.now() - startTime,
      });
    }

    // ── Phase 2: Search ───────────────────────────────────────────────
    const searchBudget = INSTANT_TIMEOUT_MS - (Date.now() - startTime) - 2000;
    let rawCandidates;
    try {
      rawCandidates = await triangulateLinkedIn({ ...parsed, email: emailLower }, Math.max(3000, searchBudget));
    } catch (err) {
      return res.status(200).json({
        email: emailLower, status: 'error', linkedin_url: null, candidates: [],
        reason: `Search error: ${err.message}`,
        first_name: parsed.first_name, last_name: parsed.last_name, company: parsed.legal_company_name,
        elapsed_ms: Date.now() - startTime,
      });
    }

    if (!rawCandidates || rawCandidates.length === 0) {
      return res.status(200).json({
        email: emailLower, status: 'not_found', linkedin_url: null, candidates: [],
        reason: 'No LinkedIn profile candidates found from any source',
        first_name: parsed.first_name, last_name: parsed.last_name, company: parsed.legal_company_name,
        elapsed_ms: Date.now() - startTime,
      });
    }

    // ── Pre-QA re-ranking ─────────────────────────────────────────────
    const emailSlug = emailLower.split('@')[0].replace(/[._]/g, '-');
    const firstLower = parsed.first_name.toLowerCase();

    for (const c of rawCandidates) {
      const strength = companyMatchStrength(parsed.known_aliases, c.title || '', c.description || '');
      if (strength === 'title')            c.score += 2.5;
      else if (strength === 'description') c.score += 1.0;

      const slug = (c.url.match(/\/in\/([\w-]+)\/?$/)?.[1] || '').toLowerCase();
      if (slug === emailSlug)             c.score += 1.5;
      else if (slug.startsWith(firstLower)) c.score += 0.5;
    }
    rawCandidates.sort((a, b) => b.score - a.score);

    // ── Phase 3: QA top candidates (max 5, or until timeout) ──────────
    const candidateResults = [];
    let bestMatch = null;

    for (const candidate of rawCandidates.slice(0, 5)) {
      if (Date.now() - startTime > INSTANT_TIMEOUT_MS - 800) break;

      let qaResult = { is_verified: false, reason: '', meta_title: '', meta_description: '' };
      try {
        qaResult = await runQaGate(candidate.url, parsed, candidate);
      } catch (err) {
        qaResult.reason = `QA error: ${err.message}`;
      }

      // Build confidence level
      let confidence = 'low';
      if (qaResult.is_verified) confidence = 'high';
      else if (candidate.score >= 3) confidence = 'medium';
      else if (candidate.title && candidate.title.toLowerCase().includes(firstLower)) confidence = 'medium';

      const entry = {
        url: candidate.url,
        confidence,
        verified: qaResult.is_verified,
        score: Math.round(candidate.score * 10) / 10,
        title: qaResult.meta_title || candidate.title || '',
        description: qaResult.meta_description || candidate.description || '',
        reason: qaResult.reason || '',
        source: candidate.source?.method || 'search',
      };

      candidateResults.push(entry);

      if (qaResult.is_verified && !bestMatch) {
        bestMatch = entry;
      }
    }

    // If no QA-verified match, pick the top-scored candidate as "likely" match
    if (!bestMatch && candidateResults.length > 0) {
      const top = candidateResults[0];
      if (top.score >= 3) {
        top.confidence = 'medium';
      }
    }

    const elapsed = Date.now() - startTime;

    return res.status(200).json({
      email: emailLower,
      status: bestMatch ? 'verified' : 'candidates_found',
      linkedin_url: bestMatch?.url || null,
      reason: bestMatch?.reason || candidateResults[0]?.reason || 'No verified match found',
      candidates: candidateResults,
      first_name: parsed.first_name,
      last_name: parsed.last_name,
      company: parsed.legal_company_name,
      elapsed_ms: elapsed,
    });

  } catch (err) {
    return res.status(200).json({
      email: emailLower, status: 'error', linkedin_url: null, candidates: [],
      reason: `Unexpected error: ${err.message}`,
      elapsed_ms: Date.now() - startTime,
    });
  }
}

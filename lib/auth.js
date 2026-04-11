// lib/auth.js — API key authentication helper
// §10.1 — All public endpoints require x-api-key header matching API_SECRET

/**
 * Validate the x-api-key header on an incoming request.
 * @param {Request} req - Vercel/Node IncomingMessage
 * @returns {{ ok: boolean, status?: number, error?: string }}
 */
export function requireApiKey(req) {
  const key = req.headers?.['x-api-key'];
  if (!key) {
    return { ok: false, status: 401, error: 'Missing x-api-key header' };
  }
  if (key !== process.env.API_SECRET) {
    return { ok: false, status: 401, error: 'Invalid API key' };
  }
  return { ok: true };
}

/**
 * Validate Vercel cron secret OR API key (for manual trigger).
 * Vercel sends: Authorization: Bearer <CRON_SECRET>
 * Manual trigger sends: x-api-key: <API_SECRET>
 */
export function requireCronOrApiKey(req) {
  const authHeader = req.headers?.['authorization'];
  if (authHeader === `Bearer ${process.env.CRON_SECRET}`) {
    return { ok: true };
  }
  return requireApiKey(req);
}

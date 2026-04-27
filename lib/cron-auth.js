// lib/cron-auth.js — Vercel cron job authentication helper
//
// Vercel automatically attaches `Authorization: Bearer <CRON_SECRET>` header
// when triggering scheduled cron jobs (per vercel.json crons block).
// See: https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
//
// Usage in cron handlers:
//
//   import { requireCron } from '../lib/cron-auth.js';
//
//   export default async function handler(req, res) {
//     if (!requireCron(req, res)) return;
//     // ... cron logic
//   }
//
// For manual cron triggering (admin backfill), use POST /api/admin/cron-trigger
// which authenticates via requireRole instead.

/**
 * Check whether the request carries a valid Vercel cron secret.
 * Returns boolean (does not write to res).
 */
export function isCronAuthorized(req) {
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  return req.headers.authorization === expected;
}

/**
 * Gate a cron handler.
 * - 500 if CRON_SECRET env var is not configured (deployment misconfiguration)
 * - 401 if Authorization header missing or mismatched
 * - returns true if pass; caller should proceed
 *
 * @param {object} req - request
 * @param {object} res - response (will be written on failure)
 * @returns {boolean} true if authorized, false otherwise
 */
export function requireCron(req, res) {
  if (!process.env.CRON_SECRET) {
    res.status(500).json({ error: 'CRON_SECRET not configured on server' });
    return false;
  }
  if (!isCronAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized: cron secret required' });
    return false;
  }
  return true;
}

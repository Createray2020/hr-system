// api/admin/cron-trigger.js — Manual cron task trigger for HR/admin backfill
//
// Use case: a scheduled cron job did not run (Vercel outage, deploy timing, etc.)
// and HR/admin wants to manually backfill it for a specific date.
//
// Auth: requireRole with BACKOFFICE_ROLES (hr/ceo/chairman/admin).
//
// Body:
//   { "cron_name": "absence-detection", "today": "2026-04-27" }
//
// The "today" field is optional; defaults to today.
//
// Implementation:
//   Reuses the cron handler's default export by invoking it with a synthetic
//   request object carrying CRON_SECRET in the Authorization header. The handler
//   passes its own requireCron gate and runs as if Vercel had triggered it.
//
//   We capture the response by mocking res.status().json() and surface the
//   body back to the admin caller.

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';

const CRON_TASKS = {
  'absence-detection':     () => import('../cron-absence-detection.js'),
  'annual-leave-rollover': () => import('../cron-annual-leave-rollover.js'),
  'comp-expiry-warning':   () => import('../cron-comp-expiry-warning.js'),
  'comp-expiry':           () => import('../cron-comp-expiry.js'),
  'schedule-lock':         () => import('../cron-schedule-lock.js'),
  'schedule-reminder':     () => import('../cron-schedule-reminder.js'),
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const { cron_name, today } = req.body || {};
  if (!cron_name || typeof cron_name !== 'string') {
    return res.status(400).json({ error: 'cron_name required (string)' });
  }
  if (!CRON_TASKS[cron_name]) {
    return res.status(400).json({
      error: `Unknown cron_name "${cron_name}". Valid: ${Object.keys(CRON_TASKS).join(', ')}`,
    });
  }

  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET not configured on server' });
  }

  // Build synthetic req that the cron handler will accept.
  // Uses POST + Authorization header to pass through requireCron gate.
  const syntheticReq = {
    method: 'POST',
    query: today ? { today } : {},
    body: {},
    headers: {
      authorization: `Bearer ${process.env.CRON_SECRET}`,
    },
  };

  // Capture the cron handler's response.
  let capturedStatus = 200;
  let capturedBody = null;
  const syntheticRes = {
    status(code) {
      capturedStatus = code;
      return {
        json(body) {
          capturedBody = body;
          return syntheticRes;
        },
        end() {
          return syntheticRes;
        },
      };
    },
  };

  try {
    const mod = await CRON_TASKS[cron_name]();
    const cronHandler = mod.default;
    if (typeof cronHandler !== 'function') {
      return res.status(500).json({ error: `Cron module "${cron_name}" has no default export` });
    }
    await cronHandler(syntheticReq, syntheticRes);
    return res.status(capturedStatus).json({
      triggered_by: caller.id,
      cron_name,
      today: today || null,
      result: capturedBody,
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Cron handler threw',
      cron_name,
      message: err?.message || String(err),
    });
  }
}

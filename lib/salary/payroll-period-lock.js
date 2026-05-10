// lib/salary/payroll-period-lock.js — cron 自動鎖定薪資期間
//
// 階段 C3:每月 1 號自動 lock 「上個月以前 status='paid'」的 payroll_periods。
//
// 對應 cron entry:api/cron-lock-payroll-period.js
// schedule:每月 1 號 00:00 UTC (台灣 08:00) — 對齊 vercel.json crons "0 0 1 * *"
//
// 規則:
//   - 找 status='paid' 且 (year < currentYear) OR (year=currentYear AND month < currentMonth)
//   - UPDATE status='locked' + locked_at=now
//   - 不誤鎖 draft / calculating / pending_review / approved 等
//   - 已 locked 的不重複動 (eq status='paid' filter)

/**
 * Repo 介面契約:
 *   findPaidPeriodsBefore({ year, month }): Array<{ id, year, month, status }>
 *     回 status='paid' 且 (year < arg.year) OR (year=arg.year AND month < arg.month)
 *   lockPeriod(id): updated row | null
 *     UPDATE status='locked' + locked_at=now,只在 status='paid' 時動 (race condition 防護)
 */
export async function runLockPayrollPeriodSweep(repo, today) {
  requireRepo(repo, ['findPaidPeriodsBefore', 'lockPeriod']);
  if (!today) throw new Error('today required');

  // today 例 '2026-06-01' → 鎖定 (year=2026, month<6) OR (year<2026) 的 paid periods
  const m = today.match(/^(\d{4})-(\d{2})-/);
  if (!m) throw new Error('today must be YYYY-MM-DD');
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);

  const candidates = await repo.findPaidPeriodsBefore({ year, month });
  let locked_count = 0;
  const locked_ids = [];
  for (const p of (candidates || [])) {
    const updated = await repo.lockPeriod(p.id);
    if (updated) {
      locked_count += 1;
      locked_ids.push(p.id);
    }
  }
  return { locked_count, locked_ids, swept_at: today, threshold: { year, month } };
}

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') throw new Error(`repo.${m} is required`);
  }
}

// lib/comp-time/balance.js — 補休餘額查詢與授予(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §4.3.4
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §8.3
//
// 注意:扣減(deductCompTime)、退還(refundCompTime)定義在 lib/leave/balance.js,
// 因為「申請」走 leave_requests + leave_type='comp' 流程,集中在 leave 系統。
// 本檔聚焦「查餘額」+「授予補休」(從加班批准而來,Batch 7 會 call grantCompTime)。

/**
 * Repo 介面契約:
 *   findActiveCompBalances(employee_id): Array<comp_time_balance row>
 *     status='active' 且 expires_at 未過,按 expires_at ASC, earned_at ASC 排序
 *   insertCompBalance(row): inserted row
 *   insertBalanceLog(row): 寫 leave_balance_logs
 */

/**
 * 查員工的補休餘額(only active records)。
 *
 * @returns {{ total_remaining: number, records: Array<{
 *   id, earned_at, expires_at, earned_hours, used_hours, remaining_hours, status,
 *   source_overtime_request_id
 * }> }}
 */
export async function getCompBalance(repo, employee_id) {
  if (!repo || typeof repo.findActiveCompBalances !== 'function') {
    throw new Error('repo.findActiveCompBalances is required');
  }
  if (!employee_id) throw new Error('employee_id required');

  const rows = await repo.findActiveCompBalances(employee_id);
  let total_remaining = 0;
  const records = (rows || []).map(r => {
    const earned    = Number(r.earned_hours);
    const used      = Number(r.used_hours);
    const remaining = Math.max(0, earned - used);
    total_remaining += remaining;
    return {
      id: r.id,
      earned_at:        r.earned_at,
      expires_at:       r.expires_at,
      earned_hours:     earned,
      used_hours:       used,
      remaining_hours:  remaining,
      status:           r.status,
      source_overtime_request_id: r.source_overtime_request_id,
    };
  });
  return { total_remaining, records };
}

/**
 * 授予補休(從加班批准而來,Batch 7 會在 overtime approve 時 call)。
 *
 * @param {Object} repo
 * @param {{
 *   employee_id: string,
 *   hours: number,
 *   source_overtime_request_id: number|string,
 *   earned_at: string,            // ISO timestamp
 *   expires_at?: string,          // 'YYYY-MM-DD' 可選,預設 earned_at + 1 年
 *   changed_by?: string,
 * }} args
 */
export async function grantCompTime(repo, {
  employee_id, hours, source_overtime_request_id, earned_at, expires_at, changed_by,
}) {
  requireRepo(repo, ['insertCompBalance', 'insertBalanceLog']);
  if (!employee_id) throw new Error('employee_id required');
  if (!Number.isFinite(+hours) || +hours <= 0) throw new Error('hours must be positive');
  if (!source_overtime_request_id) throw new Error('source_overtime_request_id required');
  if (!earned_at) throw new Error('earned_at required');

  const expDate = expires_at || addOneYear(earned_at);

  const created = await repo.insertCompBalance({
    employee_id,
    source_overtime_request_id,
    earned_hours: +hours,
    earned_at,
    expires_at: expDate,
    used_hours: 0,
    status: 'active',
  });

  await repo.insertBalanceLog({
    employee_id,
    balance_type: 'comp',
    annual_record_id: null,
    comp_record_id: created?.id ?? null,
    leave_request_id: null,
    change_type: 'grant',
    hours_delta: +hours,
    changed_by: changed_by || employee_id,
    reason: `grant from overtime_request #${source_overtime_request_id}`,
  });

  return created;
}

// ─── helpers ─────────────────────────────────────────────────

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') throw new Error(`repo.${m} is required`);
  }
}

function addOneYear(iso) {
  // 用「日期字串」層級加一年,避免 UTC 轉換造成 ±1 day 時區偏移。
  // earned_at 接受 'YYYY-MM-DD' 或 'YYYY-MM-DDTHH:MM:SS+08:00' 等格式,
  // 統一用前 10 字 'YYYY-MM-DD' 做 year+1。
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${parseInt(m[1]) + 1}-${m[2]}-${m[3]}`;
}

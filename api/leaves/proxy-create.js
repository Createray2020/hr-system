// api/leaves/proxy-create.js
// POST /api/leaves/proxy-create
// body: { employee_id, start_at, end_at, hours, reason }
//   leave_type 固定 'comp'(這支只做補休、其他假別走正規 multi-stage 流程)。
//
// 用途:HR / CEO / chairman / admin 後台代同仁補登「已核准」補休假,立即生效。
//
// 與正規 submitLeaveRequest → approveLeaveRequest 流程的差別:
//   - 正規流:status='pending_mgr' → 主管 → 'pending_ceo' → CEO → 'approved' + deductCompTime
//     餘額不足 → INSUFFICIENT_COMP_BALANCE 擋(預檢 + 扣假時各檢一次)
//   - 本支:status='approved' 直入、manager/ceo/handler 全填 caller、admin_audit_note 標代建
//     **允許負餘額**:現有 active 全 FIFO 扣到 0、shortfall 新建 over-draw record
//     (earned=0、used=shortfall、status='active'、expires_at=請補休日 +1 年)
//     並寫 leave_balance_logs 記錄超額紀錄、HR 可審計
//
// 為何不沿用 deductCompTime?
//   它把 INSUFFICIENT_COMP_BALANCE 當硬擋(預檢 + 扣假時各檢一次),改成 allow_negative 會
//   汙染其他呼叫端(approveLeaveRequest 內部、tests 中的 INSUFFICIENT 行為)。
//   本端只在 endpoint 內自寫 allow-negative FIFO,其他呼叫端不變。
//
// 寫進的 over-draw record 設計理由:
//   - earned=0 / used=shortfall → remaining_hours = -shortfall(GENERATED)
//   - status='active'(不是 fully_used,否則隨 cron 被掃成 expired)
//   - 持續存在於餘額總額計算中,確保總額為負;後續員工取得新補休時,
//     新 record 會被 FIFO 先扣到清零(因為 over-draw expires_at 較晚)
//     ⟶ 自然抵銷;若無新補休則一直負、HR 看 comp-time-admin 看得到

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { makeLeaveRepo } from './_repo.js';

const HOURS_PER_DAY = 8;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const { employee_id, start_at, end_at, hours, reason } = req.body || {};

  // ── 驗證 ─────────────────────────────────────────────────────
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
  if (!start_at || !end_at) {
    return res.status(400).json({ error: 'start_at / end_at required' });
  }
  if (!Number.isFinite(+hours) || +hours <= 0) {
    return res.status(400).json({ error: 'hours must be positive' });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'reason required' });
  }
  if (Date.parse(start_at) >= Date.parse(end_at)) {
    return res.status(400).json({ error: 'start_at must be before end_at' });
  }

  const repo = makeLeaveRepo();

  // 員工存在性檢查
  const emp = await repo.findEmployeeById(employee_id);
  if (!emp) return res.status(400).json({ error: 'employee not found', detail: employee_id });

  try {
    const nowIso = new Date().toISOString();
    const today  = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const startDate = isoDateTaipei(start_at);
    const endDate   = isoDateTaipei(end_at);
    const trimmedReason = String(reason).trim();
    const H = +hours;

    // ── 1. INSERT leave_requests status='approved'(對齊 backfill insertLeave shape)──
    const leaveId = `L${Date.now()}_${employee_id}`;
    const leaveRow = {
      id: leaveId,
      employee_id,
      leave_type: 'comp',
      start_date: startDate,
      end_date:   endDate,
      days: 0,
      hours: H,
      finalized_hours: H,
      start_at, end_at,
      reason: trimmedReason,
      status: 'approved',
      applied_at: nowIso,
      handled_at: nowIso, handled_by: caller.id,
      reviewed_by: caller.id, reviewed_at: nowIso,
      mgr_reviewed_by: caller.id, mgr_reviewed_at: nowIso, mgr_decision: 'approved',
      ceo_reviewed_by: caller.id, ceo_reviewed_at: nowIso, ceo_decision: 'approved',
      late_application: false,
      proof_status: 'not_required',
      admin_audit_note: `[${today}] 後台代建補休 by ${caller.id}`,
    };
    const created = await repo.insertLeaveRequest(leaveRow);

    // ── 2. allow-negative FIFO 扣抵 ────────────────────────────
    const result = await deductCompAllowNegative(repo, {
      employee_id, hours: H,
      leave_request_id: created.id,
      changed_by: caller.id,
      reason: `proxy-create comp leave ${created.id}`,
      audit_date: today,
    });
    if (!result.ok) {
      // 扣抵失敗(lockAndIncrementCompUsedHours 樂觀鎖衝突等)— 假單已建,回 500 帶細節
      return res.status(500).json({
        error: 'comp deduct failed',
        detail: result.reason,
        leave_request: created,
      });
    }

    return res.status(201).json({
      leave_request: created,
      comp_after: {
        total_remaining: result.total_remaining,
        went_negative: result.went_negative,
      },
      deductions: result.deductions,
      over_draw_record_id: result.over_draw_record_id,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ─── helpers ────────────────────────────────────────────────

function isoDateTaipei(iso) {
  // 把 ISO timestamp → Taipei 'YYYY-MM-DD'
  // 任何 +offset 都會經 Date 物件正規化、再用 Asia/Taipei locale 格式化
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

function addOneYearDateStr(dateStr) {
  // 用「日期字串」層級加一年、避免 UTC 轉換 ±1 day 偏移(對齊 lib/comp-time/balance.js addOneYear)
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  return `${parseInt(m[1]) + 1}-${m[2]}-${m[3]}`;
}

/**
 * 允許負餘額的 FIFO 扣抵。
 *
 * 流程:
 *   1. findActiveCompBalances FIFO 排序、逐筆 lockAndIncrementCompUsedHours 扣到 0
 *      每筆都寫 leave_balance_logs(change_type='use', hours_delta=-take)
 *   2. 若 hours 還沒扣完(shortfall > 0):
 *      insertCompBalance 新建一筆 over-draw record(earned=0, used=shortfall, status='active',
 *      earned_at=now, expires_at=audit_date+1y, source_overtime_request_id=null,
 *      admin_audit_note=「超額負餘額」),寫一筆 leave_balance_logs 對應 shortfall
 *
 * @returns {{ ok: boolean, deductions: Array, total_remaining: number, went_negative: boolean,
 *             over_draw_record_id: number|null, reason?: string }}
 */
async function deductCompAllowNegative(repo, {
  employee_id, hours, leave_request_id, changed_by, reason, audit_date,
}) {
  const balances = await repo.findActiveCompBalances(employee_id);
  const totalBefore = (balances || []).reduce(
    (s, b) => s + (Number(b.earned_hours) - Number(b.used_hours)), 0,
  );

  let remaining = +hours;
  const deductions = [];

  // ── 1. 現有 active FIFO 扣到 0 ─────────────────────────────
  for (const b of (balances || [])) {
    if (remaining <= 1e-6) break;
    const avail = Number(b.earned_hours) - Number(b.used_hours);
    if (avail <= 1e-6) continue;
    const take = Math.min(avail, remaining);

    const r = await repo.lockAndIncrementCompUsedHours({
      comp_id: b.id, delta_hours: take, allow_negative: false,
    });
    if (!r.ok) return { ok: false, reason: r.reason || 'LOCK_FAILED' };

    await repo.insertBalanceLog({
      employee_id,
      balance_type: 'comp',
      annual_record_id: null,
      comp_record_id: b.id,
      leave_request_id,
      change_type: 'use',
      hours_delta: -take,
      changed_by,
      reason,
    });
    deductions.push({ comp_id: b.id, hours: take, over_draw: false });
    remaining -= take;
  }

  // ── 2. shortfall → 新建 over-draw record ──────────────────
  let overDrawId = null;
  if (remaining > 1e-6) {
    const shortfall = round2(remaining);
    const nowIso = new Date().toISOString();
    const expiresAt = addOneYearDateStr(audit_date);
    const overRow = {
      employee_id,
      source_overtime_request_id: null,
      earned_hours: 0,
      used_hours: shortfall,
      earned_at: nowIso,
      expires_at: expiresAt,
      status: 'active',
      admin_audit_note: `[${audit_date}] 後台代建補休超額、負餘額 ${shortfall}h(leave_request_id=${leave_request_id})`,
    };
    const created = await repo.insertCompBalance(overRow);
    overDrawId = created?.id || null;

    await repo.insertBalanceLog({
      employee_id,
      balance_type: 'comp',
      annual_record_id: null,
      comp_record_id: overDrawId,
      leave_request_id,
      change_type: 'use',
      hours_delta: -shortfall,
      changed_by,
      reason: `${reason};後台代建補休超額、負餘額`,
    });
    deductions.push({ comp_id: overDrawId, hours: shortfall, over_draw: true });
  }

  const totalAfter = round2(totalBefore - (+hours));
  return {
    ok: true,
    deductions,
    total_remaining: totalAfter,
    went_negative: totalAfter < -1e-6,
    over_draw_record_id: overDrawId,
  };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

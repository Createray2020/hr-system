// api/leaves/index.js
//
// 本檔同時服務兩條路徑：
//   舊路徑（legacy）：employee-leave.html / dashboard.html / calendar.html
//     - GET  ?id=X / ?stats=true / ?status=approved|pending / 清單(含 dept / type / search 篩選)
//     - POST body { employee_id, leave_type, start_date, end_date, days, reason, attachment_url }
//     - PUT  ?id=X body { status: 'approved'|'rejected', handler_note }
//   新路徑(Batch 5+):leave.html (新版) / leave-admin.html / annual-leave-admin.html
//     - GET ?employee_id&year[&month] → 列表
//     - GET ?annual_balance=true&employee_id → 取特休餘額
//     - POST body { start_at, end_at, leave_type, reason } → 走 lib/leave/request-flow.js
//
// 分流訊號:
//   POST: req.body.start_at 存在 → 新邏輯
//   GET:  req.query.annual_balance / (employee_id + year [+ month] 且無 ?id ?stats ?status) → 新邏輯
//
// 既有 vercel.json 的 /api/leaves/:id/review rewrite 已在本批移除。PUT/DELETE 個別 ID
// 走 file-system route → [id].js(規範新路徑)。Legacy PUT ?id=X 仍走本檔(分流保留)。
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.3.2
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §7.6
//
// Routing 假設:同 api/holidays/{[id].js, import.js, index.js} 與
// api/attendance/{[id].js, anomaly.js, index.js} precedent,Vercel 靜態檔名優先 dynamic route。

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth, requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES, canAccessBackoffice } from '../../lib/roles.js';
import { sendPushToEmployees, createNotifications } from '../../lib/push.js';
import { submitLeaveRequest } from '../../lib/leave/request-flow.js';
import { getAnnualBalance } from '../../lib/leave/balance.js';
import { makeLeaveRepo } from './_repo.js';
import { calculateAccumulatingUsage, getCurrentYearInTaipei, ACCUMULATING_LEAVE_CODES } from '../../lib/leave/quota.js';
import { addDeptName, addDeptNameSingle } from '../../lib/dept-name-mapper.js';
import { applyExcludeSystemAccountsQuery } from '../../lib/salary/system-accounts.js';
import { resolveAuthScopeWithDeptIds, makeDeptEmpIdsRepo, canSeeEmployee } from '../../lib/auth-scope.js';
import { attachManagerNames as attachManagerNamesLib } from '../../lib/dept-name-mapper.js';

// Phase 2.x:wrapper 給 leave 列表 row(已 flatten employee 的 dept_id 到 row.dept_id)
// 用、補 employee_dept_id + employee_manager_name(對齊 canReview reviewable shape)。
// helper 抽到 lib/dept-name-mapper.js,給 overtime 等其他模組共用。
const attachManagerNames = (rows) =>
  attachManagerNamesLib(rows, supabaseAdmin, r => r.dept_id);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET leave_types 清單（前端假別下拉用）──────────────────
  // 不需要登入身份；這只是 active leave types 的中繼資料。
  if (req.method === 'GET' && req.query._resource === 'leave_types') {
    // Phase 1.4: SELECT 補 advance_hours / advance_rule / requires_proof / proof_grace_days
    // 給 public/js/utils.js 的 advanceHintText / proofHintText / checkAdvanceClient 用。
    // 純加欄位、無 row-level filter / 業務邏輯改動。
    const { data, error } = await supabaseAdmin
      .from('leave_types')
      .select('code, name_zh, is_paid, has_balance, legal_max_days_per_year, display_order, description, advance_hours, advance_rule, requires_proof, proof_grace_days')
      .eq('is_active', true)
      .order('display_order');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  // ── 新路徑:annual_balance ────────────────────────────────
  if (req.method === 'GET' && req.query.annual_balance === 'true') {
    return handleGetAnnualBalance(req, res);
  }

  // ── 新路徑:quota_summary(假期額度總覽 — 特休 / 補休 / 累積型病事假)──
  if (req.method === 'GET' && req.query._resource === 'quota_summary') {
    return handleQuotaSummary(req, res);
  }

  // ── 新路徑:GET 列表(employee_id + year [+ month])──────
  if (req.method === 'GET' &&
      req.query.employee_id && req.query.year &&
      !req.query.id && !req.query.stats && !req.query.status) {
    return handleNewGet(req, res);
  }

  // ── 新路徑:POST(body 含 start_at)─────────────────────
  if (req.method === 'POST' && req.body && req.body.start_at) {
    return handleNewPost(req, res);
  }

  // ── 以下:legacy 邏輯整段搬自舊 api/leaves.js 不動 ────────
  const { id } = req.query;

  // GET
  if (req.method === 'GET') {
    if (id) {
      // Phase 2:?id=X 加 requireAuth + scope check(原本完全裸奔、任何人能看任何假單)
      const caller = await requireAuth(req, res);
      if (!caller) return;
      const { data: leave, error } = await supabaseAdmin
        .from('leave_requests').select('*').is('deleted_at', null).eq('id', id).single();
      if (error) return res.status(404).json({ error: '找不到假單' });
      const scope = await resolveAuthScopeWithDeptIds(caller, 'selfOrDept', makeDeptEmpIdsRepo(supabaseAdmin));
      if (!canSeeEmployee(scope, leave.employee_id)) {
        return res.status(403).json({ error: 'Forbidden: 無權看此假單' });
      }
      const { data: emp } = await supabaseAdmin
        .from('employees').select('name, dept_id, position, avatar, departments(name)')
        .eq('id', leave.employee_id).single();
      addDeptNameSingle(emp);
      const flat = {
        ...leave,
        emp_name: emp?.name, dept_id: emp?.dept_id, dept_name: emp?.dept_name, position: emp?.position, avatar: emp?.avatar,
      };
      const [withMgr] = await attachManagerNames([flat]);
      return res.status(200).json(withMgr);
    }

    if (req.query.stats === 'true') {
      // Phase 2:?stats=true 加 requireAuth(原本裸奔、不該外洩聚合 count)
      const caller = await requireAuth(req, res);
      if (!caller) return;
      const { data, error } = await supabaseAdmin.from('leave_requests').select('status').is('deleted_at', null);
      if (error) return res.status(500).json({ error: error.message });
      const stats = { pending: 0, approved: 0, rejected: 0, total: data.length };
      data.forEach(r => { if (r.status in stats) stats[r.status]++; });
      return res.status(200).json(stats);
    }

    const { status, dept, dept_id, type, search } = req.query;
    let q = supabaseAdmin.from('leave_requests').select('*').is('deleted_at', null).order('applied_at', { ascending: false });
    if (status) q = q.eq('status',     status);
    if (type)   q = q.eq('leave_type', type);

    // Phase 2:legacy GET list 加 dept-scope filter
    // 既有 canAccessBackoffice 包 is_manager、主管被當 HR 看全公司、漏網。
    // 改用 resolveAuthScope:HR 看全部、主管 dept-scope、員工本人。
    const caller = await requireAuth(req, res);
    if (!caller) return;
    const scope = await resolveAuthScopeWithDeptIds(caller, 'selfOrDept', makeDeptEmpIdsRepo(supabaseAdmin));
    if (scope.mode === 'self') {
      q = q.eq('employee_id', scope.selfId);
    } else if (scope.mode === 'dept') {
      q = q.in('employee_id', [scope.selfId, ...(scope.deptEmpIds || [])]);
    }
    // mode='all' 不加 filter

    const { data: leaves, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!leaves.length) return res.status(200).json([]);

    const empIds = [...new Set(leaves.map(l => l.employee_id))];
    const { data: emps, error: empErr } = await applyExcludeSystemAccountsQuery(
      supabaseAdmin.from('employees').select('id, name, dept_id, position, avatar, departments(name)').in('id', empIds)
    );
    if (empErr) return res.status(500).json({ error: empErr.message });
    addDeptName(emps);

    const empMap = Object.fromEntries(emps.map(e => [e.id, e]));
    let rows = leaves.map(l => {
      const e = empMap[l.employee_id] || {};
      return { ...l, emp_name: e.name, dept_id: e.dept_id, dept_name: e.dept_name, position: e.position, avatar: e.avatar };
    });
    if (dept_id)   rows = rows.filter(r => r.dept_id === dept_id);
    if (search) rows = rows.filter(r => (r.emp_name || '').includes(search));
    rows = await attachManagerNames(rows);
    return res.status(200).json(rows);
  }

  // POST(legacy:start_date/end_date/days)— 已棄用。
  // 此路徑原本無 requireAuth、任何人(含未登入)可猜 employee_id 直接 INSERT 假單;
  // 又沒走 lib/leave/request-flow.js 的合法 stage / 時數重算 / 餘額扣除、寫入即髒資料。
  // 對齊同檔 legacy PUT(下方)的處理 pattern:直接回 410 GONE。
  // 現役前端兩個請假入口(employee-leave.html / leave.html)都送新欄位 start_at、
  // 走上方 handleNewPost(L75);改 410 對任何現役頁面零影響。
  if (req.method === 'POST') {
    return res.status(410).json({
      error: 'GONE',
      message: 'legacy POST /api/leaves(start_date/end_date/days)已棄用。請改用 POST /api/leaves body { start_at, end_at, leave_type, reason } 走 lib/leave/request-flow.js',
    });
  }

  // PUT(legacy 審核)— 已棄用。
  // 此路徑會直接 update status='approved' 但不重算時數、不扣餘額,造成
  // 薪資結算 / 全勤獎金 / 特休餘額計算缺資料。
  // 新路徑請走 PUT /api/leaves/:id body { decision: 'approve'|'reject' }
  // (走 lib/leave/request-flow.js 的 approveLeaveRequest)。
  if (req.method === 'PUT') {
    return res.status(410).json({
      error: 'GONE',
      message: 'legacy PUT /api/leaves?id=X 已棄用。請改用 PUT /api/leaves/:id body { decision }',
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─────────────────────────────────────────────────────────────────
// 新路徑(Batch 5+):用 lib/leave/* + repo 注入
// ─────────────────────────────────────────────────────────────────

async function handleGetAnnualBalance(req, res) {
  // Phase 2:加 requireAuth + scope check(原本完全裸奔、可猜 employee_id 撈他人特休)
  const caller = await requireAuth(req, res);
  if (!caller) return;
  const { employee_id } = req.query;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });

  const scope = await resolveAuthScopeWithDeptIds(caller, 'selfOrDept', makeDeptEmpIdsRepo(supabaseAdmin));
  if (!canSeeEmployee(scope, employee_id)) {
    return res.status(403).json({ error: 'Forbidden: 無權看此員工特休餘額' });
  }

  try {
    const balance = await getAnnualBalance(makeLeaveRepo(), employee_id);
    return res.status(200).json({ balance });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── 假期額度總覽 ────────────────────────────────────────────
// 三條獨立路徑:特休(annual_leave_records 單欄位)/ 補休(comp_time_balance SUM)/
// 累積型病事假(leave_requests SUM)。auth + scope 形狀對齊 handleGetAnnualBalance。
async function handleQuotaSummary(req, res) {
  const caller = await requireAuth(req, res);
  if (!caller) return;
  const { employee_id } = req.query;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });

  const scope = await resolveAuthScopeWithDeptIds(caller, 'selfOrDept', makeDeptEmpIdsRepo(supabaseAdmin));
  if (!canSeeEmployee(scope, employee_id)) {
    return res.status(403).json({ error: 'Forbidden: 無權看此員工假期額度' });
  }

  const year = req.query.year ? Number(req.query.year) : getCurrentYearInTaipei();
  if (!Number.isInteger(year)) return res.status(400).json({ error: 'year must be integer' });

  try {
    const repo = makeLeaveRepo();
    const as_of_date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

    // 1. 特休 — 走既有 getAnnualBalance(讀 annual_leave_records.used_days 單欄位)
    const annualFull = await getAnnualBalance(repo, employee_id);
    const annual = {
      has_record:     annualFull.has_record,
      legal_days:     annualFull.legal_days,
      granted_days:   annualFull.granted_days,
      used_days:      annualFull.used_days,
      remaining_days: annualFull.remaining_days,
      period_start:   annualFull.period_start,
      period_end:     annualFull.period_end,
    };

    // 2. 補休 — findActiveCompBalances 已按 expires_at ASC, earned_at ASC 排
    //   既有摘要欄不動;附帶 records[] 給前端逐筆顯示(leave-admin detail modal 用)。
    //   records 順序 = repo 內建順序(最早到期在前),只含 active(沿用 findActiveCompBalances 範圍)
    //   2026-06-05:JS 浮點減法 round2(69.5-25.13=44.370000000000005 → 44.37)
    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const compBalances = await repo.findActiveCompBalances(employee_id);
    const total_earned_hours = round2((compBalances || []).reduce(
      (s, b) => s + (Number(b.earned_hours) || 0), 0,
    ));
    const total_used_hours = round2((compBalances || []).reduce(
      (s, b) => s + (Number(b.used_hours) || 0), 0,
    ));
    const comp = {
      active_balances_count: (compBalances || []).length,
      total_earned_hours,
      total_used_hours,
      total_remaining_hours: round2(total_earned_hours - total_used_hours),
      earliest_expires_at:   compBalances?.[0]?.expires_at || null,
      records: (compBalances || []).map(b => ({
        id:              b.id,
        earned_at:       b.earned_at,
        earned_hours:    Number(b.earned_hours) || 0,
        expires_at:      b.expires_at,
        used_hours:      Number(b.used_hours) || 0,
        remaining_hours: round2(Number(b.remaining_hours) || 0),
        status:          b.status,
      })),
    };

    // 3. 累積型(病/事假)— 走 calculateAccumulatingUsage + 接 leave_types meta
    const usage = await calculateAccumulatingUsage(repo, {
      employee_id, year, codes: ACCUMULATING_LEAVE_CODES,
    });
    const { data: typesInfo, error: typesErr } = await supabaseAdmin
      .from('leave_types')
      .select('code, name_zh, legal_max_days_per_year')
      .in('code', ACCUMULATING_LEAVE_CODES);
    if (typesErr) throw typesErr;
    const typeMap = Object.fromEntries((typesInfo || []).map(t => [t.code, t]));

    const accumulating = usage.map((u) => {
      const t = typeMap[u.code] || {};
      const legal_max_days = t.legal_max_days_per_year != null
        ? Number(t.legal_max_days_per_year)
        : null;
      const remaining_days = legal_max_days != null
        ? legal_max_days - u.used_days   // 負值不 clamp、暴露 over-limit
        : null;
      const is_over_limit = legal_max_days != null
        ? u.used_days > legal_max_days
        : false;
      return {
        code:           u.code,
        name_zh:        t.name_zh || null,
        legal_max_days,
        used_days:      u.used_days,
        used_count:     u.used_count,
        remaining_days,
        is_over_limit,
      };
    });

    return res.status(200).json({
      employee_id,
      year,
      as_of_date,
      annual,
      comp,
      accumulating,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function handleNewGet(req, res) {
  // Phase 2:加 requireAuth + scope check(原本完全裸奔、可猜 employee_id 撈他人假單)
  const caller = await requireAuth(req, res);
  if (!caller) return;

  const { employee_id, year, month } = req.query;
  const y = parseInt(year);
  if (!Number.isInteger(y)) return res.status(400).json({ error: 'invalid year' });

  // 顯式帶 employee_id 才檢 scope;沒帶就走 caller 自身視角
  const scope = await resolveAuthScopeWithDeptIds(caller, 'selfOrDept', makeDeptEmpIdsRepo(supabaseAdmin));
  if (employee_id) {
    if (!canSeeEmployee(scope, employee_id)) {
      return res.status(403).json({ error: 'Forbidden: 無權看此員工假單' });
    }
  }

  let q = supabaseAdmin.from('leave_requests').select('*')
    .is('deleted_at', null)
    .order('start_at', { ascending: false });

  if (employee_id) {
    q = q.eq('employee_id', employee_id);
  } else if (scope.mode === 'self') {
    q = q.eq('employee_id', scope.selfId);
  } else if (scope.mode === 'dept') {
    q = q.in('employee_id', [scope.selfId, ...(scope.deptEmpIds || [])]);
  }
  // mode='all' + 沒帶 employee_id → 不加 filter、HR 看全公司

  // 用 start_at 範圍篩選(新欄位)
  const yearStart = `${y}-01-01T00:00:00+08:00`;
  const yearEnd   = `${y}-12-31T23:59:59+08:00`;
  q = q.gte('start_at', yearStart).lte('start_at', yearEnd);

  if (month) {
    const m = parseInt(month);
    if (Number.isInteger(m) && m >= 1 && m <= 12) {
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      q = q.gte('start_at', `${y}-${String(m).padStart(2,'0')}-01T00:00:00+08:00`)
           .lte('start_at', `${y}-${String(m).padStart(2,'0')}-${lastDay}T23:59:59+08:00`);
    }
  }

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ requests: data || [] });
}

async function handleNewPost(req, res) {
  // 員工自己提交假單(本人提自己的);HR/主管可代提別人的(管理者場景)
  const caller = await requireAuth(req, res);
  if (!caller) return;

  const {
    leave_type, start_at, end_at, reason,
    late_reason,                            // Phase 1.3a: soft late 時必填
    attachment_url, attachment_name,
  } = req.body;
  const target_employee_id = req.body.employee_id || caller.id;
  if (!target_employee_id) return res.status(400).json({ error: 'employee_id required' });

  // 代提權限檢查:若 target 不是 caller 本人,必須是 backoffice role 或 is_manager。
  if (target_employee_id !== caller.id) {
    const isBackoffice = ['hr','ceo','chairman','admin'].includes(caller.role);
    if (!isBackoffice && caller.is_manager !== true) {
      return res.status(403).json({ error: 'Forbidden: 只能提交自己的假單' });
    }
  }

  if (!leave_type || !start_at || !end_at) {
    return res.status(400).json({ error: 'leave_type / start_at / end_at required' });
  }

  try {
    const r = await submitLeaveRequest(makeLeaveRepo(), {
      employee_id: target_employee_id, leave_type, start_at, end_at, reason,
      late_reason,
      attachment_url, attachment_name,
    });
    // r.ok=false 時 r 已含 reason / advance_hours / gap_hours / requested_hours / remaining 等
    // 前端依 reason 決定 UX(ADVANCE_TIME_NOT_MET / LATE_REASON_REQUIRED / INSUFFICIENT_BALANCE 等)
    if (!r.ok) return res.status(400).json(r);
    return res.status(201).json({ ok: true, request: r.request });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

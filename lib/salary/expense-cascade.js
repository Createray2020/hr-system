// lib/salary/expense-cascade.js
// Phase 4a:核准 expense_reimbursement(最後一步 completed)後,cascade 寫一筆進
// salary_expense_entries,依 settlement_mode 做兩段式結算。
//
// target 來源(2 條路):
//   階段 C(優先):form_data.target_period('YYYY-MM')→ 員工請款時選的歸屬月
//     - 該月 unsettled / null  → 寫 entry + recompute(主要 happy path)
//     - 該月 approved + ceo/chairman + settlement_mode='force' → 外科 UPDATE(保留主管強制路徑)
//     - 該月 approved + 非 force → 寫 entry active、留在該月、不 roll、不動 sr;
//       reflect 回 PENDING_HR_MERGE、audit「待 HR 重算併入」
//     - 該月 paid / locked → entry 仍寫入(避免遺失)、reflect PERIOD_LOCKED audit;
//       理論上前端下拉已排除、屬防呆
//   舊路徑(無 target_period 時相容):inferNextPayrollPeriod(completed_at)→ 隔月
//     行為與 Phase 4a / 6a 完全一致(下方 if-else if-else 三分支)。
//
// best-effort:全程 try/catch、失敗只 console.error + prepend approval_requests.admin_audit_note
//             不擋 approval status='completed'(對齊 applyPunchCorrection / applyResignation 風格)

import { supabaseAdmin } from '../supabase.js';
import { calculateWithholding, getWithholdingDefaults } from './tax-withholding.js';
import { isExecutiveRole } from '../roles.js';
import { calculateMonthlySalary } from './calculator.js';
import { makeSalaryRepo } from '../../api/salary/_repo.js';

// ─── 純函式 export(給測試直接驗)──────────────────────────────

/**
 * 把 'YYYY-MM-DD' 推到隔月(m===12 跨年)
 * @param {string} baseDateStr - 任意 ISO date 字串,前 10 字 'YYYY-MM-DD'
 * @returns {{ year: number, month: number }}
 */
export function inferNextPayrollPeriod(baseDateStr) {
  const m10 = String(baseDateStr || '').slice(0, 10);
  const [yStr, mStr] = m10.split('-');
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  const nextYear = m === 12 ? y + 1 : y;
  const nextMonth = m === 12 ? 1 : m + 1;
  return { year: nextYear, month: nextMonth };
}

export function isSettledStatus(status) {
  return ['approved', 'paid', 'locked'].includes(status);
}

export function isUnsettledStatus(status) {
  return ['draft', 'calculating', 'pending_review'].includes(status);
}

/**
 * 階段 C:解析 form_data.target_period('YYYY-MM' 字串)為 {year, month}。
 * 格式錯 / 空 / null / 越界 → null,caller 回退 inferNextPayrollPeriod(completed_at)。
 * @param {string|null|undefined} s
 * @returns {{ year: number, month: number } | null}
 */
export function parseTargetPeriod(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (!Number.isInteger(year) || year < 1900 || year > 2999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

// ─── reflectExpenseEntriesToSalary(Phase 6a 抽出 — applyExpenseReimbursement + 管理頁共用)─
//
// 從 salary_expense_entries 子表 re-sum,把該員當期(active、未刪)entries 加總後
// 反映進 salary_records 的 3 個 _auto 欄(expense_reimbursement_total/_taxable/_note)
// + taxable_income_snapshot 修正 + deduct_tax 重算(若非 manual_override)。
//
// 行為依 payroll_period 狀態分支:
//   未結算(null / draft / calculating / pending_review):
//     若 salary_records 存在且 unsettled → calculateMonthlySalary 全重算(子表自然吃進)
//     若不存在 → action='entry_only'(留 batch 帶入)
//   approved:
//     需要 force=true + caller 為 executive,否則 NEEDS_FORCE / NEEDS_EXECUTIVE
//     sr 不存在 → NO_SALARY_RECORD(caller 退回 defer)
//     否則外科 UPDATE,把舊 expense 應稅貢獻換成 re-sum 的新值
//   paid / locked:PERIOD_LOCKED
//
// Phase 6a 一併修兩個 Phase 4a 的 bug:
//   1. 稅金重算不再限 deltaTaxable>0:re-sum 版本一律(非 manual_override 時)按
//      newTaxableSnap 重算 deduct_tax,作廢/減少也會正確降稅。
//   2. newTaxableSnap 用 Math.max(0, ...) clamp;newExpTotal/newExpTaxable 為非負金額
//      加總,天然 >=0。
//
// helper 可拋(DB 錯誤、calculator 失敗等),由 caller 接 audit。
//
// @returns {{ ok: true,  action: 'recomputed' | 'entry_only' | 'surgical' }}
//        | {{ ok: false, reason: 'NEEDS_FORCE' | 'NEEDS_EXECUTIVE' | 'NO_SALARY_RECORD' | 'PERIOD_LOCKED' | 'PENDING_HR_MERGE' }}
//
// 階段 C 新參數 allowPendingMergeOnApproved:
//   true 時、若 status='approved' 且 caller 非 force/executive → 回 PENDING_HR_MERGE
//   (entry 留在該月、待 HR 重開重算自然併入;不偷改已核准數字、不往後 roll)。
//   false(預設、向後相容)→ 沿用 NEEDS_FORCE / NEEDS_EXECUTIVE 既有語意。
export async function reflectExpenseEntriesToSalary({
  employee_id, year, month, force, callerId, callerRole, auditLabel,
  allowPendingMergeOnApproved = false,
}) {
  const mm = pad2(month);
  const recordId = `S_${employee_id}_${year}_${mm}`;

  // b. 撈期間 status(不存在視為未結算、對齊 cascade 自動建 draft 行為)
  const { data: period } = await supabaseAdmin
    .from('payroll_periods').select('status')
    .eq('id', `PP_${year}_${mm}`).maybeSingle();
  const periodStatus = period?.status || null;

  // c. 從子表 re-sum(SoT)
  const { data: entryRows } = await supabaseAdmin
    .from('salary_expense_entries')
    .select('amount, is_taxable_snapshot, category_name_snapshot')
    .eq('employee_id', employee_id)
    .eq('target_year', year)
    .eq('target_month', month)
    .eq('status', 'active')
    .is('deleted_at', null);
  let newExpTotal = 0;
  let newExpTaxable = 0;
  const noteParts = [];
  for (const r of (entryRows || [])) {
    const amt = round2(Number(r.amount) || 0);
    newExpTotal = round2(newExpTotal + amt);
    if (r.is_taxable_snapshot) newExpTaxable = round2(newExpTaxable + amt);
    noteParts.push(`${r.category_name_snapshot || '未分類'} NT$${amt}`);
  }
  const newNote = noteParts.length ? noteParts.join('\n') : null;

  // d. 分支
  if (periodStatus === null || isUnsettledStatus(periodStatus)) {
    const { data: srSummary } = await supabaseAdmin
      .from('salary_records').select('id, status').eq('id', recordId).maybeSingle();
    if (srSummary && isUnsettledStatus(srSummary.status)) {
      // 走 calculator 全重算(Step 12.5 從子表 reduce、自然帶入)
      const repo = makeSalaryRepo();
      await calculateMonthlySalary(repo, {
        employee_id, year, month, callerId: callerId || null,
      });
      return { ok: true, action: 'recomputed' };
    }
    // sr 不存在:留 batch 帶
    return { ok: true, action: 'entry_only' };
  }

  if (periodStatus === 'approved') {
    // 階段 C:caller 明確指定 target=該月 且非 force-executive → 留在該月、待 HR 重算併入
    const wantForceExecutive = !!(force && isExecutiveRole(callerRole));
    if (!wantForceExecutive && allowPendingMergeOnApproved) {
      return { ok: false, reason: 'PENDING_HR_MERGE' };
    }
    if (!force) return { ok: false, reason: 'NEEDS_FORCE' };
    if (!isExecutiveRole(callerRole)) return { ok: false, reason: 'NEEDS_EXECUTIVE' };

    const { data: sr } = await supabaseAdmin
      .from('salary_records').select(
        'id, taxable_income_snapshot, expense_reimbursement_taxable, deduct_tax_manual_override, admin_audit_note'
      ).eq('id', recordId).maybeSingle();
    if (!sr) return { ok: false, reason: 'NO_SALARY_RECORD' };

    // 把舊 expense 應稅貢獻換成新的 re-sum(避免重複加 / 漏減)
    const oldExpTaxable  = Number(sr.expense_reimbursement_taxable) || 0;
    const oldTaxableSnap = Number(sr.taxable_income_snapshot)       || 0;
    const newTaxableSnap = Math.max(
      0,
      round2(oldTaxableSnap - oldExpTaxable + newExpTaxable),
    );

    const patch = {
      expense_reimbursement_total:   newExpTotal,
      expense_reimbursement_taxable: newExpTaxable,
      expense_reimbursement_note:    newNote,
      taxable_income_snapshot:       newTaxableSnap,
      updated_at: nowIso(),
    };

    if (!sr.deduct_tax_manual_override) {
      // Bug fix:re-sum 版本一律重算稅(非 manual_override 時),作廢/減少也會正確降稅
      const { data: ins } = await supabaseAdmin
        .from('insurance_settings').select('health_ins_dependents, has_insurance')
        .eq('employee_id', employee_id).maybeSingle();
      const hasInsurance = !!(ins && ins.has_insurance !== false);
      const dependentCount = hasInsurance ? Number(ins?.health_ins_dependents) || 0 : 0;
      patch.deduct_tax = calculateWithholding({
        monthlyPayment: newTaxableSnap,
        dependentCount,
        method: 'formula',
        formulaParams: getWithholdingDefaults(year),
      });
    }

    patch.admin_audit_note = sr.admin_audit_note
      ? `${auditLabel}\n${sr.admin_audit_note}`
      : auditLabel;

    const { error: updErr } = await supabaseAdmin
      .from('salary_records').update(patch).eq('id', recordId);
    if (updErr) throw updErr;

    return { ok: true, action: 'surgical' };
  }

  // paid / locked
  return { ok: false, reason: 'PERIOD_LOCKED' };
}

// ─── 內部 helpers ─────────────────────────────────────────────

function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function pad2(n) { return String(n).padStart(2, '0'); }

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function nowIso() { return new Date().toISOString(); }

/**
 * 查或建 payroll_period(race-safe:INSERT 23505 → 重 select)
 * @returns {{ id: string, status: string }}
 */
async function getOrCreatePayrollPeriod(year, month, callerId) {
  const id = `PP_${year}_${pad2(month)}`;
  // 先查
  const { data: existing } = await supabaseAdmin
    .from('payroll_periods').select('id, status')
    .eq('year', year).eq('month', month).maybeSingle();
  if (existing) return { id: existing.id, status: existing.status };

  // 不存在 → INSERT draft
  const periodStart = `${year}-${pad2(month)}-01`;
  const periodEnd   = `${year}-${pad2(month)}-${pad2(lastDayOfMonth(year, month))}`;
  const { error } = await supabaseAdmin.from('payroll_periods').insert([{
    id, year, month,
    period_start: periodStart,
    period_end:   periodEnd,
    status: 'draft',
    created_by: callerId || null,
  }]);
  if (error) {
    // race:同時被別處建出 → 重 select
    if (error.code === '23505') {
      const { data: again } = await supabaseAdmin
        .from('payroll_periods').select('id, status')
        .eq('year', year).eq('month', month).maybeSingle();
      if (again) return { id: again.id, status: again.status };
    }
    throw error;
  }
  return { id, status: 'draft' };
}

/**
 * 從 (startYear, startMonth) 起逐月找到第一個未結算的 payroll_period(最多 24 個月防呆)。
 * getOrCreatePayrollPeriod 不存在的月會建 draft → 一定找得到。
 * @returns {{ year, month, id, status }}
 */
async function findNextUnsettledPeriod(startYear, startMonth, callerId) {
  let y = startYear, m = startMonth;
  for (let i = 0; i < 24; i++) {
    const p = await getOrCreatePayrollPeriod(y, m, callerId);
    if (isUnsettledStatus(p.status)) return { year: y, month: m, ...p };
    // 下一月
    if (m === 12) { y += 1; m = 1; } else { m += 1; }
  }
  // 24 個月內全 settled(理論上不會發生 — draft 永遠是新月預設)→ 退而用最後一個查到的
  return { year: y, month: m, id: `PP_${y}_${pad2(m)}`, status: 'unknown' };
}

/**
 * 解析類別:by id → by name → 保守預設(is_taxable=true、name fallback)
 * @returns {{ id: string|null, name: string, is_wage: boolean, is_taxable: boolean, defaulted?: boolean }}
 */
async function resolveCategory(form_data) {
  const fd = form_data || {};
  if (fd.expense_category_id) {
    const { data } = await supabaseAdmin
      .from('expense_categories')
      .select('id, name, is_wage, is_taxable')
      .eq('id', fd.expense_category_id).maybeSingle();
    if (data) {
      return { id: data.id, name: data.name, is_wage: !!data.is_wage, is_taxable: !!data.is_taxable };
    }
  }
  if (fd.expense_category) {
    const { data } = await supabaseAdmin
      .from('expense_categories')
      .select('id, name, is_wage, is_taxable')
      .eq('name', fd.expense_category).eq('is_active', true).maybeSingle();
    if (data) {
      return { id: data.id, name: data.name, is_wage: !!data.is_wage, is_taxable: !!data.is_taxable };
    }
  }
  // 保守預設:is_taxable=true(計稅、避免漏稅);is_wage=false(不進保費基底);
  // name fallback 為 form_data.expense_category 字串(若有),不然 '其他'。
  // defaulted 旗標讓 caller note 標記。
  return {
    id: null,
    name: fd.expense_category || '其他',
    is_wage: false,
    is_taxable: true,
    defaulted: true,
  };
}

/**
 * Prepend audit line into approval_requests.admin_audit_note(best-effort、失敗只 log)
 */
async function appendApprovalAudit(requestId, line) {
  try {
    const { data: cur } = await supabaseAdmin
      .from('approval_requests').select('admin_audit_note').eq('id', requestId).maybeSingle();
    const next = cur?.admin_audit_note ? `${line}\n${cur.admin_audit_note}` : line;
    await supabaseAdmin.from('approval_requests')
      .update({ admin_audit_note: next, updated_at: nowIso() })
      .eq('id', requestId);
  } catch (e) {
    console.error('[applyExpenseReimbursement] appendApprovalAudit failed:', e.message);
  }
}

// ─── 主 cascade ───────────────────────────────────────────────

/**
 * 核准 expense_reimbursement(整張單 completed)cascade。
 * best-effort:全程 try/catch、失敗 audit + 不 throw、不擋 approval status。
 *
 * @param {Object} request - approval_requests row(含 form_data / applicant_id / id / completed_at)
 * @param {{ id: string, role: string }} caller - 觸發核准的人
 * @param {'defer'|'force'|undefined} settlementMode - 前端帶來的結算模式
 */
export async function applyExpenseReimbursement(request, caller, settlementMode) {
  try {
    const fd = request?.form_data || {};

    // a. amount
    const amount = round2(Number(fd.amount) || 0);
    if (amount <= 0) {
      console.warn('[applyExpenseReimbursement] amount<=0, skip',
        { request_id: request?.id, amount });
      return;
    }

    // b. employee_id
    const employee_id = request?.applicant_id;
    if (!employee_id) {
      console.warn('[applyExpenseReimbursement] missing applicant_id, skip',
        { request_id: request?.id });
      return;
    }

    // c. category
    const cat = await resolveCategory(fd);

    // d. 解析 target — 階段 C 優先 form_data.target_period;格式錯則退回 inferNext
    const explicitTarget = parseTargetPeriod(fd.target_period);
    const wantForce = settlementMode === 'force' && isExecutiveRole(caller?.role);

    let tgYear, tgMonth, mode, deferred_from = null;
    let routingReason = null;   // 寫進 entry.note 給 audit

    if (explicitTarget) {
      // 階段 C 路徑:員工自選歸屬月
      tgYear = explicitTarget.year;
      tgMonth = explicitTarget.month;
      const tgPeriod = await getOrCreatePayrollPeriod(tgYear, tgMonth, caller?.id);

      if (tgPeriod.status === 'approved' && wantForce) {
        // 主管強制併入 approved 期間(沿用既有 surgical)
        mode = 'force';
        routingReason = `主管 force 併入已核准期間 ${tgYear}-${pad2(tgMonth)}`;
      } else if (tgPeriod.status === 'approved') {
        // 預設行為:留在該月、不偷改 sr、不往後 roll;reflect → PENDING_HR_MERGE
        mode = 'defer';
        routingReason = `期間 ${tgYear}-${pad2(tgMonth)} 已核准、entry 已建立、待 HR 重算併入`;
      } else if (tgPeriod.status === 'paid' || tgPeriod.status === 'locked') {
        // 防呆:前端下拉理應排除;若仍指到,entry 仍寫入、reflect 會 PERIOD_LOCKED + audit
        mode = 'defer';
        routingReason = `期間 ${tgYear}-${pad2(tgMonth)} 已 ${tgPeriod.status}(理應前端阻擋、寫入待 HR 處置)`;
      } else {
        // null / draft / calculating / pending_review → 進該月、recompute
        mode = 'defer';
      }
    } else {
      // 舊路徑(回歸保護):inferNextPayrollPeriod(completed_at)
      const baseDate = (request?.completed_at || nowIso()).slice(0, 10);
      const nat = inferNextPayrollPeriod(baseDate);
      const natPeriod = await getOrCreatePayrollPeriod(nat.year, nat.month, caller?.id);

      if (isUnsettledStatus(natPeriod.status)) {
        // 隔月未結算:直接寫 + recompute
        tgYear = nat.year; tgMonth = nat.month;
        mode = 'defer';
      } else if (wantForce && natPeriod.status === 'approved') {
        // executive 強制併進 approved 期間(外科)
        tgYear = nat.year; tgMonth = nat.month;
        mode = 'force';
      } else {
        // 已結算且不能 / 不想 force:往後找下一個未結算
        const next = await findNextUnsettledPeriod(nat.year, nat.month, caller?.id);
        tgYear = next.year; tgMonth = next.month;
        mode = 'defer';
        deferred_from = `${nat.year}-${pad2(nat.month)}`;
        if (settlementMode === 'force' && !isExecutiveRole(caller?.role)) {
          routingReason = `force 被忽略(caller=${caller?.role || '?'} 非 executive)`;
        } else if (settlementMode === 'force' && natPeriod.status !== 'approved') {
          routingReason = `force 不適用 status=${natPeriod.status}、退回遞延`;
        } else {
          routingReason = `原月 ${deferred_from} status=${natPeriod.status} 已結算、遞延`;
        }
      }
    }

    // f. INSERT salary_expense_entries(冪等:撞 uq_see_approval_active → skip)
    const tgMM = pad2(tgMonth);
    const noteLines = [];
    if (deferred_from) noteLines.push(`遞延自 ${deferred_from}`);
    if (routingReason) noteLines.push(routingReason);
    if (cat.defaulted)  noteLines.push(`類別預設(無匹配:${fd.expense_category || '未填'})`);
    const entryNote = noteLines.length ? noteLines.join(';') : null;

    const entryRow = {
      id: `SEE_${Date.now()}`,
      approval_request_id: request.id,
      employee_id,
      salary_record_id: `S_${employee_id}_${tgYear}_${tgMM}`,
      target_year:  tgYear,
      target_month: tgMonth,
      category_id:  cat.id,
      category_name_snapshot: cat.name,
      is_wage_snapshot:    cat.is_wage,
      is_taxable_snapshot: cat.is_taxable,
      amount,
      expense_date: fd.expense_date || null,
      description: fd.description || null,
      settlement_mode: mode,
      deferred_from,
      status: 'active',
      note: entryNote,
      created_by: caller?.id || null,
    };

    const { error: insErr } = await supabaseAdmin
      .from('salary_expense_entries').insert([entryRow]);
    if (insErr) {
      // uq_see_approval_active 防同一張單重複入帳
      if (insErr.code === '23505') {
        console.warn('[applyExpenseReimbursement] entry already exists (idempotent skip)',
          { request_id: request.id });
        return;
      }
      throw insErr;
    }

    // g. 反映到薪資 — Phase 6a 改用共用 helper(子表 re-sum、SoT、支援作廢/減少)
    const auditLabel = `[FORCE 併薪 ${nowIso()}] +${cat.name} NT$${amount}(核准單 ${request.id})`;
    try {
      const res = await reflectExpenseEntriesToSalary({
        employee_id,
        year:  tgYear,
        month: tgMonth,
        force: mode === 'force',
        callerId:   caller?.id   || null,
        callerRole: caller?.role || null,
        auditLabel,
        // 階段 C:當 caller 用 explicit target_period 時,允許 approved 期間留 entry 待 HR 併入
        allowPendingMergeOnApproved: !!explicitTarget,
      });

      // force 目標無 salary_records → 退回 defer 邏輯(沿用 Phase 4a 原 fallback)
      if (!res.ok && res.reason === 'NO_SALARY_RECORD' && mode === 'force') {
        const recordId = `S_${employee_id}_${tgYear}_${tgMM}`;
        console.warn('[applyExpenseReimbursement] force 目標無 salary_records → 退回 defer',
          { record_id: recordId });
        await appendApprovalAudit(request.id,
          `[併薪 force 退回 ${nowIso()}] ${recordId} 不存在、改走遞延`);
        await supabaseAdmin.from('salary_expense_entries')
          .update({
            settlement_mode: 'defer',
            deferred_from: `${tgYear}-${tgMM}`,
            note: [entryNote, 'force 退回:目標期間無 salary_records'].filter(Boolean).join(';'),
            updated_at: nowIso(),
          })
          .eq('approval_request_id', request.id).eq('status', 'active');
        return;
      }

      // 階段 C:PENDING_HR_MERGE — entry 留在 approved 期間、不算錯、寫專屬 audit
      if (!res.ok && res.reason === 'PENDING_HR_MERGE') {
        await appendApprovalAudit(request.id,
          `[併薪 待 HR 併入 ${nowIso()}] PENDING_HR_MERGE — 期間 ${tgYear}-${tgMM} 已核准、員工指定歸屬;entry 已建立、待 HR 重算併入`);
        return;
      }

      // 其他 res.ok=false 情境(NEEDS_*, PERIOD_LOCKED)— 路由層理論上已避免,若漏接只 audit log
      if (!res.ok) {
        console.warn('[applyExpenseReimbursement] reflect non-ok',
          { reason: res.reason, employee_id, year: tgYear, month: tgMonth });
        await appendApprovalAudit(request.id,
          `[併薪 reflect 略過 ${nowIso()}] ${res.reason}(entry 已寫、後續 batch 仍會帶入)`);
        return;
      }
    } catch (e) {
      // helper 拋錯(calculator 失敗 / DB 異常)— 失敗只 audit、不擋 approval、entry 已寫
      console.error('[applyExpenseReimbursement] reflect threw',
        { request_id: request.id, employee_id, year: tgYear, month: tgMonth, err: e.message });
      await appendApprovalAudit(request.id,
        `[併薪 recompute 失敗 ${nowIso()}] ${e.message}(entry 已寫、批次仍會帶入)`);
    }
  } catch (e) {
    console.error('[applyExpenseReimbursement] failed', {
      request_id: request?.id, err: e.message,
    });
    if (request?.id) {
      await appendApprovalAudit(request.id,
        `[併薪失敗 ${nowIso()}] ${e.message}`);
    }
    // best-effort:不 throw、不擋 approval
  }
}

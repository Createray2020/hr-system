// lib/salary/expense-cascade.js
// Phase 4a:核准 expense_reimbursement(最後一步 completed)後,cascade 寫一筆進
// salary_expense_entries(target = 推算隔月),依 settlement_mode 做兩段式結算:
//
//   defer:目標期間未結算(draft/calculating/pending_review)→ 寫 entry + 重算該月
//         目標期間已結算(approved/paid/locked)→ 往後滾到下一個未結算、deferred_from 記原月
//   force:目標期間 approved + caller 是 executive → 外科 UPDATE salary_records 4 欄 +
//         deduct_tax(若非 manual)、不 full recompute、[FORCE] 標 admin_audit_note
//         paid/locked / 非 executive → 退回 defer 邏輯
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

    // d. infer next month
    const baseDate = (request?.completed_at || nowIso()).slice(0, 10);
    const nat = inferNextPayrollPeriod(baseDate);

    // e. 期間決策
    const natPeriod = await getOrCreatePayrollPeriod(nat.year, nat.month, caller?.id);
    const wantForce = settlementMode === 'force' && isExecutiveRole(caller?.role);

    let tgYear, tgMonth, mode, deferred_from = null;
    let routingReason = null;   // 寫進 entry.note 給 audit

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

    // g. 反映到薪資
    if (mode === 'defer') {
      // 目標月為 unsettled:若 salary_records 已存在且 unsettled → 觸發單員工 recompute
      const recordId = `S_${employee_id}_${tgYear}_${tgMM}`;
      const { data: srExisting } = await supabaseAdmin
        .from('salary_records').select('id, status').eq('id', recordId).maybeSingle();
      if (srExisting && isUnsettledStatus(srExisting.status)) {
        try {
          const repo = makeSalaryRepo();
          await calculateMonthlySalary(repo, {
            employee_id,
            year:  tgYear,
            month: tgMonth,
            callerId: caller?.id || null,
          });
        } catch (e) {
          // recompute 失敗 → audit 留紀錄、但 entry 已寫、defer 後續 batch 仍可吃
          console.error('[applyExpenseReimbursement] defer recompute failed',
            { record_id: recordId, err: e.message });
          await appendApprovalAudit(request.id,
            `[併薪 recompute 失敗 ${nowIso()}] ${e.message}(entry 已寫、批次仍會帶入)`);
        }
      }
      // 不存在 → 該月 batch 跑時自然會帶入,此處不動
      return;
    }

    if (mode === 'force') {
      // approved 期間外科 UPDATE:不 full recompute、只動 4 欄(+ deduct_tax 若非 manual)
      const recordId = `S_${employee_id}_${tgYear}_${tgMM}`;
      const { data: sr } = await supabaseAdmin
        .from('salary_records').select(
          'id, status, taxable_income_snapshot, deduct_tax, deduct_tax_manual_override, ' +
          'expense_reimbursement_total, expense_reimbursement_taxable, expense_reimbursement_note, admin_audit_note'
        ).eq('id', recordId).maybeSingle();

      if (!sr) {
        // approved 期間竟無記錄 → 退回 defer 處理:重新呼叫自己一次帶 settlementMode='defer'
        console.warn('[applyExpenseReimbursement] force 目標無 salary_records → 退回 defer',
          { record_id: recordId });
        await appendApprovalAudit(request.id,
          `[併薪 force 退回 ${nowIso()}] ${recordId} 不存在、改走遞延`);
        // 把 entry 改 defer + deferred_from(idempotent skip 路徑會擋自呼叫的重複 insert)
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

      const oldTotal      = Number(sr.expense_reimbursement_total)   || 0;
      const oldExpTaxable = Number(sr.expense_reimbursement_taxable) || 0;
      const oldTaxable    = Number(sr.taxable_income_snapshot)       || 0;
      const oldTax        = Number(sr.deduct_tax)                    || 0;
      const oldNote       = sr.expense_reimbursement_note;
      const taxOverride   = sr.deduct_tax_manual_override === true;

      const deltaTotal   = amount;
      const deltaTaxable = cat.is_taxable ? amount : 0;

      const newTotal       = round2(oldTotal + deltaTotal);
      const newExpTaxable  = round2(oldExpTaxable + deltaTaxable);
      const newTaxableSnap = round2(oldTaxable + deltaTaxable);
      const newNote = [oldNote, `${cat.name} NT$${amount}`].filter(Boolean).join('\n');

      const patch = {
        expense_reimbursement_total:   newTotal,
        expense_reimbursement_taxable: newExpTaxable,
        expense_reimbursement_note:    newNote,
        taxable_income_snapshot:       newTaxableSnap,
        updated_at: nowIso(),
      };

      if (!taxOverride && deltaTaxable > 0) {
        // 從 insurance_settings 撈眷屬數(對齊 calculator Step 13.5)
        const { data: ins } = await supabaseAdmin
          .from('insurance_settings').select('health_ins_dependents, has_insurance')
          .eq('employee_id', employee_id).maybeSingle();
        const hasInsurance = !!(ins && ins.has_insurance !== false);
        const dependentCount = hasInsurance ? Number(ins?.health_ins_dependents) || 0 : 0;
        const newTax = calculateWithholding({
          monthlyPayment: newTaxableSnap,
          dependentCount,
          method: 'formula',
          formulaParams: getWithholdingDefaults(tgYear),
        });
        patch.deduct_tax = newTax;
      }

      // audit:prepend admin_audit_note
      const auditLine = `[FORCE 併薪 ${nowIso()}] +${cat.name} NT$${amount}(核准單 ${request.id})`;
      patch.admin_audit_note = sr.admin_audit_note
        ? `${auditLine}\n${sr.admin_audit_note}`
        : auditLine;

      const { error: updErr } = await supabaseAdmin
        .from('salary_records').update(patch).eq('id', recordId);
      if (updErr) throw updErr;

      console.log('[applyExpenseReimbursement] FORCE applied',
        { record_id: recordId, amount, taxable_delta: deltaTaxable, new_tax: patch.deduct_tax });
      return;
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

#!/usr/bin/env node
// scripts/backfill_overtime_202606_pmdept.mjs
// 一次性 HR 後台批次補登 — 2026/06 月 PM 部 6 筆加班依「公司月補休上限 5h」政策處理。
//
// 用法:
//   # dry-run(預設、只印不寫):
//   node --env-file=.env.local scripts/backfill_overtime_202606_pmdept.mjs [--actor=<emp_id>]
//
//   # 實際寫入:
//   node --env-file=.env.local scripts/backfill_overtime_202606_pmdept.mjs --apply [--actor=<emp_id>]
//
// 政策(2026-06-09 定案,prod overtime_limits id=2 即此政策):
//   - 每人每月補休軟目標 5h
//   - 超出當月 5h 且未事前特別申請者「不計補休」
//   - 超標日 attendance.is_anomaly 保留(=true 不動)作管理提醒、只更新 note 留軌跡
//
// 額度已人工定案、寫死在 manifest;本腳本不重算上限,只執行 manifest 指定動作。
// is_over_limit 仍走 lib/overtime/limits.js::checkOverLimit(對齊 proxy-create 慣例,
// credited 都 ≤5h、預期全 false;若有 true 表示「累積 + 本次 > 5h」,記錄不擋)。
//
// 對齊既有慣例:
//   scripts/backfill_attendance_202605_warehouse.mjs(--apply / --actor、idempotent、dry-run 輸出)
//   api/overtime-requests/proxy-create.js:111-134(INSERT 22 欄)
//   lib/overtime/comp-conversion.js::convertOvertimeToCompTimeSafe(補休入帳、不重寫換算)
//   api/overtime-requests/_repo.js::makeOvertimeRepo(共用 repo、走 supabaseAdmin service key)
//
// 每筆動作組合(由 manifest 的 kind / create_ot / clear_anomaly 三個 flag 控制):
//   credited         : create_ot=true  clear_anomaly=true  → 建 OT + 入帳 + 清 anomaly
//   over_cap_full    : create_ot=false clear_anomaly=false → 不建 OT、不入帳、保留 anomaly、只更新 note
//   over_cap_partial : create_ot=true  clear_anomaly=false → 建 OT(hours=credited)+ 入帳 credited h、
//                                                            保留 anomaly、note 註明只計 credited h
//
// 絕對不動:
//   - salary_records / payroll_periods / clock_in / clock_out / work_hours / overtime_hours
//   - 既有 leave_requests / approval_requests(包括 6/8 那 5 筆誤入的 'overtime' approval_requests)

import { supabaseAdmin } from '../lib/supabase.js';
import { makeOvertimeRepo } from '../api/overtime-requests/_repo.js';
import { convertOvertimeToCompTimeSafe } from '../lib/overtime/comp-conversion.js';
import { checkOverLimit } from '../lib/overtime/limits.js';

// ─── CLI 解析 ─────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = { apply: false, actor: 'EMP_01250901' };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--apply') flags.apply = true;
  else if (a.startsWith('--actor=')) flags.actor = a.slice('--actor='.length);
  else if (a === '--actor' && args[i + 1]) flags.actor = args[++i];
}
const MODE = flags.apply ? 'APPLY' : 'DRY-RUN';
const ACTOR = flags.actor;
const AUDIT_DATE = '2026-06-09';
const REASON = '6月加班補登:原申請誤入審批管理(系統已修正),經核實出勤後台補核准補休(依公司月上限5h)';

// ─── Manifest(額度已人工定案)─────────────────────────────────
// emp / date / start_at / end_at(Asia/Taipei +08:00)/ credited / create_ot / clear_anomaly / kind
const PLAN = [
  {
    emp: 'EMP_01251002', name: '黃筠庭',
    date: '2026-06-03', start: '18:00', endDate: '2026-06-03', end: '21:15',
    credited: 3, create_ot: true,  clear_anomaly: true,  kind: 'credited',
  },
  {
    emp: 'EMP_01251002', name: '黃筠庭',
    date: '2026-06-04', start: '18:00', endDate: '2026-06-04', end: '19:55',
    credited: 2, create_ot: true,  clear_anomaly: true,  kind: 'credited',
  },
  {
    // 黃筠庭 6/8:當月 6/3+6/4=5h 已達上限,本日 3h 全數不計
    emp: 'EMP_01251002', name: '黃筠庭',
    date: '2026-06-08', start: '18:00', endDate: '2026-06-08', end: '20:43',
    credited: 0, create_ot: false, clear_anomaly: false, kind: 'over_cap_full',
    actual_hours_display: 3,           // 印 anomaly_note 用
  },
  {
    emp: 'EMP_01251003', name: '陳郡葳',
    date: '2026-06-05', start: '18:00', endDate: '2026-06-05', end: '20:19',
    credited: 2, create_ot: true,  clear_anomaly: true,  kind: 'credited',
  },
  {
    emp: 'EMP_01251003', name: '陳郡葳',
    date: '2026-06-07', start: '18:00', endDate: '2026-06-07', end: '18:53',
    credited: 1, create_ot: true,  clear_anomaly: true,  kind: 'credited',
  },
  {
    // 陳郡葳 6/8:當月 6/5+6/7=3h,本日只可再計 2h,實際加班 6.28h 超出 4h 不計
    // 跨夜:overtime_date 仍記 2026-06-08;end_at 在 06-09 00:17
    emp: 'EMP_01251003', name: '陳郡葳',
    date: '2026-06-08', start: '18:00', endDate: '2026-06-09', end: '00:17',
    credited: 2, create_ot: true,  clear_anomaly: false, kind: 'over_cap_partial',
    actual_hours_display: 6.28,
    overage_display:      4,
  },
];

// ─── helpers ──────────────────────────────────────────────────
function toIsoTaipei(date, hhmm) {
  return `${date}T${hhmm}:00+08:00`;
}

async function findExistingApprovedOT(emp, date) {
  const { data } = await supabaseAdmin
    .from('overtime_requests')
    .select('id, overtime_date, status, compensation_type, hours, comp_balance_id')
    .eq('employee_id', emp).eq('overtime_date', date).eq('status', 'approved')
    .maybeSingle();
  return data || null;
}

async function findAttendanceForDate(emp, date) {
  const { data } = await supabaseAdmin
    .from('attendance')
    .select('id, work_date, is_anomaly, anomaly_note, status, work_hours')
    .eq('employee_id', emp).eq('work_date', date)
    .order('segment_no', { ascending: true })
    .limit(1).maybeSingle();
  return data || null;
}

function buildOTAuditNote(item) {
  if (item.kind === 'over_cap_partial') {
    return `[${AUDIT_DATE}] 後台代建 實際加班${item.actual_hours_display}h,依月上限5h僅計補休${item.credited}h,超出${item.overage_display}h未事前特別申請不計 by ${ACTOR}`;
  }
  // credited
  return `[${AUDIT_DATE}] 後台代建(6月加班補登,原誤入 approval_requests)by ${ACTOR}`;
}

function buildOTRow(item, limitResult, nowIso) {
  return {
    employee_id:           item.emp,
    overtime_date:         item.date,
    start_at:              toIsoTaipei(item.date,    item.start),
    end_at:                toIsoTaipei(item.endDate, item.end),
    hours:                 item.credited,             // ← 寫的就是 credited 額度
    request_kind:          'post_approval',
    is_over_limit:         limitResult.is_over_limit,
    over_limit_dimensions: limitResult.is_over_limit ? limitResult.over_limit_dimensions : null,
    compensation_type:     'comp_leave',
    estimated_pay:         null,
    pay_multiplier:        null,
    reason:                REASON,
    status:                'approved',
    manager_id:            ACTOR,
    manager_reviewed_at:   nowIso,
    manager_decision:      'approved',
    ceo_id:                ACTOR,
    ceo_reviewed_at:       nowIso,
    ceo_decision:          'approved',
    submitted_at:          nowIso,
    applies_to_year:       parseInt(item.date.slice(0, 4)),
    applies_to_month:      parseInt(item.date.slice(5, 7)),
    admin_audit_note:      buildOTAuditNote(item),
  };
}

function buildAttendanceNewNote(item, otId, oldNote) {
  const safeOld = oldNote ? String(oldNote) : '(原無)';
  if (item.clear_anomaly) {
    return `[${AUDIT_DATE} 補登核准加班 OT#${otId}] 原:${safeOld}`;
  }
  if (item.kind === 'over_cap_full') {
    return `[${AUDIT_DATE}] 加班${item.actual_hours_display}h但當月已達5h上限,未事前特別申請故不計補休,保留異常作管理提醒 原:${safeOld}`;
  }
  if (item.kind === 'over_cap_partial') {
    return `[${AUDIT_DATE}] 加班${item.actual_hours_display}h僅計補休${item.credited}h(OT#${otId}),超出${item.overage_display}h未事前特別申請不計,保留異常作管理提醒 原:${safeOld}`;
  }
  return `[${AUDIT_DATE}] (未知 kind) 原:${safeOld}`;
}

// ─── main ────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== [${MODE}] 6月 PM 部 加班補登(月上限 5h)— actor=${ACTOR} ===`);
  console.log(`reason: ${REASON}\n`);

  const repo = makeOvertimeRepo();

  const summary = {
    ot_built: 0, ot_skipped: 0,
    credited_hours: 0,
    anomaly_cleared: 0, anomaly_kept: 0, anomaly_skipped: 0,
  };

  for (let i = 0; i < PLAN.length; i++) {
    const item = PLAN[i];
    const xnight = item.endDate !== item.date ? ' [XNIGHT]' : '';
    const tag = `[${i + 1}/${PLAN.length}] ${item.emp} (${item.name}) ${item.date}  kind=${item.kind}  credited=${item.credited}h${xnight}`;
    console.log(tag);
    console.log(`  span: ${item.date}T${item.start} → ${item.endDate}T${item.end}`);

    let createdOT = null;

    // ── A. OT 處理 ──────────────────────────────────────────
    if (item.create_ot) {
      // (A.1) idempotent check
      const existing = await findExistingApprovedOT(item.emp, item.date);
      if (existing) {
        console.log(`  ► OT  [SKIP] 已有 approved overtime_request: id=${existing.id} hours=${existing.hours} comp_balance=${existing.comp_balance_id}`);
        summary.ot_skipped++;
        createdOT = existing;   // 提供 id 給後續 anomaly_note
      } else {
        // (A.2) over-limit 純記錄(對齊 proxy-create)
        let limitResult;
        try {
          limitResult = await checkOverLimit(repo, {
            employee_id: item.emp, overtime_date: item.date, hours: item.credited,
          });
        } catch (e) {
          console.log(`  ✗ checkOverLimit 失敗: ${e.message},fallback is_over_limit=false`);
          limitResult = { is_over_limit: false, over_limit_dimensions: [], limits: {}, projected: {} };
        }
        const limTag = limitResult.is_over_limit ? `OVER(${limitResult.over_limit_dimensions.join(',')})` : 'within';
        console.log(`  ► OT  limits: ${limTag}  projected d=${limitResult.projected?.daily ?? '?'} m=${limitResult.projected?.monthly ?? '?'} (limit d=${limitResult.limits?.daily ?? 'NULL'} m=${limitResult.limits?.monthly ?? 'NULL'})`);

        const nowIso = new Date().toISOString();
        const row = buildOTRow(item, limitResult, nowIso);
        console.log(`        INSERT  hours=${row.hours}  is_over_limit=${row.is_over_limit}`);
        console.log(`        admin_audit_note: ${row.admin_audit_note}`);

        if (MODE === 'APPLY') {
          try { createdOT = await repo.insertOvertimeRequest(row); }
          catch (e) { console.log(`        ✗ INSERT failed: ${e.message}`); continue; }
          console.log(`        ✓ inserted OT id=${createdOT.id}`);
        } else {
          console.log(`        [DRY-RUN] would INSERT (OT id pending)`);
          createdOT = { ...row, id: '<pending>' };
        }
        summary.ot_built++;

        // (A.3) 補休入帳
        console.log(`  ► COMP  earned_hours=${item.credited}h(1:1 from OT.hours)`);
        if (MODE === 'APPLY') {
          const conv = await convertOvertimeToCompTimeSafe(repo, createdOT);
          if (conv.ok) {
            console.log(`        ✓ comp_balance id=${conv.comp_balance.id} earned=${conv.comp_balance.earned_hours} expires=${String(conv.comp_balance.expires_at).slice(0,10)}`);
            summary.credited_hours += Number(conv.comp_balance.earned_hours) || 0;
          } else {
            console.log(`        ⚠ comp 入帳失敗:${conv.warning?.code} ${conv.warning?.detail}`);
          }
        } else {
          console.log(`        [DRY-RUN] would call convertOvertimeToCompTimeSafe`);
          summary.credited_hours += item.credited;
        }
      }
    } else {
      console.log(`  ► OT  [skip create]  kind=${item.kind} credited=0,不建 OT、不入帳`);
    }

    // ── B. attendance 處理 ─────────────────────────────────
    const att = await findAttendanceForDate(item.emp, item.date);
    if (!att) {
      console.log(`  ► ATTENDANCE  (查不到 attendance row、跳過)`);
      summary.anomaly_skipped++;
    } else {
      const otIdForNote = createdOT?.id ?? '—';
      const newNote = buildAttendanceNewNote(item, otIdForNote, att.anomaly_note);
      const willClear = !!item.clear_anomaly;
      const newAnomalyFlag = willClear ? false : att.is_anomaly;
      const action = willClear
        ? `is_anomaly=${att.is_anomaly}→false (cleared)`
        : `is_anomaly=${att.is_anomaly} (kept, only note updated)`;
      console.log(`  ► ATTENDANCE  id=${att.id}  ${action}`);
      console.log(`        OLD anomaly_note: ${att.anomaly_note ?? '(null)'}`);
      console.log(`        NEW anomaly_note: ${newNote}`);

      if (MODE === 'APPLY') {
        const patch = { anomaly_note: newNote };
        if (willClear) patch.is_anomaly = false;
        const { error } = await supabaseAdmin.from('attendance').update(patch).eq('id', att.id);
        if (error) console.log(`        ✗ UPDATE failed: ${error.message}`);
        else      console.log(`        ✓ attendance updated`);
      } else {
        const fields = willClear ? '{ is_anomaly: false, anomaly_note }' : '{ anomaly_note }';
        console.log(`        [DRY-RUN] would UPDATE attendance ${att.id} SET ${fields}`);
      }
      if (willClear) summary.anomaly_cleared++;
      else           summary.anomaly_kept++;
    }

    // 逐筆 1-line 結果摘要(對齊 spec 的輸出要求)
    console.log(`  ── result: kind=${item.kind} credited=${item.credited}h OT=${createdOT?.id ?? '—'} anomaly=${item.clear_anomaly ? 'cleared' : 'kept'}\n`);
  }

  console.log(`=== Summary (${MODE}) ===`);
  console.log(`建 OT          : ${summary.ot_built} 筆  (預期 5)`);
  console.log(`SKIP 既有 OT   : ${summary.ot_skipped} 筆`);
  console.log(`入帳補休總時數 : ${summary.credited_hours} h  (預期 10)`);
  console.log(`清 anomaly     : ${summary.anomaly_cleared} 筆  (預期 4)`);
  console.log(`保留 anomaly   : ${summary.anomaly_kept} 筆  (預期 2)`);
  console.log(`SKIP anomaly   : ${summary.anomaly_skipped} 筆(無對應 attendance row)`);
  if (MODE === 'DRY-RUN') {
    console.log(`\n(沒有寫入任何資料。確認後加 --apply 才會實際執行)`);
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});

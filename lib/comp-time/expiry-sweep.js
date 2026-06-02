// lib/comp-time/expiry-sweep.js — cron:補休失效處理(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §4.3.4 / §6.4
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §8.4
//
// cron schedule:每天 01:00(透過 api/cron-comp-expiry.js)
//
// 流程:
//   1. 找 status='active' AND expires_at <= today 的 comp_time_balance
//   2. 讀 system_overtime_settings.comp_expiry_action:
//      - 'auto_payout':**回讀來源加班單的凍結 estimated_pay,依比例折發未休時數**
//                     (§32-1「依原延長工作時間之工資計算標準」)
//                     unit = source_overtime.estimated_pay / source_overtime.hours
//                     payout_amount = unit × remaining_hours
//                     → 標 status='expired_paid' + expiry_payout_amount + 3 個 audit snapshot
//                     若無法回溯來源(source_overtime_request_id null / 找不到 row /
//                     estimated_pay null / hours <= 0)→ **公司政策 fallback**:
//                       現行時薪基數(repo.findEmployeeHourlyRate、含經常性給付)
//                       × 平日底價倍率(settings.weekday_overtime_first_2h_rate、預設 1.34)
//                       legacy_payout_count++、admin_audit_note 標明來源,HR 若有原加班屬
//                       休息日/國定的證據可後續上修。
//                     僅當「連時薪都取不到(=0)」才真正轉人工(amount=null + 標需 HR 核定)
//      - 'manual_review':標 status='expired_paid' 但金額 NULL(讓 HR 手動處理)
//      - 'void':標 status='expired_void'
//   3. 寫 leave_balance_logs(change_type='expire')
//
// 2026-06 變更:
//   - 移除「重算時薪 × 寫死 1.34」舊邏輯,改回讀來源加班的凍結金額
//   - 不再呼叫 repo.findEmployeeHourlyRate(已不需)
//   - settings.weekday_overtime_first_2h_rate 不再被本函式使用
//   - 新增 audit snapshot 三欄寫入 comp_time_balance(對應 migration
//     2026_06_03_comp_time_balance_payout_snapshot.sql)

/**
 * Repo 介面契約:
 *   getSystemOvertimeSettings(): { comp_expiry_action, comp_expiry_warning_days, ... } | null
 *   findExpiringCompBalances(today): Array<comp_time_balance>  status='active' AND expires_at <= today
 *   updateCompBalance(id, patch): updated row
 *   findOvertimeRequestById(id): { id, estimated_pay, hours, pay_multiplier, overtime_date } | null
 *     2026-06 新加,給 auto_payout 回讀來源凍結金額用
 *   insertBalanceLog(row)
 *
 * 注意:Batch 6 原版有 applyToSalaryRecord 介面,Batch 9 重新設計後移除
 *      (改由 lib/salary/calculator.js 月底跑時讀 comp_time_balance 加總)。
 *      findEmployeeHourlyRate 在 2026-06 第一版改用「來源凍結金額」後曾不再使用,
 *      第二版(legacy fallback)又重新接回:無 source 加班時走「現行時薪 × 平日底價」。
 */

export async function runCompExpirySweep(repo, today) {
  requireRepo(repo, [
    'getSystemOvertimeSettings',
    'findExpiringCompBalances',
    'updateCompBalance',
    'insertBalanceLog',
  ]);
  if (!today) throw new Error('today required');

  const settings = await repo.getSystemOvertimeSettings() || {};
  const action = settings.comp_expiry_action || 'auto_payout';
  // legacy fallback 用的政策底價倍率(平日前 2h 倍率、預設 1.34)
  const legacyMult = Number(settings.weekday_overtime_first_2h_rate) || 1.34;

  const expiring = await repo.findExpiringCompBalances(today);
  let expired_count = 0;
  let payout_total  = 0;
  let unresolvable_count = 0;
  let legacy_payout_count = 0;
  const nowIso = new Date().toISOString();

  for (const r of (expiring || [])) {
    const remaining = Math.max(0, Number(r.earned_hours) - Number(r.used_hours));

    if (remaining <= 1e-6) {
      // 已用盡:直接標 fully_used(理論上 active 不該 remaining=0,但防呆)
      await repo.updateCompBalance(r.id, {
        status: 'fully_used',
        expiry_processed_at: nowIso,
      });
      continue;
    }

    let payoutAmount = null;
    let unresolvable = false;

    if (action === 'auto_payout') {
      // §32-1:回讀來源加班的凍結 estimated_pay、依比例折發未休時數
      // unit = est / hours(每補休小時的原加班金額,含當日時薪 + 原倍率)
      // payoutAmount = unit × remaining
      const otId = r.source_overtime_request_id;
      let ot = null;
      if (otId != null && typeof repo.findOvertimeRequestById === 'function') {
        try { ot = await repo.findOvertimeRequestById(otId); }
        catch (e) { ot = null; }
      }
      const otHours = ot ? Number(ot.hours) : 0;
      const otEst   = ot && ot.estimated_pay != null ? Number(ot.estimated_pay) : null;
      const resolvable = ot && otEst != null && Number.isFinite(otEst) && otHours > 0;

      if (resolvable) {
        const unit = round2(otEst / otHours);
        payoutAmount = round2(unit * remaining);
        await repo.updateCompBalance(r.id, {
          status: 'expired_paid',
          expiry_payout_amount: payoutAmount,
          expiry_payout_unit_amount: unit,
          expiry_payout_source_multiplier: ot.pay_multiplier ?? null,
          expiry_payout_source_overtime_date: ot.overtime_date ?? null,
          expiry_processed_at: nowIso,
        });
        payout_total += payoutAmount;
      } else {
        // 無凍結來源(legacy 匯入或手動建立):無原加班可回溯。
        // 公司政策 fallback:現行正確時薪基數 × 平日底價倍率。連時薪都取不到才轉人工。
        let hourly = 0;
        if (typeof repo.findEmployeeHourlyRate === 'function') {
          try { hourly = Number(await repo.findEmployeeHourlyRate(r.employee_id)) || 0; }
          catch (e) { hourly = 0; }
        }
        const srcReason = (otId == null)
          ? 'legacy 補休(無來源加班、上線前匯入)'
          : `來源加班 #${otId} 不存在或 estimated_pay/hours 缺值`;

        if (hourly > 0) {
          const unit = round2(hourly * legacyMult);
          payoutAmount = round2(unit * remaining);
          const noteLine = `[${today}] 無凍結來源,採公司政策折發:現行時薪 ${hourly} × ${legacyMult}(平日底價)。${srcReason}。HR 如有原加班屬休息日/國定之證據可上修。`;
          await repo.updateCompBalance(r.id, {
            status: 'expired_paid',
            expiry_payout_amount: payoutAmount,
            expiry_payout_unit_amount: unit,
            expiry_payout_source_multiplier: legacyMult,
            expiry_payout_source_overtime_date: null,
            expiry_processed_at: nowIso,
            admin_audit_note: r.admin_audit_note ? `${noteLine}\n${r.admin_audit_note}` : noteLine,
          });
          payout_total += payoutAmount;
          legacy_payout_count += 1;
        } else {
          unresolvable = true;
          unresolvable_count += 1;
          const noteLine = `[${today}] auto-expire 無凍結來源且無法取得時薪基數,需 HR 人工核定。原因:${srcReason}`;
          await repo.updateCompBalance(r.id, {
            status: 'expired_paid',
            expiry_payout_amount: null,
            expiry_processed_at: nowIso,
            admin_audit_note: r.admin_audit_note ? `${noteLine}\n${r.admin_audit_note}` : noteLine,
          });
        }
      }
    } else if (action === 'manual_review') {
      await repo.updateCompBalance(r.id, {
        status: 'expired_paid',
        expiry_payout_amount: null,
        expiry_processed_at: nowIso,
      });
    } else if (action === 'void') {
      await repo.updateCompBalance(r.id, {
        status: 'expired_void',
        expiry_processed_at: nowIso,
      });
    } else {
      // unknown action:跳過,留 HR 處理
      continue;
    }

    await repo.insertBalanceLog({
      employee_id: r.employee_id,
      balance_type: 'comp',
      annual_record_id: null,
      comp_record_id: r.id,
      leave_request_id: null,
      change_type: 'expire',
      hours_delta: -remaining,
      changed_by: r.employee_id, // SYSTEM 沒員工 id 用本人佔位
      reason: `auto-expire on ${today}, action=${action}` +
              (payoutAmount != null ? `, payout=${payoutAmount}` : '') +
              (unresolvable ? ' (unresolvable, needs HR review)' : ''),
    });
    expired_count += 1;
  }

  return { expired_count, payout_total, unresolvable_count, legacy_payout_count, action, today };
}

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') throw new Error(`repo.${m} is required`);
  }
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

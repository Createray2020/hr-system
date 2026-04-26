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
//      - 'auto_payout':算金額(時薪 × remaining × 倍率,預設 weekday_overtime_first_2h_rate=1.34)
//                     → 標 status='expired_paid' + expiry_payout_amount
//                     → 嘗試填入該員工當月 salary_records.comp_expiry_payout(本批先 try/catch
//                       graceful 失敗,Batch 9 才正式接通)
//      - 'manual_review':標 status='expired_paid' 但金額 NULL(讓 HR 手動處理)
//      - 'void':標 status='expired_void'
//   3. 寫 leave_balance_logs(change_type='expire')

/**
 * Repo 介面契約:
 *   getSystemOvertimeSettings(): { comp_expiry_action, comp_expiry_warning_days,
 *                                  weekday_overtime_first_2h_rate, ... } | null
 *   findExpiringCompBalances(today): Array<comp_time_balance>  status='active' AND expires_at <= today
 *   updateCompBalance(id, patch): updated row
 *   findEmployeeHourlyRate(employee_id): number  時薪(Batch 9 完整版前粗估用 monthly/240)
 *   applyToSalaryRecord({ employee_id, year, month, comp_expiry_payout }):
 *     try/catch 包起;Batch 9 才有 salary_records.comp_expiry_payout 欄位
 *   insertBalanceLog(row)
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
  const rate   = Number(settings.weekday_overtime_first_2h_rate) || 1.34;

  const expiring = await repo.findExpiringCompBalances(today);
  let expired_count = 0;
  let payout_total  = 0;
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

    if (action === 'auto_payout') {
      let hourly = 0;
      if (typeof repo.findEmployeeHourlyRate === 'function') {
        try { hourly = Number(await repo.findEmployeeHourlyRate(r.employee_id)) || 0; }
        catch (e) { hourly = 0; }
      }
      payoutAmount = round2(hourly * remaining * rate);
      await repo.updateCompBalance(r.id, {
        status: 'expired_paid',
        expiry_payout_amount: payoutAmount,
        expiry_processed_at: nowIso,
      });
      payout_total += payoutAmount;

      // TODO(Batch 9):salary_records.comp_expiry_payout 欄位尚未存在,
      // 本批先寫好 applyToSalaryRecord 的呼叫,失敗用 try/catch graceful 跳過。
      if (typeof repo.applyToSalaryRecord === 'function') {
        try {
          const expiry = String(r.expires_at).slice(0, 10);
          const [yy, mm] = expiry.split('-');
          await repo.applyToSalaryRecord({
            employee_id: r.employee_id,
            year:  parseInt(yy),
            month: parseInt(mm),
            comp_expiry_payout: payoutAmount,
            comp_balance_id: r.id,
          });
        } catch (e) {
          // 預期失敗:Batch 9 才會加 salary_records.comp_expiry_payout 欄位
          // 現階段標記成功 + 等 Batch 9 backfill
          // eslint-disable-next-line no-console
          console.warn('[comp-expiry-sweep] applyToSalaryRecord skipped (Batch 9 to wire):', e.message);
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
              (payoutAmount != null ? `, payout=${payoutAmount}` : ''),
    });
    expired_count += 1;
  }

  return { expired_count, payout_total, action, today };
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

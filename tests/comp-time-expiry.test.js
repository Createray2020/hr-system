import { describe, it, expect, vi } from 'vitest';
import { runCompExpirySweep } from '../lib/comp-time/expiry-sweep.js';
import { runCompExpiryWarning } from '../lib/comp-time/expiry-warning.js';

const baseSettings = {
  comp_expiry_action: 'auto_payout',
  comp_expiry_warning_days: 30,
  weekday_overtime_first_2h_rate: 1.34,
};

function makeSweepRepo(over = {}) {
  return {
    getSystemOvertimeSettings: vi.fn(async () => baseSettings),
    findExpiringCompBalances:  vi.fn(async () => []),
    updateCompBalance:         vi.fn(async (id, patch) => ({ id, ...patch })),
    // 2026-06:auto_payout 改回讀來源加班、預設 mock 回 null(unresolvable);
    // 個別 test 覆寫成有值的 ot row 來測 resolvable 路徑
    findOvertimeRequestById:   vi.fn(async () => null),
    findEmployeeHourlyRate:    vi.fn(async () => 200), // 舊 method、目前 lib 已不用、留 mock 防 contract drift
    applyToSalaryRecord:       vi.fn(async () => ({ ok: true })),
    insertBalanceLog:          vi.fn(async (row) => ({ id: 1, ...row })),
    ...over,
  };
}

const cb = (over = {}) => ({
  id: 1, employee_id: 'E001',
  earned_hours: 8, used_hours: 0,
  earned_at: '2025-04-26T00:00:00Z',
  expires_at: '2026-04-26',
  status: 'active',
  ...over,
});

describe('runCompExpirySweep — basic', () => {
  it('today 必填', async () => {
    await expect(runCompExpirySweep(makeSweepRepo(), null)).rejects.toThrow(/today/);
  });

  it('repo 缺 method 拒絕', async () => {
    await expect(runCompExpirySweep({}, '2026-04-26')).rejects.toThrow();
  });

  it('沒 expiring → 全 0', async () => {
    const r = await runCompExpirySweep(makeSweepRepo(), '2026-04-26');
    expect(r).toMatchObject({ expired_count: 0, payout_total: 0, action: 'auto_payout' });
  });
});

describe('runCompExpirySweep — auto_payout (§32-1 回讀來源凍結金額)', () => {
  it('resolvable:est=1340 hours=10 → unit=134、remaining=4 → payout=536;寫 3 個 audit snapshot 欄', async () => {
    const repo = makeSweepRepo({
      findExpiringCompBalances: vi.fn(async () => [cb({
        id: 1, source_overtime_request_id: 99,
        earned_hours: 4, used_hours: 0,
      })]),
      findOvertimeRequestById: vi.fn(async () => ({
        id: 99, estimated_pay: 1340, hours: 10,
        pay_multiplier: 1.34, overtime_date: '2025-04-26',
      })),
    });
    const r = await runCompExpirySweep(repo, '2026-04-26');
    expect(r.expired_count).toBe(1);
    expect(r.unresolvable_count).toBe(0);
    expect(r.payout_total).toBe(536);

    const updPatch = repo.updateCompBalance.mock.calls[0][1];
    expect(updPatch.status).toBe('expired_paid');
    expect(updPatch.expiry_payout_amount).toBe(536);
    expect(updPatch.expiry_payout_unit_amount).toBe(134);
    expect(updPatch.expiry_payout_source_multiplier).toBe(1.34);
    expect(updPatch.expiry_payout_source_overtime_date).toBe('2025-04-26');
    expect(updPatch.expiry_processed_at).toBeTruthy();

    // expire log
    const log = repo.insertBalanceLog.mock.calls[0][0];
    expect(log.balance_type).toBe('comp');
    expect(log.change_type).toBe('expire');
    expect(log.hours_delta).toBe(-4);
    expect(log.reason).toContain('payout=536');
  });

  it('多倍率來源(休息日 est 反映 2.67):折發用 est/hours、不用 1.34', async () => {
    // 休息日 8h 加班、後 6h 走 2.67 倍 → est = 2*200*1.34 + 6*200*2.67 = 536 + 3204 = 3740
    // unit = 3740/8 = 467.5,remaining=8 → payout = 3740(原樣折發)
    const repo = makeSweepRepo({
      findExpiringCompBalances: vi.fn(async () => [cb({
        id: 2, source_overtime_request_id: 100,
        earned_hours: 8, used_hours: 0,
      })]),
      findOvertimeRequestById: vi.fn(async () => ({
        id: 100, estimated_pay: 3740, hours: 8,
        pay_multiplier: 1.34, overtime_date: '2025-05-04',
      })),
    });
    const r = await runCompExpirySweep(repo, '2026-05-04');
    expect(r.payout_total).toBe(3740);
    const updPatch = repo.updateCompBalance.mock.calls[0][1];
    expect(updPatch.expiry_payout_unit_amount).toBe(467.5);
    // 對照舊邏輯 200 × 8 × 1.34 = 2144、新邏輯 3740,確認沒用舊 1.34 折發
    expect(updPatch.expiry_payout_amount).not.toBe(2144);
    expect(updPatch.expiry_payout_amount).toBe(3740);
  });

  it('部分使用:est=1000 hours=4 unit=250、used=1 → remaining=3 payout=750', async () => {
    const repo = makeSweepRepo({
      findExpiringCompBalances: vi.fn(async () => [cb({
        id: 3, source_overtime_request_id: 101,
        earned_hours: 4, used_hours: 1,
      })]),
      findOvertimeRequestById: vi.fn(async () => ({
        id: 101, estimated_pay: 1000, hours: 4,
        pay_multiplier: 2.0, overtime_date: '2025-06-01',
      })),
    });
    const r = await runCompExpirySweep(repo, '2026-06-01');
    expect(r.payout_total).toBe(750);
    const updPatch = repo.updateCompBalance.mock.calls[0][1];
    expect(updPatch.expiry_payout_unit_amount).toBe(250);
    expect(updPatch.expiry_payout_amount).toBe(750);
    expect(updPatch.expiry_payout_source_multiplier).toBe(2.0);
  });

  it('unresolvable:source_overtime_request_id=null → 走人工核定、payout=null、不歸零', async () => {
    const repo = makeSweepRepo({
      findExpiringCompBalances: vi.fn(async () => [cb({
        id: 4, source_overtime_request_id: null,
        earned_hours: 5, used_hours: 0,
      })]),
    });
    const r = await runCompExpirySweep(repo, '2026-04-26');
    expect(r.expired_count).toBe(1);
    expect(r.unresolvable_count).toBe(1);
    expect(r.payout_total).toBe(0);

    const updPatch = repo.updateCompBalance.mock.calls[0][1];
    expect(updPatch.status).toBe('expired_paid');
    expect(updPatch.expiry_payout_amount).toBe(null);     // 不歸零!明確 null
    expect(updPatch.admin_audit_note).toContain('需 HR 人工核定');
    expect(updPatch.admin_audit_note).toContain('source_overtime_request_id 為 null');
    // 不寫 snapshot 三欄(因為沒來源)
    expect(updPatch.expiry_payout_unit_amount).toBeUndefined();
    expect(updPatch.expiry_payout_source_multiplier).toBeUndefined();
    // log reason 含 unresolvable 標記
    expect(repo.insertBalanceLog.mock.calls[0][0].reason).toContain('unresolvable');
    // 確認沒呼叫舊的時薪重算路徑
    expect(repo.findEmployeeHourlyRate).not.toHaveBeenCalled();
  });

  it('unresolvable:來源加班 row 不存在 → 同 unresolvable 處理、admin_audit_note 標 OT id', async () => {
    const repo = makeSweepRepo({
      findExpiringCompBalances: vi.fn(async () => [cb({
        id: 5, source_overtime_request_id: 9999,
        earned_hours: 2, used_hours: 0,
      })]),
      findOvertimeRequestById: vi.fn(async () => null),
    });
    const r = await runCompExpirySweep(repo, '2026-04-26');
    expect(r.unresolvable_count).toBe(1);
    const updPatch = repo.updateCompBalance.mock.calls[0][1];
    expect(updPatch.expiry_payout_amount).toBe(null);
    expect(updPatch.admin_audit_note).toContain('來源加班 #9999 不存在');
  });

  it('unresolvable:來源加班 estimated_pay=null → 同 unresolvable', async () => {
    const repo = makeSweepRepo({
      findExpiringCompBalances: vi.fn(async () => [cb({
        id: 6, source_overtime_request_id: 200,
        earned_hours: 3, used_hours: 0,
      })]),
      findOvertimeRequestById: vi.fn(async () => ({
        id: 200, estimated_pay: null, hours: 3,
        pay_multiplier: null, overtime_date: '2025-04-01',
      })),
    });
    const r = await runCompExpirySweep(repo, '2026-04-26');
    expect(r.unresolvable_count).toBe(1);
    expect(repo.updateCompBalance.mock.calls[0][1].expiry_payout_amount).toBe(null);
  });

  it('unresolvable:既有 admin_audit_note 保留、新 line 在頂', async () => {
    const repo = makeSweepRepo({
      findExpiringCompBalances: vi.fn(async () => [cb({
        id: 7, source_overtime_request_id: null,
        earned_hours: 1, used_hours: 0,
        admin_audit_note: '舊備註保留',
      })]),
    });
    await runCompExpirySweep(repo, '2026-04-26');
    const note = repo.updateCompBalance.mock.calls[0][1].admin_audit_note;
    expect(note.split('\n')[0]).toContain('需 HR 人工核定');
    expect(note).toContain('舊備註保留');
  });

  it('Batch 9 設計:不再呼叫 applyToSalaryRecord(改由 calculator 月底讀)', async () => {
    const repo = makeSweepRepo({
      findExpiringCompBalances: vi.fn(async () => [cb({
        id: 8, source_overtime_request_id: 50,
        earned_hours: 4, used_hours: 0,
      })]),
      findOvertimeRequestById: vi.fn(async () => ({
        id: 50, estimated_pay: 1000, hours: 4,
        pay_multiplier: 1.34, overtime_date: '2025-04-26',
      })),
    });
    await runCompExpirySweep(repo, '2026-04-26');
    expect(repo.applyToSalaryRecord).not.toHaveBeenCalled();
  });
});

describe('runCompExpirySweep — manual_review', () => {
  it('標 expired_paid 但金額 NULL', async () => {
    const repo = makeSweepRepo({
      getSystemOvertimeSettings: vi.fn(async () => ({ ...baseSettings, comp_expiry_action: 'manual_review' })),
      findExpiringCompBalances: vi.fn(async () => [cb()]),
    });
    const r = await runCompExpirySweep(repo, '2026-04-26');
    expect(r.action).toBe('manual_review');
    expect(r.payout_total).toBe(0);
    const updPatch = repo.updateCompBalance.mock.calls[0][1];
    expect(updPatch.status).toBe('expired_paid');
    expect(updPatch.expiry_payout_amount).toBe(null);
    expect(repo.applyToSalaryRecord).not.toHaveBeenCalled();
  });
});

describe('runCompExpirySweep — void', () => {
  it('標 expired_void,不算金額', async () => {
    const repo = makeSweepRepo({
      getSystemOvertimeSettings: vi.fn(async () => ({ ...baseSettings, comp_expiry_action: 'void' })),
      findExpiringCompBalances: vi.fn(async () => [cb()]),
    });
    const r = await runCompExpirySweep(repo, '2026-04-26');
    expect(r.action).toBe('void');
    const updPatch = repo.updateCompBalance.mock.calls[0][1];
    expect(updPatch.status).toBe('expired_void');
    expect(repo.applyToSalaryRecord).not.toHaveBeenCalled();
  });
});

describe('runCompExpirySweep — fully_used 防呆', () => {
  it('remaining=0 直接標 fully_used,不寫 expire log', async () => {
    const repo = makeSweepRepo({
      findExpiringCompBalances: vi.fn(async () => [cb({ earned_hours: 5, used_hours: 5 })]),
    });
    const r = await runCompExpirySweep(repo, '2026-04-26');
    expect(r.expired_count).toBe(0);
    expect(repo.updateCompBalance.mock.calls[0][1].status).toBe('fully_used');
    expect(repo.insertBalanceLog).not.toHaveBeenCalled();
  });
});

// ─── expiry-warning ─────────────────────────────────────────

function makeWarnRepo(over = {}) {
  return {
    getSystemOvertimeSettings: vi.fn(async () => baseSettings),
    findCompBalancesExpiringOn: vi.fn(async () => []),
    notifyExpiryWarning: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}

describe('runCompExpiryWarning', () => {
  it('today 必填', async () => {
    await expect(runCompExpiryWarning(makeWarnRepo(), null)).rejects.toThrow(/today/);
  });

  it('用 settings.comp_expiry_warning_days 計算 target;預設 30', async () => {
    const repo = makeWarnRepo();
    const r = await runCompExpiryWarning(repo, '2026-04-26');
    expect(r.warning_days).toBe(30);
    expect(r.target_date).toBe('2026-05-26');
    expect(repo.findCompBalancesExpiringOn).toHaveBeenCalledWith('2026-05-26');
  });

  it('settings 未提供 → fallback 30 天', async () => {
    const repo = makeWarnRepo({
      getSystemOvertimeSettings: vi.fn(async () => null),
    });
    const r = await runCompExpiryWarning(repo, '2026-04-26');
    expect(r.warning_days).toBe(30);
  });

  it('settings 自訂 14 → 14 天後', async () => {
    const repo = makeWarnRepo({
      getSystemOvertimeSettings: vi.fn(async () => ({ ...baseSettings, comp_expiry_warning_days: 14 })),
    });
    const r = await runCompExpiryWarning(repo, '2026-04-26');
    expect(r.warning_days).toBe(14);
    expect(r.target_date).toBe('2026-05-10');
  });

  it('每筆 active 觸發推播', async () => {
    const repo = makeWarnRepo({
      findCompBalancesExpiringOn: vi.fn(async () => [
        cb({ id: 1, earned_hours: 4, used_hours: 0 }),
        cb({ id: 2, earned_hours: 6, used_hours: 2 }),
      ]),
    });
    const r = await runCompExpiryWarning(repo, '2026-04-26');
    expect(r.warning_sent_count).toBe(2);
    expect(repo.notifyExpiryWarning).toHaveBeenCalledTimes(2);
    expect(repo.notifyExpiryWarning.mock.calls[0][0].remaining_hours).toBe(4);
    expect(repo.notifyExpiryWarning.mock.calls[1][0].remaining_hours).toBe(4);
  });

  it('remaining 0 → skip 不通知', async () => {
    const repo = makeWarnRepo({
      findCompBalancesExpiringOn: vi.fn(async () => [
        cb({ earned_hours: 5, used_hours: 5 }),
      ]),
    });
    const r = await runCompExpiryWarning(repo, '2026-04-26');
    expect(r.warning_sent_count).toBe(0);
    expect(repo.notifyExpiryWarning).not.toHaveBeenCalled();
  });
});

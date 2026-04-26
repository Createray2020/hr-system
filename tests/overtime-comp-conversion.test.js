import { describe, it, expect, vi } from 'vitest';
import { convertOvertimeToCompTime } from '../lib/overtime/comp-conversion.js';

function makeRepo(over = {}) {
  // 同 grantCompTime + comp-conversion 共用的 repo 介面
  return {
    insertCompBalance: vi.fn(async (row) => ({ id: 555, ...row })),
    insertBalanceLog:  vi.fn(async (row) => ({ id: 1, ...row })),
    updateOvertimeCompBalanceId: vi.fn(async (req_id, comp_id) => ({ id: req_id, comp_balance_id: comp_id })),
    ...over,
  };
}

const ot = (over = {}) => ({
  id: 100,
  employee_id: 'E001',
  overtime_date: '2026-04-26',
  hours: 4,
  status: 'approved',
  compensation_type: 'comp_leave',
  manager_id: 'M001',
  ...over,
});

describe('convertOvertimeToCompTime — 接通 grantCompTime', () => {
  it('正常轉換:呼叫 insertCompBalance(透過 grantCompTime) + updateOvertimeCompBalanceId', async () => {
    const repo = makeRepo();
    const created = await convertOvertimeToCompTime(repo, ot());
    expect(created).toBeTruthy();
    expect(created.id).toBe(555);

    // 確認 grantCompTime 被觸發(透過 insertCompBalance call)
    expect(repo.insertCompBalance).toHaveBeenCalledTimes(1);
    const insertedRow = repo.insertCompBalance.mock.calls[0][0];
    expect(insertedRow.employee_id).toBe('E001');
    expect(insertedRow.earned_hours).toBe(4); // 1:1 不依倍率(規範 §9.5)
    expect(insertedRow.source_overtime_request_id).toBe(100);
    expect(insertedRow.earned_at).toBe('2026-04-26T00:00:00+08:00');
    expect(insertedRow.expires_at).toBe('2027-04-26'); // earned_at + 1 year
    expect(insertedRow.status).toBe('active');

    // grant log
    const logRow = repo.insertBalanceLog.mock.calls[0][0];
    expect(logRow.balance_type).toBe('comp');
    expect(logRow.change_type).toBe('grant');
    expect(logRow.hours_delta).toBe(4);
    expect(logRow.changed_by).toBe('M001');

    // 寫回 overtime_requests.comp_balance_id
    expect(repo.updateOvertimeCompBalanceId).toHaveBeenCalledWith(100, 555);
  });

  it('1:1 不依倍率:即使加班費倍率 1.34,comp 仍給 4h 不是 5.36h', async () => {
    const repo = makeRepo();
    await convertOvertimeToCompTime(repo, ot({ hours: 4 }));
    expect(repo.insertCompBalance.mock.calls[0][0].earned_hours).toBe(4);
  });

  it('compensation_type !== comp_leave → throw(防誤呼叫)', async () => {
    await expect(convertOvertimeToCompTime(makeRepo(), ot({ compensation_type: 'overtime_pay' })))
      .rejects.toThrow(/comp_leave/);
    await expect(convertOvertimeToCompTime(makeRepo(), ot({ compensation_type: 'undecided' })))
      .rejects.toThrow(/comp_leave/);
  });

  it('沒 manager_id 用 ceo_id;都沒就用 employee_id', async () => {
    const repo = makeRepo();
    await convertOvertimeToCompTime(repo, ot({ manager_id: null, ceo_id: 'CEO1' }));
    expect(repo.insertBalanceLog.mock.calls[0][0].changed_by).toBe('CEO1');

    repo.insertBalanceLog.mockClear();
    await convertOvertimeToCompTime(repo, ot({ manager_id: null, ceo_id: null }));
    expect(repo.insertBalanceLog.mock.calls[0][0].changed_by).toBe('E001');
  });

  it('hours 非正 → throw', async () => {
    await expect(convertOvertimeToCompTime(makeRepo(), ot({ hours: 0 })))
      .rejects.toThrow();
    await expect(convertOvertimeToCompTime(makeRepo(), ot({ hours: -1 })))
      .rejects.toThrow();
  });

  it('repo 缺 updateOvertimeCompBalanceId → throw', async () => {
    const incomplete = {
      insertCompBalance: vi.fn(async (row) => ({ id: 1, ...row })),
      insertBalanceLog:  vi.fn(async () => ({ id: 1 })),
    };
    await expect(convertOvertimeToCompTime(incomplete, ot())).rejects.toThrow(/updateOvertimeCompBalanceId/);
  });

  it('grantCompTime 沒回 id(repo bug)→ throw', async () => {
    const repo = makeRepo({
      insertCompBalance: vi.fn(async () => ({ id: null })),
    });
    await expect(convertOvertimeToCompTime(repo, ot())).rejects.toThrow(/id/);
  });

  it('沒 overtimeRequest 必填欄位 → throw', async () => {
    await expect(convertOvertimeToCompTime(makeRepo(), null)).rejects.toThrow();
    await expect(convertOvertimeToCompTime(makeRepo(), { compensation_type: 'comp_leave' })).rejects.toThrow();
  });
});

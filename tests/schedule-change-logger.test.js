import { describe, it, expect, vi } from 'vitest';
import { logScheduleChange, CHANGE_TYPES } from '../lib/schedule/change-logger.js';

function makeRepo() {
  return {
    insertScheduleChangeLog: vi.fn().mockImplementation(async (row) => ({ id: 1, ...row })),
  };
}

describe('logScheduleChange', () => {
  it('寫入正確欄位', async () => {
    const repo = makeRepo();
    await logScheduleChange(repo, {
      schedule_id: 'S1',
      employee_id: 'E001',
      change_type: 'manager_adjust',
      changed_by: 'M001',
      before_data: { shift: 'A' },
      after_data:  { shift: 'B' },
      reason: '臨時調整',
      isLateChange: false,
    });

    expect(repo.insertScheduleChangeLog).toHaveBeenCalledTimes(1);
    const row = repo.insertScheduleChangeLog.mock.calls[0][0];
    expect(row).toMatchObject({
      schedule_id: 'S1',
      employee_id: 'E001',
      change_type: 'manager_adjust',
      changed_by: 'M001',
      before_data: { shift: 'A' },
      after_data:  { shift: 'B' },
      reason: '臨時調整',
      notification_sent: true,
    });
  });

  it('isLateChange=true → notification_sent=false', async () => {
    const repo = makeRepo();
    await logScheduleChange(repo, {
      schedule_id: 'S1',
      employee_id: 'E001',
      change_type: 'late_change',
      changed_by: 'M001',
      before_data: null,
      after_data: { shift: 'X' },
      isLateChange: true,
    });
    const row = repo.insertScheduleChangeLog.mock.calls[0][0];
    expect(row.notification_sent).toBe(false);
    expect(row.change_type).toBe('late_change');
  });

  it('schedule_id null 也可（cron lock 沒對應單筆）', async () => {
    const repo = makeRepo();
    await logScheduleChange(repo, {
      schedule_id: null,
      employee_id: 'E001',
      change_type: 'system_lock',
      changed_by: 'SYS',
      before_data: null,
      after_data:  null,
    });
    const row = repo.insertScheduleChangeLog.mock.calls[0][0];
    expect(row.schedule_id).toBe(null);
    expect(row.change_type).toBe('system_lock');
  });

  it('未知 change_type 拒絕', async () => {
    const repo = makeRepo();
    await expect(logScheduleChange(repo, {
      employee_id: 'E001',
      change_type: 'NOPE',
      changed_by: 'M001',
    })).rejects.toThrow(/invalid change_type/);
    expect(repo.insertScheduleChangeLog).not.toHaveBeenCalled();
  });

  it('缺 employee_id 拒絕', async () => {
    const repo = makeRepo();
    await expect(logScheduleChange(repo, {
      change_type: 'manager_adjust',
      changed_by: 'M001',
    })).rejects.toThrow(/employee_id/);
  });

  it('缺 changed_by 拒絕', async () => {
    const repo = makeRepo();
    await expect(logScheduleChange(repo, {
      employee_id: 'E001',
      change_type: 'manager_adjust',
    })).rejects.toThrow(/changed_by/);
  });

  it('repo 缺 insertScheduleChangeLog 拒絕', async () => {
    await expect(logScheduleChange({}, {
      employee_id: 'E001',
      change_type: 'manager_adjust',
      changed_by: 'M001',
    })).rejects.toThrow(/insertScheduleChangeLog/);
  });

  it('CHANGE_TYPES 包含設計文件 6 個', () => {
    expect(CHANGE_TYPES).toEqual([
      'employee_draft', 'employee_submit',
      'manager_adjust', 'manager_approve',
      'system_lock', 'late_change',
    ]);
  });
});

// tests/api-schedules-id-cascade.test.js — P8.1:schedules PUT cascade attendance recompute
//
// 對 api/schedules/[id].js handlePut 加的 cascade block 覆蓋 5 case:
//   SC1: 改 start_time + attendance.status=late → cascade 重算、回應含 attendance_cascade
//   SC2: 沒對應 attendance row → cascade null、無 attendance write
//   SC3: attendance.status=leave PRESERVED → late_minutes 動仍寫、status 不動
//   SC4: recompute 跟原 attendance 完全一樣 → 不 update attendance
//   SC5: isLateChange=true regression — late_change 通知 + schedule_change_logs 寫入 不受 cascade 影響
//
// Mock 策略(對齊 tests/api-attendance-admin-edit.test.js + tests/api-overtime-admin-edit.test.js):
//   supabase chain by table、dataByQuery['table:maybeSingle'] 控 SELECT、calls.updates 攔 UPDATE
//   auth.requireAuth: overrides.caller
//   roles.isBackofficeRole: actual logic
//   schedule/permissions: overrides.{employeePerm,managerPerm}
//   schedule/change-logger / push: mock vi.fn 供 assertion
//   attendance/recompute: mock vi.fn 回 overrides.recomputeReturn

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], updates: [], deletes: [] };
const dataByQuery = {};
const overrides = {
  caller: null,
  recomputeReturn: { late_minutes: 0, early_arrival_minutes: 0, early_leave_minutes: 0, status: 'normal' },
  managerPerm: { ok: true, isLateChange: false },
  employeePerm: { ok: true },
};

const mockSendPushToRoles = vi.fn(async () => ({ sent: 0 }));
const mockCreateNotificationsForRoles = vi.fn(async () => undefined);
const mockLogScheduleChange = vi.fn(async () => undefined);
const mockRecompute = vi.fn(() => ({ ...overrides.recomputeReturn }));

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn(() => c);
    c.update = vi.fn((patch) => { calls.updates.push({ table, patch }); return c; });
    c.delete = vi.fn(() => { calls.deletes.push({ table }); return c; });
    c.insert = vi.fn(() => c);
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:maybeSingle`] ?? null,
      error: null,
    }));
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    return c;
  }
  const client = {
    from: vi.fn((table) => { calls.tables.push(table); return chain(table); }),
  };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(async (req, res) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return overrides.caller;
  }),
}));

vi.mock('../lib/roles.js', () => ({
  isBackofficeRole: vi.fn(u => !!u && ['hr','ceo','chairman','admin'].includes(u.role)),
}));

vi.mock('../lib/schedule/permissions.js', () => ({
  canEmployeeEditSchedule: vi.fn(() => ({ ...overrides.employeePerm })),
  canManagerEditSchedule: vi.fn(() => ({ ...overrides.managerPerm })),
}));

vi.mock('../lib/schedule/change-logger.js', () => ({
  logScheduleChange: mockLogScheduleChange,
}));

vi.mock('../lib/schedule/work-hours.js', () => ({
  calculateScheduleWorkMinutes: vi.fn(() => 480),
}));

vi.mock('../lib/push.js', () => ({
  sendPushToRoles: mockSendPushToRoles,
  sendPushToEmployees: vi.fn(async () => ({ sent: 0 })),
  createNotificationsForRoles: mockCreateNotificationsForRoles,
  createNotifications: vi.fn(async () => undefined),
}));

vi.mock('../lib/attendance/recompute.js', () => ({
  recomputeAttendanceStatus: mockRecompute,
}));

const { default: handler } = await import('../api/schedules/[id].js');

function makeReqRes({ method = 'PUT', query = { id: 'S1' }, body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = []; calls.updates = []; calls.deletes = [];
  for (const k of Object.keys(dataByQuery)) delete dataByQuery[k];
  overrides.caller = { id: 'HR1', role: 'hr', is_manager: false, dept_id: 'D_HR' };
  overrides.recomputeReturn = { late_minutes: 0, early_arrival_minutes: 0, early_leave_minutes: 0, status: 'normal' };
  overrides.managerPerm = { ok: true, isLateChange: false };
  overrides.employeePerm = { ok: true };
  mockSendPushToRoles.mockClear();
  mockCreateNotificationsForRoles.mockClear();
  mockLogScheduleChange.mockClear();
  mockRecompute.mockClear();
});

function setSchedule(over = {}) {
  dataByQuery['schedules:maybeSingle'] = {
    id: 'S1', employee_id: 'E1', work_date: '2026-05-19', segment_no: 1,
    period_id: 'P1', shift_type_id: 'ST001',
    start_time: '09:00', end_time: '18:00', crosses_midnight: false,
    scheduled_work_minutes: 480, note: '', ...over,
  };
  dataByQuery['schedule_periods:maybeSingle'] = { id: 'P1', status: 'approved' };
}

function setAttendance(over = {}) {
  dataByQuery['attendance:maybeSingle'] = {
    id: 'A1', employee_id: 'E1', work_date: '2026-05-19', segment_no: 1,
    clock_in: '2026-05-19T09:25:00+08:00', clock_out: null,
    late_minutes: 25, early_arrival_minutes: 0, early_leave_minutes: 0,
    status: 'late', note: null, ...over,
  };
}

// ════════════════════════════════════════════════════════════
describe('PUT /api/schedules/:id — P8.1 cascade attendance recompute', () => {

  it('SC1: 改 start_time + attendance.status=late → cascade、late=0、status=normal、回應含 attendance_cascade', async () => {
    setSchedule({ start_time: '09:00' });
    setAttendance({ status: 'late', late_minutes: 25, early_arrival_minutes: 0 });
    overrides.recomputeReturn = { late_minutes: 0, early_arrival_minutes: 5, early_leave_minutes: 0, status: 'normal' };

    const [req, res] = makeReqRes({ body: { start_time: '09:30' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockRecompute).toHaveBeenCalledTimes(1);
    const attUpd = calls.updates.find(u => u.table === 'attendance');
    expect(attUpd).toBeDefined();
    expect(attUpd.patch.late_minutes).toBe(0);
    expect(attUpd.patch.early_arrival_minutes).toBe(5);
    expect(attUpd.patch.status).toBe('normal');
    expect(attUpd.patch.note).toMatch(/schedule change cascade by HR1: /);
    expect(attUpd.patch.note).toMatch(/late_minutes 25→0/);
    expect(attUpd.patch.note).toMatch(/status late→normal/);
    expect(res.body.attendance_cascade).toBeDefined();
    expect(res.body.attendance_cascade.attendance_id).toBe('A1');
    expect(res.body.attendance_cascade.changes.some(c => c.includes('late_minutes'))).toBe(true);
    expect(res.body.attendance_cascade.changes.some(c => c.includes('status'))).toBe(true);
  });

  it('SC2: 沒對應 attendance row → attendance_cascade=null、無 attendance write、recompute 不被叫', async () => {
    setSchedule({ start_time: '09:00' });
    // dataByQuery['attendance:maybeSingle'] 不 set → 回 null

    const [req, res] = makeReqRes({ body: { start_time: '09:30' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockRecompute).not.toHaveBeenCalled();
    expect(calls.updates.find(u => u.table === 'attendance')).toBeUndefined();
    expect(res.body.attendance_cascade).toBeNull();
  });

  it('SC3: attendance.status=leave (PRESERVED) → late_minutes 動仍寫、status 不動', async () => {
    setSchedule();
    setAttendance({ status: 'leave', late_minutes: 0 });
    // recompute 走 PRESERVED path:status 保留 leave、但仍算 late_minutes
    overrides.recomputeReturn = {
      late_minutes: 25, early_arrival_minutes: 0, early_leave_minutes: 0, status: 'leave',
    };

    const [req, res] = makeReqRes({ body: { start_time: '09:30' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const attUpd = calls.updates.find(u => u.table === 'attendance');
    expect(attUpd).toBeDefined();
    expect(attUpd.patch.status).toBe('leave');
    expect(attUpd.patch.late_minutes).toBe(25);
    expect(attUpd.patch.note).toMatch(/late_minutes 0→25/);
    // audit 不含 status 變化(leave→leave 一樣)
    expect(attUpd.patch.note).not.toMatch(/status leave→/);
  });

  it('SC4: recompute 結果跟原 attendance 完全一樣 → 不 update attendance', async () => {
    setSchedule();
    setAttendance({
      late_minutes: 5, early_arrival_minutes: 0, early_leave_minutes: 0, status: 'late',
    });
    overrides.recomputeReturn = {
      late_minutes: 5, early_arrival_minutes: 0, early_leave_minutes: 0, status: 'late',
    };

    const [req, res] = makeReqRes({ body: { start_time: '09:05' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockRecompute).toHaveBeenCalledTimes(1);
    expect(calls.updates.find(u => u.table === 'attendance')).toBeUndefined();
    expect(res.body.attendance_cascade).toBeNull();
  });

  it('SC5: isLateChange=true regression — log + late_change 通知 + cascade 都跑', async () => {
    const today = new Date().toISOString().slice(0, 10);
    setSchedule({ work_date: today });
    setAttendance({ work_date: today, status: 'late' });
    overrides.managerPerm = { ok: true, isLateChange: true };
    overrides.recomputeReturn = { late_minutes: 0, early_arrival_minutes: 0, early_leave_minutes: 0, status: 'normal' };

    const [req, res] = makeReqRes({ body: { start_time: '09:30' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.isLateChange).toBe(true);
    // schedule_change_logs 寫入
    expect(mockLogScheduleChange).toHaveBeenCalledTimes(1);
    // late_change 通知
    expect(mockSendPushToRoles).toHaveBeenCalled();
    // cascade 也跑(attendance UPDATE)
    expect(calls.updates.find(u => u.table === 'attendance')).toBeDefined();
    expect(res.body.attendance_cascade).toBeDefined();
  });
});

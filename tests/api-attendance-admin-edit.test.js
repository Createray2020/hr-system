// tests/api-attendance-admin-edit.test.js — P4.1:attendance PUT admin_edit cascade + audit
//
// 對 api/attendance/[id].js PUT handler 的 9 case 覆蓋:
//   C1: PUT clock_in only → recompute trigger、late_minutes 重算、status 變 'late'
//   C2: PUT status='leave' → PRESERVED、status 保留 'leave'、late/early 仍算
//   C3: PUT anomaly_note only → 不 trigger recompute、makeRepo / recompute 都不該被 call
//   C4: PUT clock_in 但 schedule = null → late=0 / early=0 / status='normal'
//   C5: PUT clock_in + caller 送 late_minutes=999 → 被 recompute 覆寫成正確值、late_minutes 不寫進 audit
//   C6: Audit format = `[YYYY-MM-DD] admin_edit by {actor}: field old→new`
//   C7: existing.note 已有內容 → 新 auditLine 在開頭、'\n' 分隔
//   C8: caller 送 anomaly_note 跟 existing 相同 → auditChanges 為空、不寫 note
//   C9: caller 送多欄位 → 全列同一 auditLine、', ' 分隔
//
// Mock 策略(對齊 tests/api-attendance-routing.test.js):
//   supabase chain by table、dataByTable['attendance:maybeSingle'] 控 SELECT/UPDATE 回值
//   auth.requireRole 回 overrides.caller
//   api/attendance/index.js::makeRepo 替成 stub repo(findSchedulesForDate 回 overrides.repoSchedules)
//   lib/attendance/recompute.js::recomputeAttendanceStatus 替成 vi.fn 回 overrides.recomputeReturn

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], updates: [] };
const dataByTable = {};
const overrides = {
  caller: { id: 'HR1', role: 'hr', is_manager: false, dept_id: 'D_HR' },
  recomputeReturn: { late_minutes: 0, early_arrival_minutes: 0, early_leave_minutes: 0, status: 'normal' },
  repoSchedules: [],
};

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn(() => c);
    c.update = vi.fn((patch) => { calls.updates.push({ table, patch }); return c; });
    c.delete = vi.fn(() => c);
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: dataByTable[`${table}:maybeSingle`] ?? null, error: null,
    }));
    c.single = vi.fn(() => Promise.resolve({
      data: dataByTable[`${table}:single`] ?? null, error: null,
    }));
    c.then = (onF, onR) => Promise.resolve({ data: [], error: null }).then(onF, onR);
    return c;
  }
  const client = { from: vi.fn((table) => { calls.tables.push(table); return chain(table); }) };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/auth.js', () => ({
  requireRole: vi.fn(async () => overrides.caller),
}));

// stub repo for makeRepo()
const mockFindSchedulesForDate = vi.fn(async () => overrides.repoSchedules);
const mockMakeRepo = vi.fn(() => ({
  findSchedulesForDate: mockFindSchedulesForDate,
}));
vi.mock('../api/attendance/index.js', () => ({
  makeRepo: mockMakeRepo,
  default: vi.fn(),
}));

// recomputeAttendanceStatus mock
const mockRecompute = vi.fn(() => ({ ...overrides.recomputeReturn }));
vi.mock('../lib/attendance/recompute.js', () => ({
  recomputeAttendanceStatus: mockRecompute,
}));

const { default: handler } = await import('../api/attendance/[id].js');

function makeReqRes({ method = 'PUT', query = { id: 'A1' }, body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = []; calls.updates = [];
  for (const k of Object.keys(dataByTable)) delete dataByTable[k];
  overrides.caller = { id: 'HR1', role: 'hr', is_manager: false, dept_id: 'D_HR' };
  overrides.recomputeReturn = { late_minutes: 0, early_arrival_minutes: 0, early_leave_minutes: 0, status: 'normal' };
  overrides.repoSchedules = [];
  mockFindSchedulesForDate.mockClear();
  mockMakeRepo.mockClear();
  mockRecompute.mockClear();
});

// existing row fixture(可被 case 覆蓋)
function setExistingAttendance(over = {}) {
  dataByTable['attendance:maybeSingle'] = {
    id: 'A1',
    employee_id: 'E1',
    work_date: '2026-05-19',
    segment_no: 1,
    clock_in: null,
    clock_out: null,
    late_minutes: 0,
    early_arrival_minutes: 0,
    early_leave_minutes: 0,
    work_hours: 0,
    overtime_hours: 0,
    status: 'absent',
    is_anomaly: false,
    anomaly_note: null,
    note: null,
    ...over,
  };
}

// ════════════════════════════════════════════════════════════
describe('PUT /api/attendance/:id — admin_edit cascade recompute + audit', () => {

  it('C1: PUT clock_in only → 觸發 recompute、status 改 late、late_minutes 重算', async () => {
    setExistingAttendance({ status: 'normal', clock_in: null });
    overrides.repoSchedules = [{ id: 'S1', segment_no: 1, start_time: '09:00', end_time: '18:00', crosses_midnight: false }];
    overrides.recomputeReturn = { late_minutes: 15, early_arrival_minutes: 0, early_leave_minutes: 0, status: 'late' };

    const [req, res] = makeReqRes({ body: { clock_in: '2026-05-19T09:15:00+08:00' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockMakeRepo).toHaveBeenCalledTimes(1);
    expect(mockRecompute).toHaveBeenCalledTimes(1);
    const upd = calls.updates.find(u => u.table === 'attendance');
    expect(upd.patch.clock_in).toBe('2026-05-19T09:15:00+08:00');
    expect(upd.patch.late_minutes).toBe(15);
    expect(upd.patch.status).toBe('late');
    // recompute schedule arg
    const [, schedArg] = mockRecompute.mock.calls[0];
    expect(schedArg?.segment_no).toBe(1);
  });

  it('C2: PUT status=leave → PRESERVED、status 保留 leave、late/early 仍寫', async () => {
    setExistingAttendance({ status: 'normal' });
    overrides.repoSchedules = [{ id: 'S1', segment_no: 1, start_time: '09:00', end_time: '18:00', crosses_midnight: false }];
    // recompute 給 caller 模擬 PRESERVED behavior:status 維持 'leave',late/early 仍回
    overrides.recomputeReturn = { late_minutes: 0, early_arrival_minutes: 0, early_leave_minutes: 0, status: 'leave' };

    const [req, res] = makeReqRes({ body: { status: 'leave' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'attendance');
    expect(upd.patch.status).toBe('leave');
    expect(upd.patch.late_minutes).toBe(0);
    expect(upd.patch.early_leave_minutes).toBe(0);
    // audit:status 是 caller 改的、且不在 MANAGED_FIELDS → 應入 audit
    expect(upd.patch.note).toMatch(/status normal→leave/);
  });

  it('C3: PUT anomaly_note only → 不 trigger recompute、makeRepo 不被 call', async () => {
    setExistingAttendance({ anomaly_note: 'old note', note: null });

    const [req, res] = makeReqRes({ body: { anomaly_note: 'new note' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockMakeRepo).not.toHaveBeenCalled();
    expect(mockRecompute).not.toHaveBeenCalled();
    const upd = calls.updates.find(u => u.table === 'attendance');
    expect(upd.patch.anomaly_note).toBe('new note');
    // 沒 late/early_arrival/early_leave/status 被覆寫
    expect(upd.patch).not.toHaveProperty('late_minutes');
    expect(upd.patch).not.toHaveProperty('status');
    expect(upd.patch.note).toMatch(/anomaly_note old note→new note/);
  });

  it('C4: PUT clock_in 但 schedule=null → recompute 收到 null、late=0/early=0/status=normal', async () => {
    setExistingAttendance({ status: 'normal' });
    overrides.repoSchedules = [];  // 沒排班
    overrides.recomputeReturn = { late_minutes: 0, early_arrival_minutes: 0, early_leave_minutes: 0, status: 'normal' };

    const [req, res] = makeReqRes({ body: { clock_in: '2026-05-19T09:00:00+08:00' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockRecompute).toHaveBeenCalledTimes(1);
    const [, schedArg] = mockRecompute.mock.calls[0];
    expect(schedArg).toBeNull();
    const upd = calls.updates.find(u => u.table === 'attendance');
    expect(upd.patch.late_minutes).toBe(0);
    expect(upd.patch.early_leave_minutes).toBe(0);
    expect(upd.patch.status).toBe('normal');
  });

  it('C5: PUT clock_in + caller 送 late_minutes=999 → 被 recompute 覆寫、且 late_minutes 不入 audit', async () => {
    setExistingAttendance({ status: 'normal', late_minutes: 0 });
    overrides.repoSchedules = [{ id: 'S1', segment_no: 1, start_time: '09:00', end_time: '18:00', crosses_midnight: false }];
    overrides.recomputeReturn = { late_minutes: 5, early_arrival_minutes: 0, early_leave_minutes: 0, status: 'late' };

    const [req, res] = makeReqRes({ body: { clock_in: '2026-05-19T09:05:00+08:00', late_minutes: 999 } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'attendance');
    // recompute 覆寫
    expect(upd.patch.late_minutes).toBe(5);
    expect(upd.patch.late_minutes).not.toBe(999);
    // audit 不含 late_minutes(RECOMPUTE_MANAGED_FIELDS 過濾)、但含 clock_in
    expect(upd.patch.note).toMatch(/clock_in /);
    expect(upd.patch.note).not.toMatch(/late_minutes/);
  });

  it('C6: Audit format = [YYYY-MM-DD] admin_edit by {actor}: ...', async () => {
    setExistingAttendance({ anomaly_note: null });

    const [req, res] = makeReqRes({ body: { anomaly_note: 'hello' } });
    await handler(req, res);

    const upd = calls.updates.find(u => u.table === 'attendance');
    expect(upd.patch.note).toMatch(
      /^\[\d{4}-\d{2}-\d{2}\] admin_edit by HR1: anomaly_note null→hello$/
    );
  });

  it('C7: existing.note 已有內容 → 新 auditLine 在開頭、\\n 分隔', async () => {
    setExistingAttendance({ anomaly_note: null, note: '舊備註\n第二行' });

    const [req, res] = makeReqRes({ body: { anomaly_note: 'x' } });
    await handler(req, res);

    const upd = calls.updates.find(u => u.table === 'attendance');
    // auditLine 在最前面、\n 分隔、後面接 existing.note 原文
    const lines = upd.patch.note.split('\n');
    expect(lines[0]).toMatch(/admin_edit by HR1: anomaly_note null→x/);
    expect(upd.patch.note).toContain('舊備註');
    expect(upd.patch.note).toContain('第二行');
  });

  it('C8: caller 送 anomaly_note 與 existing 相同 → auditChanges 為空、不寫 note', async () => {
    setExistingAttendance({ anomaly_note: 'same value', note: null });

    const [req, res] = makeReqRes({ body: { anomaly_note: 'same value' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'attendance');
    expect(upd.patch.anomaly_note).toBe('same value');
    // 無實際變更 → 不寫 note
    expect(upd.patch).not.toHaveProperty('note');
  });

  it('C9: caller 送多欄位變化 → 全列同一 auditLine、, 分隔', async () => {
    setExistingAttendance({ anomaly_note: null, is_anomaly: false });

    const [req, res] = makeReqRes({ body: { anomaly_note: 'foo', is_anomaly: true } });
    await handler(req, res);

    const upd = calls.updates.find(u => u.table === 'attendance');
    expect(upd.patch.note).toMatch(/anomaly_note null→foo/);
    expect(upd.patch.note).toMatch(/is_anomaly false→true/);
    // 同一行、用 ', ' 分隔
    expect(upd.patch.note).toMatch(/admin_edit by HR1: .*, /);
  });
});

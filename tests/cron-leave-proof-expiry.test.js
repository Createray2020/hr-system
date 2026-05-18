// tests/cron-leave-proof-expiry.test.js — repo SQL filter + 分流 UPDATE 驗證
//
// 重點:cron 必須:
//   1. SELECT leave_types(code, proof_expiry_action)— 給 sweep 分流用
//   2. SELECT leave_requests WHERE proof_status='required' AND proof_due_at < now
//   3. UPDATE 分流:
//      - convert       → set leave_type='personal' / proof_status='converted_to_personal'
//      - mark_expired  → 只 set proof_status='expired'(leave_type / status 不動)
//
// 策略:同 tests/cron-absence-detection.test.js、mock supabase 攔截 chain。
// 用 dataByTable 覆寫特定 table 的 SELECT 結果、模擬 prod row 進來看 UPDATE 怎麼分流。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], selects: [], eqs: [], lts: [], updates: [] };
// 控制 SELECT 回傳:per-table 指定 data,沒指定 → 預設空 array
const dataByTable = {};

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn((str) => { calls.selects.push({ table, str }); return c; });
    c.eq = vi.fn((col, val) => { calls.eqs.push({ table, col, val }); return c; });
    c.lt = vi.fn((col, val) => { calls.lts.push({ table, col, val }); return c; });
    c.update = vi.fn((patch) => { calls.updates.push({ table, patch }); return c; });
    c.order = vi.fn(() => c);
    c.limit = vi.fn(() => c);
    c.in = vi.fn(() => c);
    c.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    // SELECT 回 dataByTable[table] || [] (UPDATE chain 同樣會走 then、但 update().eq() 之後不再 await 結果)
    c.then = (onF, onR) => Promise.resolve({ data: dataByTable[table] ?? [], error: null }).then(onF, onR);
    return c;
  }
  const client = {
    from: vi.fn((table) => { calls.tables.push(table); return chain(table); }),
  };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/cron-auth.js', () => ({ requireCron: vi.fn(() => true) }));
vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(async () => ({ sent: 0 })),
  sendPushToRoles:     vi.fn(async () => ({ sent: 0 })),
  createNotification:  vi.fn(async () => undefined),
  createNotificationsForRoles: vi.fn(async () => undefined),
}));

const { default: handler } = await import('../api/cron-leave-proof-expiry.js');

function makeReqRes(query = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
  };
  return [{ method: 'GET', query, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = []; calls.selects = []; calls.eqs = []; calls.lts = []; calls.updates = [];
  for (const k of Object.keys(dataByTable)) delete dataByTable[k];
});

describe('cron-leave-proof-expiry — SELECT filter chain', () => {
  it('SELECT leave_requests 含 id / leave_type / proof_status / proof_due_at / handler_note', async () => {
    const [req, res] = makeReqRes({ now: '2026-05-10T00:00:00+08:00' });
    await handler(req, res);

    const sel = calls.selects.find(s => s.table === 'leave_requests');
    expect(sel).toBeDefined();
    expect(sel.str).toContain('id');
    expect(sel.str).toContain('employee_id');
    expect(sel.str).toContain('leave_type');
    expect(sel.str).toContain('proof_status');
    expect(sel.str).toContain('proof_due_at');
    expect(sel.str).toContain('handler_note');
  });

  it('SELECT leave_types(code, proof_expiry_action)— 給 sweep 分流用', async () => {
    const [req, res] = makeReqRes({ now: '2026-05-10T00:00:00+08:00' });
    await handler(req, res);
    const sel = calls.selects.find(s => s.table === 'leave_types');
    expect(sel).toBeDefined();
    expect(sel.str).toContain('code');
    expect(sel.str).toContain('proof_expiry_action');
  });

  it('eq proof_status=required + lt proof_due_at < now', async () => {
    const NOW = '2026-05-10T00:00:00+08:00';
    const [req, res] = makeReqRes({ now: NOW });
    await handler(req, res);

    const eqs = calls.eqs.filter(e => e.table === 'leave_requests');
    const proofEq = eqs.find(e => e.col === 'proof_status');
    expect(proofEq).toBeDefined();
    expect(proofEq.val).toBe('required');

    const lts = calls.lts.filter(e => e.table === 'leave_requests');
    const dueLt = lts.find(e => e.col === 'proof_due_at');
    expect(dueLt).toBeDefined();
    expect(dueLt.val).toBe(NOW);
  });

  it('SELECT 回空 → handler 200 / scanned=0 / converted=0 / marked_expired=0、不觸發 UPDATE', async () => {
    const [req, res] = makeReqRes({ now: '2026-05-10T00:00:00+08:00' });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, scanned: 0, converted: 0, marked_expired: 0 });
    expect(calls.updates.length).toBe(0);
  });

  it('沒帶 query.now → 用 server NOW(預設行為)', async () => {
    const [req, res] = makeReqRes({});
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const lts = calls.lts.filter(e => e.col === 'proof_due_at');
    expect(lts.length).toBe(1);
    expect(typeof lts[0].val).toBe('string');
    expect(lts[0].val).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // P3.1:cron 漏 status filter 是會把 cancelled / pending / rejected row 也轉事假的 bug。
  // 加 .eq('status', 'approved')、SQL filter 在 supabase 端、test 只驗 wiring。
  it("加 .eq('status', 'approved') 防止 cancelled / pending / rejected row 被誤動", async () => {
    const [req, res] = makeReqRes({ now: '2026-05-10T00:00:00+08:00' });
    await handler(req, res);
    const statusEq = calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'status');
    expect(statusEq).toBeDefined();
    expect(statusEq.val).toBe('approved');
  });
});

describe('cron-leave-proof-expiry — UPDATE 分流(convert vs mark_expired)', () => {
  it('convert action(sick)→ UPDATE leave_type=personal + proof_status=converted_to_personal', async () => {
    dataByTable.leave_types = [
      { code: 'sick',     proof_expiry_action: 'convert' },
      { code: 'marriage', proof_expiry_action: 'mark_expired' },
    ];
    dataByTable.leave_requests = [{
      id: 'L_sick', employee_id: 'E1', leave_type: 'sick',
      proof_status: 'required', proof_due_at: '2026-05-06T23:59:59+08:00',
      handler_note: null,
    }];
    const [req, res] = makeReqRes({ now: '2026-05-10T00:00:00+08:00' });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, scanned: 1, converted: 1, marked_expired: 0 });

    const upd = calls.updates.find(u => u.table === 'leave_requests');
    expect(upd).toBeDefined();
    expect(upd.patch.leave_type).toBe('personal');
    expect(upd.patch.proof_status).toBe('converted_to_personal');
    expect(upd.patch.handler_note).toContain('原假別 sick');
    expect(upd.patch.handler_note).toContain('自動轉事假');
  });

  it('mark_expired action(marriage)→ UPDATE 只 set proof_status=expired、leave_type 不動', async () => {
    dataByTable.leave_types = [
      { code: 'sick',     proof_expiry_action: 'convert' },
      { code: 'marriage', proof_expiry_action: 'mark_expired' },
    ];
    dataByTable.leave_requests = [{
      id: 'L_marriage', employee_id: 'E2', leave_type: 'marriage',
      proof_status: 'required', proof_due_at: '2026-05-06T23:59:59+08:00',
      handler_note: null,
    }];
    const [req, res] = makeReqRes({ now: '2026-05-10T00:00:00+08:00' });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, scanned: 1, converted: 0, marked_expired: 1 });

    const upd = calls.updates.find(u => u.table === 'leave_requests');
    expect(upd).toBeDefined();
    expect(upd.patch.proof_status).toBe('expired');
    // 守:mark_expired 路徑不能誤動 leave_type / status
    expect('leave_type' in upd.patch).toBe(false);
    expect('status'     in upd.patch).toBe(false);
    expect(upd.patch.handler_note).toContain('原假別 marriage');
    expect(upd.patch.handler_note).toContain('HR 個案處理');
  });

  it('混合(sick + marriage 都過期)→ 兩種 UPDATE 都跑、return 計數正確', async () => {
    dataByTable.leave_types = [
      { code: 'sick',     proof_expiry_action: 'convert' },
      { code: 'marriage', proof_expiry_action: 'mark_expired' },
    ];
    dataByTable.leave_requests = [
      { id: 'L_S', employee_id: 'E1', leave_type: 'sick',     proof_status: 'required', proof_due_at: '2026-05-06T23:59:59+08:00', handler_note: null },
      { id: 'L_M', employee_id: 'E2', leave_type: 'marriage', proof_status: 'required', proof_due_at: '2026-05-06T23:59:59+08:00', handler_note: null },
    ];
    const [req, res] = makeReqRes({ now: '2026-05-10T00:00:00+08:00' });
    await handler(req, res);

    expect(res.body).toMatchObject({ scanned: 2, converted: 1, marked_expired: 1 });
    const updates = calls.updates.filter(u => u.table === 'leave_requests');
    expect(updates).toHaveLength(2);
    const sickUpd = updates.find(u => u.patch.leave_type === 'personal');
    const marUpd  = updates.find(u => u.patch.proof_status === 'expired');
    expect(sickUpd).toBeDefined();
    expect(marUpd).toBeDefined();
  });

  it('leave_types 撈失敗 / map 缺對應 row → fallback convert(safety)', async () => {
    // 沒設 dataByTable.leave_types → 空 array → ltMap = {} → sweep fallback convert
    dataByTable.leave_requests = [{
      id: 'L_X', employee_id: 'E1', leave_type: 'marriage',
      proof_status: 'required', proof_due_at: '2026-05-06T23:59:59+08:00',
      handler_note: null,
    }];
    const [req, res] = makeReqRes({ now: '2026-05-10T00:00:00+08:00' });
    await handler(req, res);

    // fallback 應跑 convert(原本 marriage 該 mark_expired、但 map 缺)
    expect(res.body).toMatchObject({ converted: 1, marked_expired: 0 });
    const upd = calls.updates.find(u => u.table === 'leave_requests');
    expect(upd.patch.leave_type).toBe('personal');
  });

  it('return shape 含 marked_expired 欄位(契約守)', async () => {
    const [req, res] = makeReqRes({ now: '2026-05-10T00:00:00+08:00' });
    await handler(req, res);
    expect(res.body).toHaveProperty('marked_expired');
    expect(typeof res.body.marked_expired).toBe('number');
  });
});

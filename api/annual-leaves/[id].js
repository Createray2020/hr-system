// api/annual-leaves/[id].js
// PUT  /api/annual-leaves/:id  → HR 調整 granted_days / 結算 / 加 note
//
// body 支援的欄位:
//   - granted_days (number)  → 調整 granted,寫 manual_adjust log
//   - settle (boolean)       → 結算為 paid_out;settlement_amount 暫填 0
//                              (TODO Batch 9 由 lib/salary/settlement.js 算)
//   - note (string)
//
// 對應設計文件:docs/attendance-system-design-v1.md §4.3.3
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §7.6
//
// Routing 假設:同 holidays/[id].js precedent,Vercel 靜態檔名優先 dynamic route。

import { requireRole } from '../../lib/auth.js';
import { makeLeaveRepo } from '../leaves/_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'record id required' });

  const caller = await requireRole(req, res, ['hr', 'admin', 'ceo']);
  if (!caller) return;
  if (!['hr', 'admin', 'ceo'].includes(caller.role || '')) {
    return res.status(403).json({ error: 'HR / admin only' });
  }

  const repo = makeLeaveRepo();
  const recId = parseInt(id);
  if (!Number.isInteger(recId)) return res.status(400).json({ error: 'invalid id' });

  // 撈 current record(共用 supabase repo 沒有 by-id finder,直接 query)
  const list = await repo.listAnnualRecords({});
  const cur = list.find(r => r.id === recId);
  if (!cur) return res.status(404).json({ error: 'record not found' });

  const { granted_days, settle, note } = req.body || {};

  // 1. settle:結算為 paid_out
  if (settle === true) {
    if (cur.status !== 'active') {
      return res.status(409).json({ error: 'only active record can be settled' });
    }
    const remainingDays = Math.max(0, Number(cur.granted_days) - Number(cur.used_days));
    // settlement_amount=0 為 placeholder:HR settle 當下不算金額,
    // 由 Batch 9 的 lib/salary/calculator.js 月底跑時透過 lib/salary/settlement.js
    // 找「status='paid_out' 且 settlement_amount IN (0, NULL)」的 records 算金額並 update。已接通。
    const settlementAmount = 0;
    const updated = await repo.updateAnnualRecord(recId, {
      status: 'paid_out',
      settlement_amount: settlementAmount,
      settled_at: new Date().toISOString(),
      settled_by: caller.id || cur.employee_id,
      note: note !== undefined ? note : cur.note,
    });
    if (remainingDays > 0) {
      await repo.insertBalanceLog({
        employee_id: cur.employee_id,
        balance_type: 'annual',
        annual_record_id: recId,
        comp_record_id: null,
        leave_request_id: null,
        change_type: 'settle',
        hours_delta: -remainingDays * 8,
        changed_by: caller.id || cur.employee_id,
        reason: `manual settle by HR (TODO Batch 9 amount)`,
      });
    }
    return res.status(200).json({ record: updated });
  }

  // 2. 調整 granted_days
  const patch = {};
  if (granted_days !== undefined) {
    const n = Number(granted_days);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'invalid granted_days' });
    if (n < Number(cur.used_days)) {
      return res.status(400).json({ error: 'granted_days cannot be less than used_days' });
    }
    patch.granted_days = n;
    const delta = n - Number(cur.granted_days);
    if (delta !== 0) {
      await repo.insertBalanceLog({
        employee_id: cur.employee_id,
        balance_type: 'annual',
        annual_record_id: recId,
        comp_record_id: null,
        leave_request_id: null,
        change_type: 'manual_adjust',
        hours_delta: delta * 8,
        changed_by: caller.id || cur.employee_id,
        reason: `HR adjust granted_days ${cur.granted_days} → ${n}`,
      });
    }
  }
  if (note !== undefined) patch.note = note;

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'no fields to update' });
  }

  const updated = await repo.updateAnnualRecord(recId, patch);
  return res.status(200).json({ record: updated });
}

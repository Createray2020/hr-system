// api/salary/[id].js
// PUT /api/salary/:id                 一般 PUT(更新欄位;白名單)
// PUT /api/salary/:id?action=confirm  狀態轉 confirmed
// PUT /api/salary/:id?action=pay      狀態轉 paid + pay_date
//
// 同 Batch 3/4 模式:legacy + 新路徑共存,白名單合併。
// GENERATED column(gross_salary / net_salary)永遠不允許覆寫;_auto 欄位也不接受手改。

import { supabase } from '../../lib/supabase.js';
import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';

const ALLOWED_PUT = new Set([
  // legacy 欄位
  'overtime_pay', 'bonus', 'allowance', 'extra_allowance',
  'deduct_absence', 'deduct_labor_ins', 'deduct_health_ins', 'deduct_tax',
  'note',
  // Batch 9 新增 _manual 欄位
  'overtime_pay_manual', 'overtime_pay_note',
  'settlement_note',
  // 不接受:gross_salary / net_salary(GENERATED)、
  //         overtime_pay_auto / attendance_penalty_total / attendance_bonus_actual /
  //         comp_expiry_payout / settlement_amount / holiday_work_pay (_auto)、
  //         daily_wage_snapshot(凍結值)、absence_days(系統算)
]);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, action } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  if (action === 'confirm' && req.method === 'PUT') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;
    const { error } = await supabase.from('salary_records')
      .update({ status: 'confirmed', updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已確認' });
  }

  if (action === 'pay' && req.method === 'PUT') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;
    const { error } = await supabase.from('salary_records')
      .update({
        status: 'paid',
        pay_date: new Date().toISOString().split('T')[0],
        updated_at: new Date().toISOString(),
      }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已標記發放' });
  }

  if (req.method === 'PUT') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;
    const update = {};
    for (const k of Object.keys(req.body || {})) {
      if (!ALLOWED_PUT.has(k)) continue;
      update[k] = req.body[k];
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'no allowed fields to update' });
    }
    update.updated_at = new Date().toISOString();
    const { error } = await supabase.from('salary_records').update(update).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已更新' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// api/salary/batch.js — POST 批次產生薪資草稿
import { supabase } from '../../lib/supabase.js';

// 簡易勞健保費率（台灣 2024 參考值）
const LABOR_INS_RATE  = 0.001; // 員工自付勞保費 0.1%
const HEALTH_INS_RATE = 0.0236; // 健保費率 2.36%（員工自付 30%）
const TAX_RATE        = 0.05;   // 薪資所得稅 5%（簡化）
const LABOR_INS_CAP   = 45800;  // 投保薪資上限

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { year, month } = req.body;
  if (!year || !month) return res.status(400).json({ error: '缺少 year/month' });

  // 取得所有在職員工
  const { data: emps, error: empErr } = await supabase
    .from('employees').select('id, base_salary, extra_allowance').eq('status', 'active');
  if (empErr) return res.status(500).json({ error: empErr.message });

  // 查詢本月出勤以計算加班費（每小時加班費 = 底薪/240 * 1.33）
  const ymStart = `${year}-${String(month).padStart(2,'0')}-01`;
  const ymEndDate = new Date(year, month, 0);
  const ymEnd     = `${ymEndDate.getFullYear()}-${String(ymEndDate.getMonth()+1).padStart(2,'0')}-${String(ymEndDate.getDate()).padStart(2,'0')}`;

  const { data: attData } = await supabase
    .from('attendance')
    .select('employee_id, overtime_hours, status')
    .gte('work_date', ymStart).lte('work_date', ymEnd);

  const otMap     = {};
  const absentMap = {};
  (attData||[]).forEach(a => {
    otMap[a.employee_id]     = (otMap[a.employee_id]||0)     + (a.overtime_hours||0);
    absentMap[a.employee_id] = (absentMap[a.employee_id]||0) + (a.status==='absent'?1:0);
  });

  let created = 0;
  const records = [];

  for (const emp of emps) {
    const base         = parseFloat(emp.base_salary) || 0;
    const hourlyRate   = base / 240;
    const otHours      = otMap[emp.id] || 0;
    const otPay        = Math.round(otHours * hourlyRate * 1.33);
    const absentDays   = absentMap[emp.id] || 0;
    const deductAbsent = Math.round((base / 30) * absentDays);
    const insBase      = Math.min(base, LABOR_INS_CAP);
    const laborIns     = Math.round(insBase * LABOR_INS_RATE);
    const healthIns    = Math.round(insBase * HEALTH_INS_RATE * 0.3);
    const grossEst     = base + otPay;
    const tax          = grossEst > 88501 ? Math.round((grossEst - 88501) * TAX_RATE) : 0;
    const allowance      = 2000; // 固定交通津貼
    const extraAllowance = parseFloat(emp.extra_allowance) || 0;

    records.push({
      id:                  `S${emp.id}${year}${String(month).padStart(2,'0')}`,
      employee_id:         emp.id,
      year:                parseInt(year),
      month:               parseInt(month),
      base_salary:         base,
      overtime_pay:        otPay,
      bonus:               0,
      allowance,
      extra_allowance:     extraAllowance,
      deduct_absence:      deductAbsent,
      deduct_labor_ins: laborIns,
      deduct_health_ins:healthIns,
      deduct_tax:       tax,
      status:           'draft',
    });
  }

  // Insert，忽略已存在的
  const { error } = await supabase.from('salary_records')
    .upsert(records, { onConflict: 'employee_id,year,month', ignoreDuplicates: true });

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ total: records.length, message: '批次產生完成（已存在者略過）' });
}

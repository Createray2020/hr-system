-- ============================================================
-- Commit 4: insurance_settings 資料修正(2026 法規)— 已於 prod SQL Editor 執行
--   A 補建 3 筆(黃郁紋全職33300 / 林亮妤·吳芳儒兼職11100·29500)
--   B 關閉黃筠庭投保(insurance_settings + employees)
--   C 既有兼職降最低(鄭伃均/吳慧雯/范峯羽 → 11100/29500)
--   D 健保眷屬=1(李玟浩/吳慧雯;李惠玉維持0、眷屬掛李玟浩名下;許芳榕已離職不動)
--   E 全員顯示用保費欄同步 2026(計算端不讀、純顯示一致)
-- ============================================================
BEGIN;

INSERT INTO insurance_settings (id,employee_id,has_insurance,labor_ins_bracket,labor_ins_employee,labor_ins_company,health_ins_bracket,health_ins_employee,health_ins_company,health_ins_dependents,pension_rate,pension_company,pension_wage,pension_voluntary_rate,pension_voluntary_amount,employment_ins_eligible,created_at,updated_at)
SELECT 'INS_'||id,id,true,33300,833,2914,33300,516,1611,0,6,1998,33300,0,0,true,now(),now() FROM employees e WHERE name='黃郁紋' AND NOT EXISTS (SELECT 1 FROM insurance_settings i WHERE i.employee_id=e.id);
INSERT INTO insurance_settings (id,employee_id,has_insurance,labor_ins_bracket,labor_ins_employee,labor_ins_company,health_ins_bracket,health_ins_employee,health_ins_company,health_ins_dependents,pension_rate,pension_company,pension_wage,pension_voluntary_rate,pension_voluntary_amount,employment_ins_eligible,created_at,updated_at)
SELECT 'INS_'||id,id,true,11100,277,972,29500,458,1428,0,6,666,11100,0,0,true,now(),now() FROM employees e WHERE name='林亮妤' AND NOT EXISTS (SELECT 1 FROM insurance_settings i WHERE i.employee_id=e.id);
INSERT INTO insurance_settings (id,employee_id,has_insurance,labor_ins_bracket,labor_ins_employee,labor_ins_company,health_ins_bracket,health_ins_employee,health_ins_company,health_ins_dependents,pension_rate,pension_company,pension_wage,pension_voluntary_rate,pension_voluntary_amount,employment_ins_eligible,created_at,updated_at)
SELECT 'INS_'||id,id,true,11100,277,972,29500,458,1428,0,6,666,11100,0,0,true,now(),now() FROM employees e WHERE name='吳芳儒' AND NOT EXISTS (SELECT 1 FROM insurance_settings i WHERE i.employee_id=e.id);

UPDATE insurance_settings SET has_insurance=false, updated_at=now() WHERE id='INS_EMP_01251002';
UPDATE employees SET has_insurance=false WHERE id='EMP_01251002';

UPDATE insurance_settings SET labor_ins_bracket=11100, health_ins_bracket=29500, pension_wage=11100, updated_at=now()
WHERE employee_id IN (SELECT id FROM employees WHERE name IN ('鄭伃均','吳慧雯','范峯羽') AND status='active');

UPDATE insurance_settings SET health_ins_dependents=1, updated_at=now()
WHERE employee_id IN (SELECT id FROM employees WHERE name IN ('李玟浩','吳慧雯') AND status='active');

UPDATE insurance_settings SET
  labor_ins_employee  = round((labor_ins_bracket*0.023)::numeric) + CASE WHEN employment_ins_eligible THEN round((labor_ins_bracket*0.002)::numeric) ELSE 0 END,
  labor_ins_company   = round((labor_ins_bracket*0.0805)::numeric) + CASE WHEN employment_ins_eligible THEN round((labor_ins_bracket*0.007)::numeric) ELSE 0 END,
  health_ins_employee = round((health_ins_bracket*0.01551)::numeric) * (LEAST(COALESCE(health_ins_dependents,0),3)+1),
  health_ins_company  = round((health_ins_bracket*0.03102*1.56)::numeric),
  pension_company     = round((pension_wage*0.06)::numeric),
  updated_at = now()
WHERE has_insurance = true AND employee_id IN (SELECT id FROM employees WHERE status='active');

COMMIT;

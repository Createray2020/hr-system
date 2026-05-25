// api/employees/[id].js — GET one / PUT update / DELETE / /me route
import { supabase, supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth, requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES, isBackofficeRole } from '../../lib/roles.js';
import { syncDeptFields } from '../../lib/dept-sync.js';
import { addDeptNameSingle } from '../../lib/dept-name-mapper.js';
import { resolveAuthScopeWithDeptIds, makeDeptEmpIdsRepo, canSeeEmployee } from '../../lib/auth-scope.js';
import { logEmployeeChanges } from '../../lib/employee/change-logger.js';

// B26 批次 4:base_salary 改變時自動 recalc hourly_rate(防 hourly_rate=0 init bug 再次發生)
// 對齊 api/salary/_repo.js findEmployeeHourlyRate 公式:base / monthly_work_hours_base(預設 240)
// 同 transaction 一起 UPDATE、避免 race(前端改薪資但 hourly_rate 未跟著更新)
// 若 frontend 已自己算好 hourly_rate 傳進來、不覆蓋(以前端為準)
// In-place mutate body、不回傳;export 給 vitest 直接 unit test。
export function autoRecalcHourlyRate(body) {
  if (!body || typeof body !== 'object') return;
  if (body.base_salary === undefined) return;
  if (body.hourly_rate !== undefined) return; // 前端已算好、不覆寫
  const newBase = Number(body.base_salary);
  if (Number.isFinite(newBase) && newBase > 0) {
    body.hourly_rate = Math.round((newBase / 240) * 100) / 100;
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;

  // /api/employees/me — 用 JWT 找自己
  if (id === 'me') {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });
    const { data, error } = await supabaseAdmin
      .from('employees').select('*, departments(name)').eq('email', user.email).single();
    if (error) {
      return res.status(200).json({ id: null, name: user.email.split('@')[0], email: user.email, role: 'employee' });
    }
    addDeptNameSingle(data);
    return res.status(200).json(data);
  }

  // GET 員工詳情 — 自己看自己回完整、看別人回 16 欄位白名單（除非是 backoffice）
  if (req.method === 'GET') {
    const caller = await requireAuth(req, res);
    if (!caller) return;

    // Phase 2 收尾:row-level scope filter 對齊通用 GET (commit 20602d1)
    // 員工 → 只能查自己;主管 → 自己 + 本部門;HR/CEO/admin → 任何人
    // 放在 column 計算之前、403 時可省一次 .from('employees').select 的 DB round-trip
    const scope = await resolveAuthScopeWithDeptIds(caller, 'selfOrDept', makeDeptEmpIdsRepo(supabaseAdmin));
    if (!canSeeEmployee(scope, id)) {
      return res.status(403).json({ error: 'Forbidden:無權看此員工' });
    }

    const isSelf = caller.id === id;
    const isHR = isBackofficeRole(caller);
    const PUBLIC_FIELDS = 'id, emp_no, name, dept_id, position, role, is_manager, status, avatar, email, phone, hire_date, manager_id, employment_type, birth_date';
    const cols = (isSelf || isHR) ? '*' : PUBLIC_FIELDS;

    // C0-5a JOIN departments 補 dept_name
    const colsWithDept = (cols === '*') ? '*, departments(name)' : `${cols}, departments(name)`;
    const { data, error } = await supabaseAdmin.from('employees').select(colsWithDept).eq('id', id).single();
    if (error) return res.status(404).json({ error: '找不到員工' });
    addDeptNameSingle(data);
    return res.status(200).json(data);
  }

  if (req.method === 'PUT') {
    try {
      const caller = await requireRole(req, res, BACKOFFICE_ROLES, { allowManager: true });
      if (!caller) return;

      const body = req.body;
      await syncDeptFields(supabaseAdmin, body);

      // 0.2.2: PUT status=resigned 時、若沒帶 resigned_at、自動補當下時間
      // (前端「標離職」只傳 resign_date(預計離職日)、之前 audit gap、resigned_at 永遠 null)
      if (body.status === 'resigned' && !body.resigned_at) {
        body.resigned_at = new Date().toISOString();
      }

      // B26 批次 4:base_salary 改變自動 recalc hourly_rate(見頂部 autoRecalcHourlyRate helper)
      autoRecalcHourlyRate(body);

      // Phase 1.7.2:撈 before、給 audit 比對用(7 個白名單欄位)
      const { data: beforeRow } = await supabaseAdmin
        .from('employees')
        .select('id, name, dept_id, role, is_manager, base_salary, position, manager_id')
        .eq('id', id).maybeSingle();

      // 前端負責計算薪資欄位後傳入,PUT 只負責寫入 employees 資料表
      const { error } = await supabaseAdmin
        .from('employees')
        .update({ ...body, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) return res.status(500).json({ error: error.message });

      // Phase 1.7.2:寫 audit log(失敗不擋 update、log 是 audit、不卡業務)
      // after 用 body 直接比、syncDeptFields 已 mutate body 對齊 dept_id 關聯欄位
      try {
        if (beforeRow) {
          await logEmployeeChanges(makeChangeLogRepo(), {
            employee_id: id,
            before: beforeRow,
            after: body,
            changed_by: caller.id,
          });
        }
      } catch (logErr) {
        console.error('[employees PUT] audit log failed:', logErr.message);
      }

      // ── 薪資變動時檢查勞健保級距是否需要更新 ──────────────────────────
      const salaryFields = ['base_salary','attendance_bonus','grade_allowance','manager_allowance','extra_allowance'];
      const hasSalaryChange = salaryFields.some(f => body[f] !== undefined);

      if (hasSalaryChange) {
        const { data: updatedEmp } = await supabaseAdmin
          .from('employees').select('*').eq('id', id).single();

        if (updatedEmp && updatedEmp.employment_type !== 'part_time' && updatedEmp.has_insurance !== false) {
          const newMonthly = (updatedEmp.base_salary||0) + (updatedEmp.attendance_bonus||0) +
                             (updatedEmp.grade_allowance||0) + (updatedEmp.manager_allowance||0) +
                             (updatedEmp.extra_allowance||0);

          const { data: ins } = await supabaseAdmin
            .from('insurance_settings').select('*').eq('employee_id', id).single();

          if (ins && ins.has_insurance !== false) {
            // 0.2.2: 級距查詢、超出上限時 fallback 到最高級、不 throw
            // (對齊 public/insurance.html recommendBracket() 的 fallback 邏輯)
            let laborBracket = null;
            {
              const { data } = await supabaseAdmin
                .from('labor_insurance_brackets').select('*')
                .lte('monthly_wage_min', newMonthly).gte('monthly_wage_max', newMonthly)
                .maybeSingle();
              if (data) {
                laborBracket = data;
              } else {
                const { data: max } = await supabaseAdmin
                  .from('labor_insurance_brackets').select('*')
                  .order('bracket_level', { ascending: false }).limit(1).maybeSingle();
                laborBracket = max;
              }
            }

            let healthBracket = null;
            {
              const { data } = await supabaseAdmin
                .from('health_insurance_brackets').select('*')
                .lte('monthly_wage_min', newMonthly).gte('monthly_wage_max', newMonthly)
                .maybeSingle();
              if (data) {
                healthBracket = data;
              } else {
                const { data: max } = await supabaseAdmin
                  .from('health_insurance_brackets').select('*')
                  .order('bracket_level', { ascending: false }).limit(1).maybeSingle();
                healthBracket = max;
              }
            }

            const laborChanged  = laborBracket?.insured_salary  && laborBracket.insured_salary  !== Number(ins.labor_ins_bracket);
            const healthChanged = healthBracket?.insured_salary && healthBracket.insured_salary !== Number(ins.health_ins_bracket);

            if (laborChanged || healthChanged) {
              const changeId = 'ICR' + Date.now();
              const deps = ins.health_ins_dependents || 0;

              // 0.2.2: 修 stale pension 根因 — 薪資調整時同步重算 pension
              const oldPensionRate    = Number(ins.pension_rate)    || 6;
              const oldPensionCompany = Number(ins.pension_company) || 0;
              const newPensionCompany = Math.round(newMonthly * oldPensionRate / 100);

              await supabaseAdmin.from('insurance_change_requests').insert([{
                id: changeId,
                employee_id: id,
                requested_by: caller.id,    // 0.2.2: 補 audit gap (prod 6 row 全 null)
                old_monthly_salary:  Number(ins.labor_ins_bracket) || 0,
                new_monthly_salary:  newMonthly,
                old_labor_bracket:   ins.labor_ins_bracket,
                old_labor_employee:  ins.labor_ins_employee,
                old_labor_company:   ins.labor_ins_company,
                old_health_bracket:  ins.health_ins_bracket,
                old_health_employee: ins.health_ins_employee,
                old_health_company:  ins.health_ins_company,
                new_labor_bracket:   laborBracket?.insured_salary   || ins.labor_ins_bracket,
                new_labor_employee:  laborBracket?.employee_premium  || ins.labor_ins_employee,
                new_labor_company:   laborBracket?.company_premium   || ins.labor_ins_company,
                new_health_bracket:  healthBracket?.insured_salary   || ins.health_ins_bracket,
                new_health_employee: healthBracket
                  ? (healthBracket.employee_premium||0) + deps * (healthBracket.per_dependent||0)
                  : ins.health_ins_employee,
                new_health_company:  healthBracket?.company_premium  || ins.health_ins_company,
                old_pension_rate:    oldPensionRate,
                old_pension_company: oldPensionCompany,
                new_pension_rate:    oldPensionRate,
                new_pension_company: newPensionCompany,
                trigger_reason: '薪資調整觸發自動試算',
                status: 'pending',
              }]);

              return res.status(200).json({
                message: '員工資料已更新',
                insurance_change: {
                  triggered: true,
                  change_id: changeId,
                  labor_changed:  !!laborChanged,
                  health_changed: !!healthChanged,
                  old_labor_bracket:   ins.labor_ins_bracket,
                  old_health_bracket:  ins.health_ins_bracket,
                  old_labor_employee:  ins.labor_ins_employee,
                  old_health_employee: ins.health_ins_employee,
                  new_labor_bracket:   laborBracket?.insured_salary,
                  new_health_bracket:  healthBracket?.insured_salary,
                  new_labor_employee:  laborBracket?.employee_premium,
                  new_health_employee: healthBracket
                    ? (healthBracket.employee_premium||0) + deps * (healthBracket.per_dependent||0)
                    : ins.health_ins_employee,
                }
              });
            }
          }
        }
      }

      return res.status(200).json({ message: '已更新' });
    } catch(e) {
      return res.status(500).json({ error: e.message, stack: e.stack });
    }
  }

  if (req.method === 'DELETE') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;
    // Phase 1.7 MVP:寫入 resigned_at(精準)+ optional resigned_reason
    const reason = (req.body?.resigned_reason && String(req.body.resigned_reason).trim()) || null;
    const { error } = await supabaseAdmin
      .from('employees')
      .update({
        status: 'resigned',
        resigned_at: new Date().toISOString(),
        resigned_reason: reason,
      })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已設為離職' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Phase 1.7.2:repo 注入給 lib/employee/change-logger.js 用
function makeChangeLogRepo() {
  return {
    async batchInsertChangeLogs(rows) {
      if (!rows || rows.length === 0) return;
      const { error } = await supabaseAdmin.from('employee_change_logs').insert(rows);
      if (error) throw error;
    },
  };
}

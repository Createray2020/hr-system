// api/approvals.js
// GET  /api/approvals?type=configs                              → 所有申請類型設定
// GET  /api/approvals?id=XXX                                   → 單筆詳情（含步驟）
// GET  /api/approvals?type=list&applicant_id=XXX               → 我的申請
// GET  /api/approvals?type=pending&role=manager                → 待我審批
// GET  /api/approvals                                          → 全部申請
// POST /api/approvals { action: create|approve|reject|cancel|update_config }
//
// Phase 2.x.1 hotfix(CRITICAL):原本整支 handler 完全無 requireAuth,
// 任何人(甚至 unauthed)可批 / 拒 / 取消任何 request、approver_id 由 client 傳。
// 修補:
//   1. 加 requireAuth(任何 authed user 都能讀、寫加分項權限)
//   2. approve/reject 加 step role gate(對齊 effectiveApprovalRole + dept)
//   3. self-approval guard(applicant 不能簽自己的 request)
//   4. 跨 step 同人連簽 guard(避免主管 + ceo 同人雙簽)
//   5. approver_id 強制用 caller.id、不接受 client 傳
//   6. cancel 嚴守申請人本人(其他 role 不能取消別人的)

import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth } from '../lib/auth.js';
import { sendPushToEmployees, sendPushToRoles, createNotifications, createNotificationsForRoles } from '../lib/push.js';
import { addDeptNameNested, addDeptNameSingle } from '../lib/dept-name-mapper.js';
// B13:GET 5 個 path 加 dept-scope / 本人 / HR-only 守門
import { resolveAuthScopeWithDeptIds, makeDeptEmpIdsRepo, canSeeEmployee } from '../lib/auth-scope.js';
import { isBackofficeRole, canDeleteRecord } from '../lib/roles.js';
import { applyExpenseReimbursement } from '../lib/salary/expense-cascade.js';

// Batch 7 收尾(2026-06-09):加班申請禁入 approval_requests,改走 /overtime.html → overtime_requests。
// 守門三層:approval_flow_configs.is_active=false(DB)+ 本黑名單(server)+ approvals.html renderTypeCategories filter(前端)。
// migration:migrations/20260609_disable_overtime_approval_configs.sql
const OVERTIME_TYPES_BLOCKED = ['overtime', 'overtime_pay'];

// 防重複送出守門:create 路徑 INSERT 前查 3 秒內同(applicant, type, form_data)、命中回既有 id
// 對齊規格:不 INSERT、不建 approval_steps、response shape 同正常 create(idempotent、雙擊無感)。
const DEDUP_WINDOW_MS = 3000;

// 遞迴對物件 key 排序後 JSON.stringify;同內容 key 順序不同也會視為相等
function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// ─────────────────────────────────────────────────────────────────
// 離職檢核表 MVP 預設 46 項(對應 migrations/2026_05_26_resignation_checklist.sql)
// 由 applyResignation cascade 在離職核准完成後 bulk insert。
//
// 分 8 大類、編號 1-46:
//   1️⃣ HR 行政(9)/ 2️⃣ 薪資結算(6)/ 3️⃣ 系統權限撤銷(9)/ 4️⃣ 排班/出勤/假勤(5)
//   5️⃣ 組織關係(2)/ 6️⃣ 實體資產回收(7)/ 7️⃣ 工作交接(4)/ 8️⃣ 通知/Audit(4)
//
// AUTO_DONE_SEQS 列出 cascade 觸發時即可標 status='done' 的項目
// (對應「系統自動」的事務:status 翻轉 / login 擋 / push 清 / cascade 通知 / 離職原因記錄)
// ─────────────────────────────────────────────────────────────────
const AUTO_DONE_SEQS = new Set([16, 17, 23, 43, 44, 46]);
const RESIGNATION_CHECKLIST_SEED = [
  // 1️⃣ HR 行政(9 項)
  { category: '1_hr_admin',           category_label: '1️⃣ HR 行政',           item_seq: 1,  item_name: '勞保退保',                regulation_basis: '勞保條例§11、離職起 5 日內' },
  { category: '1_hr_admin',           category_label: '1️⃣ HR 行政',           item_seq: 2,  item_name: '健保退保',                regulation_basis: '健保法§15、離職起 3 日內' },
  { category: '1_hr_admin',           category_label: '1️⃣ HR 行政',           item_seq: 3,  item_name: '勞退提繳停止',            regulation_basis: '勞退條例§7' },
  { category: '1_hr_admin',           category_label: '1️⃣ HR 行政',           item_seq: 4,  item_name: '就業保險退保',            regulation_basis: '就保法§5' },
  { category: '1_hr_admin',           category_label: '1️⃣ HR 行政',           item_seq: 5,  item_name: '服務證明書',              regulation_basis: '勞基法§19、員工要求時提供' },
  { category: '1_hr_admin',           category_label: '1️⃣ HR 行政',           item_seq: 6,  item_name: '離職證明書',              regulation_basis: null },
  { category: '1_hr_admin',           category_label: '1️⃣ HR 行政',           item_seq: 7,  item_name: '所得稅扣繳憑單',          regulation_basis: '次年 1/31 前發放' },
  { category: '1_hr_admin',           category_label: '1️⃣ HR 行政',           item_seq: 8,  item_name: '健保眷屬轉出',            regulation_basis: '如有眷屬掛保' },
  { category: '1_hr_admin',           category_label: '1️⃣ HR 行政',           item_seq: 9,  item_name: '其他法定文件補充',         regulation_basis: null },

  // 2️⃣ 薪資結算(6 項)
  { category: '2_payroll',            category_label: '2️⃣ 薪資結算',          item_seq: 10, item_name: '最後月薪 pro-rata',       regulation_basis: '按實際工作日比例' },
  { category: '2_payroll',            category_label: '2️⃣ 薪資結算',          item_seq: 11, item_name: '加班費結算',              regulation_basis: '勞基法§24、積欠未發' },
  { category: '2_payroll',            category_label: '2️⃣ 薪資結算',          item_seq: 12, item_name: '特休未休折現',            regulation_basis: '勞基法§38-Ⅳ' },
  { category: '2_payroll',            category_label: '2️⃣ 薪資結算',          item_seq: 13, item_name: '補休餘額折現',            regulation_basis: null },
  { category: '2_payroll',            category_label: '2️⃣ 薪資結算',          item_seq: 14, item_name: '獎金/績效金 pro-rata',    regulation_basis: '視合約' },
  { category: '2_payroll',            category_label: '2️⃣ 薪資結算',          item_seq: 15, item_name: '預發薪資 / 借支扣回',      regulation_basis: '視個案' },

  // 3️⃣ 系統權限撤銷(9 項)
  { category: '3_system_access',      category_label: '3️⃣ 系統權限撤銷',      item_seq: 16, item_name: 'HR 系統 status=resigned', regulation_basis: '系統自動 ✅' },
  { category: '3_system_access',      category_label: '3️⃣ 系統權限撤銷',      item_seq: 17, item_name: 'HR 系統 login 擋下',      regulation_basis: '系統自動 ✅' },
  { category: '3_system_access',      category_label: '3️⃣ 系統權限撤銷',      item_seq: 18, item_name: 'Supabase Auth 帳號停用',  regulation_basis: '手動 supabase dashboard' },
  { category: '3_system_access',      category_label: '3️⃣ 系統權限撤銷',      item_seq: 19, item_name: '公司 email 帳號停用',     regulation_basis: 'Google Workspace / O365' },
  { category: '3_system_access',      category_label: '3️⃣ 系統權限撤銷',      item_seq: 20, item_name: 'Slack/Notion/SaaS 撤銷',  regulation_basis: null },
  { category: '3_system_access',      category_label: '3️⃣ 系統權限撤銷',      item_seq: 21, item_name: 'VPN / 內網存取撤銷',       regulation_basis: null },
  { category: '3_system_access',      category_label: '3️⃣ 系統權限撤銷',      item_seq: 22, item_name: '共享雲端硬碟所有權轉移',    regulation_basis: null },
  { category: '3_system_access',      category_label: '3️⃣ 系統權限撤銷',      item_seq: 23, item_name: 'Push subscription 清除',  regulation_basis: '系統自動 ✅' },
  { category: '3_system_access',      category_label: '3️⃣ 系統權限撤銷',      item_seq: 24, item_name: 'GitHub/GitLab 撤銷',     regulation_basis: '如適用' },

  // 4️⃣ 排班/出勤/假勤(5 項)
  { category: '4_schedule_attendance', category_label: '4️⃣ 排班/出勤/假勤',    item_seq: 25, item_name: '離職日後排班刪除',         regulation_basis: null },
  { category: '4_schedule_attendance', category_label: '4️⃣ 排班/出勤/假勤',    item_seq: 26, item_name: '離職日後 absent 清除',     regulation_basis: null },
  { category: '4_schedule_attendance', category_label: '4️⃣ 排班/出勤/假勤',    item_seq: 27, item_name: '未審完 leave_requests 取消', regulation_basis: null },
  { category: '4_schedule_attendance', category_label: '4️⃣ 排班/出勤/假勤',    item_seq: 28, item_name: '未審完 approval_requests 取消', regulation_basis: '非 resignation' },
  { category: '4_schedule_attendance', category_label: '4️⃣ 排班/出勤/假勤',    item_seq: 29, item_name: '未審完 overtime_requests 取消', regulation_basis: null },

  // 5️⃣ 組織關係(2 項)
  { category: '5_org_relation',       category_label: '5️⃣ 組織關係',          item_seq: 30, item_name: '部門 manager_id 轉移',     regulation_basis: '若是部門 manager' },
  { category: '5_org_relation',       category_label: '5️⃣ 組織關係',          item_seq: 31, item_name: '下屬 manager_id 轉移',     regulation_basis: '若有下屬' },

  // 6️⃣ 實體資產回收(7 項)
  { category: '6_physical_asset',     category_label: '6️⃣ 實體資產回收',      item_seq: 32, item_name: '電腦 / 筆電歸還',         regulation_basis: null },
  { category: '6_physical_asset',     category_label: '6️⃣ 實體資產回收',      item_seq: 33, item_name: '手機 / 平板歸還',         regulation_basis: '如配發' },
  { category: '6_physical_asset',     category_label: '6️⃣ 實體資產回收',      item_seq: 34, item_name: '門禁卡 / 識別證歸還',     regulation_basis: null },
  { category: '6_physical_asset',     category_label: '6️⃣ 實體資產回收',      item_seq: 35, item_name: '辦公室鑰匙歸還',           regulation_basis: null },
  { category: '6_physical_asset',     category_label: '6️⃣ 實體資產回收',      item_seq: 36, item_name: '印章 / 大小章交接',        regulation_basis: '如保管' },
  { category: '6_physical_asset',     category_label: '6️⃣ 實體資產回收',      item_seq: 37, item_name: '公務手機 SIM 卡停用',      regulation_basis: '如配發' },
  { category: '6_physical_asset',     category_label: '6️⃣ 實體資產回收',      item_seq: 38, item_name: '制服 / 員工專屬物品歸還',  regulation_basis: null },

  // 7️⃣ 工作交接(4 項)
  { category: '7_handover',           category_label: '7️⃣ 工作交接',          item_seq: 39, item_name: '交接清單確認',            regulation_basis: 'form_data.handover 已填' },
  { category: '7_handover',           category_label: '7️⃣ 工作交接',          item_seq: 40, item_name: '客戶 / 廠商聯絡轉交',      regulation_basis: null },
  { category: '7_handover',           category_label: '7️⃣ 工作交接',          item_seq: 41, item_name: '進行中專案 / 任務轉交',    regulation_basis: null },
  { category: '7_handover',           category_label: '7️⃣ 工作交接',          item_seq: 42, item_name: '離職面談 exit interview', regulation_basis: null },

  // 8️⃣ 通知 / Audit(4 項)
  { category: '8_notification_audit', category_label: '8️⃣ 通知/Audit',        item_seq: 43, item_name: 'HR 收到 cascade 通知',    regulation_basis: '系統自動 ✅' },
  { category: '8_notification_audit', category_label: '8️⃣ 通知/Audit',        item_seq: 44, item_name: '直屬主管通知',            regulation_basis: '系統自動 ✅' },
  { category: '8_notification_audit', category_label: '8️⃣ 通知/Audit',        item_seq: 45, item_name: '同部門同事知悉',          regulation_basis: null },
  { category: '8_notification_audit', category_label: '8️⃣ 通知/Audit',        item_seq: 46, item_name: '離職原因記錄 + 統計',     regulation_basis: '系統自動 ✅' },
];

/**
 * canApproveStep — caller 能否簽某 step。
 *
 * 規則(對齊 leave Phase 2.x dept+is_manager 嚴格設計):
 *   step.approver_role='manager':caller.is_manager=true && caller.dept_id === applicant.dept_id
 *   step.approver_role='ceo':    caller.role IN ('ceo','chairman')(admin 不視同)
 *   step.approver_role='hr':     caller.role IN ('hr','ceo','chairman')
 *                                B32:中小企業老闆兼 HR 場景、CEO/chairman 可代簽 HR step
 *                                (admin 不視同、保留既有「admin 不視同 hr」test 不 break)
 *   其他 role:caller.role === step.approver_role 嚴格對等
 *
 * self-approval 在外層擋(此函式只檢 role + dept、不看 applicant id)。
 */
function canApproveStep(caller, step, applicantDeptId) {
  if (!caller || !caller.id || !step) return false;
  const r = step.approver_role;
  if (r === 'manager') {
    return caller.is_manager === true
        && !!caller.dept_id
        && !!applicantDeptId
        && caller.dept_id === applicantDeptId;
  }
  if (r === 'ceo')  return caller.role === 'ceo' || caller.role === 'chairman';
  if (r === 'hr')   return ['hr', 'ceo', 'chairman'].includes(caller.role); // B32
  return caller.role === r;
}

/**
 * canCallerSeeAttachmentsOfRequest — 三條 OR gate(申請人本人 / backoffice /
 * 該單 current step 的 eligible approver)。
 *
 * 用於 sign_attachment_url 與 add_attachment 兩個 action 的權限守門。
 * 兩 action 的「讀附件 / 補附件」屬同一信任邊界(看得到就能補)、共用判斷。
 */
async function canCallerSeeAttachmentsOfRequest(caller, request) {
  if (!caller || !caller.id || !request) return false;
  if (caller.id === request.applicant_id) return true;
  if (isBackofficeRole(caller)) return true;
  // eligible approver of current step?
  const { data: step } = await supabaseAdmin
    .from('approval_steps').select('*')
    .eq('request_id', request.id).eq('step_number', request.current_step).maybeSingle();
  if (!step) return false;
  const { data: applicant } = await supabaseAdmin
    .from('employees').select('dept_id').eq('id', request.applicant_id).maybeSingle();
  return canApproveStep(caller, step, applicant?.dept_id);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Phase 2.x.1:整支 handler 加 requireAuth(原本完全無 auth、CRITICAL bug)
  const caller = await requireAuth(req, res);
  if (!caller) return;

  if (req.method === 'GET') {
    const { type, id, applicant_id, role, request_type } = req.query;

    // ── 申請類型設定 ────────────────────────────────────────────────────────
    // configs 是公開的流程定義(表單欄位 / 步驟 role)、不含個資、不需 scope
    if (type === 'configs') {
      const { data, error } = await supabaseAdmin
        .from('approval_flow_configs')
        .select('*').eq('is_active', true)
        .order('category').order('id');
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    }

    // B13:其餘 GET path 共用 scope(selfOrDept、對齊 leaves / employees endpoint)
    const scope = await resolveAuthScopeWithDeptIds(
      caller, 'selfOrDept', makeDeptEmpIdsRepo(supabaseAdmin),
    );

    // ── 單筆申請詳情（含步驟） ───────────────────────────────────────────────
    if (id) {
      const { data: reqData, error } = await supabaseAdmin
        .from('approval_requests')
        .select('*, employees!applicant_id(name, dept_id, position, avatar, departments(name))')
        .is('deleted_at', null)
        .eq('id', id).single();
      if (error) return res.status(404).json({ error: '找不到申請' });
      // B13:申請人本人 OR scope 看得到該員工 → OK,否則 403
      if (reqData.applicant_id !== caller.id && !canSeeEmployee(scope, reqData.applicant_id)) {
        return res.status(403).json({ error: '無權看此申請' });
      }
      if (reqData?.employees) addDeptNameSingle(reqData.employees);

      const { data: steps } = await supabaseAdmin
        .from('approval_steps')
        .select('*, employees!approver_id(name, position)')
        .eq('request_id', id).order('step_number');

      return res.status(200).json({ ...reqData, steps: steps || [] });
    }

    // ── 我的申請列表 ────────────────────────────────────────────────────────
    if (type === 'list' && applicant_id) {
      // B13:本人 OR scope 內 OK,亂猜別人 applicant_id → 403
      if (applicant_id !== caller.id && !canSeeEmployee(scope, applicant_id)) {
        return res.status(403).json({ error: '無權看此員工申請' });
      }
      let q = supabaseAdmin.from('approval_requests')
        .select('*').is('deleted_at', null).eq('applicant_id', applicant_id)
        .order('created_at', { ascending: false });
      if (request_type) q = q.eq('request_type', request_type);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      // Batch 7 收尾:approval_requests 不再顯示加班類(歷史殘留 row 過濾掉、未來也不會新增)
      const filtered = (data || []).filter(r => !OVERTIME_TYPES_BLOCKED.includes(r.request_type));
      return res.status(200).json(filtered);
    }

    // ── 待我審批（依角色取對應步驟） ──────────────────────────────────────────
    // B32:role='ceo'/'chairman' 撈 step_number IN (2, 3) 兼簽 HR step(中小企業老闆兼 HR)
    //      role='ceo'/'chairman' 場景不 filter approver_role(可能是 'ceo' 或 'hr')
    if (type === 'pending' && role) {
      const stepNums = role === 'manager' ? [1]
                     : (role === 'ceo' || role === 'chairman') ? [2, 3]
                     : [3];
      let query = supabaseAdmin
        .from('approval_steps')
        .select('*, approval_requests(*, employees!applicant_id(name, dept_id, position, avatar, departments(name)))')
        .in('step_number', stepNums)
        .eq('status', 'in_progress');
      // ceo/chairman 兼簽場景不限定 approver_role;其他 role 仍嚴格 filter
      if (role !== 'ceo' && role !== 'chairman') {
        query = query.eq('approver_role', role);
      }
      const { data: stepsRaw, error } = await query.order('created_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });

      // B13:role='manager' 時 JS-side dept-scope filter(對齊 api/pending-approvals.js)
      // 注意:大 dataset 時應改 supabase server-side filter、目前 manager dept 量級小、JS 足夠
      let steps = stepsRaw || [];
      if (role === 'manager') {
        if (scope.mode === 'dept') {
          const allowed = new Set([scope.selfId, ...(scope.deptEmpIds || [])]);
          steps = steps.filter(s => s.approval_requests && allowed.has(s.approval_requests.applicant_id));
        } else if (scope.mode === 'self') {
          // 邊角:is_manager 但無 dept_id(資料異常)→ 看不到任何 pending
          steps = [];
        }
        // mode='all' (HR/CEO 偽 manager 查詢、極少)→ 不 filter
      }
      addDeptNameNested(steps, 'employees', 'approval_requests');
      return res.status(200).json(steps);
    }

    // ── 全部申請 ────────────────────────────────────────────────────────────
    // B13:fallthrough HR-only(對齊 frontend canViewAllApprovals gate)
    if (!isBackofficeRole(caller)) {
      return res.status(403).json({
        error: '無權看全部申請、請改用 ?type=list&applicant_id=自己 或 ?type=pending',
      });
    }
    const { data, error } = await supabaseAdmin
      .from('approval_requests')
      .select('*, employees!applicant_id(name, dept_id, position, avatar, departments(name))')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    addDeptNameNested(data, 'employees');
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const body = req.body;

    // ── 建立新申請 ──────────────────────────────────────────────────────────
    if (body.action === 'create') {
      const { request_type, applicant_id, form_data, note, attachments } = body;
      // applicant_id 強制用 caller.id(防客戶端代提別人的)
      const realApplicantId = caller.id;
      if (applicant_id && applicant_id !== caller.id) {
        return res.status(403).json({ error: '不可代他人提出申請' });
      }

      // Batch 7 收尾:加班類禁入 approval_requests(走 /overtime.html → overtime_requests)
      if (OVERTIME_TYPES_BLOCKED.includes(request_type)) {
        return res.status(400).json({ error: '加班申請請改走 /overtime.html' });
      }

      // 防重複送出:3 秒內同申請人+同類型+同 form_data 已建立過 → 直接回既有 id
      // (雙擊「送出申請」按鈕的常見情境;前端 disable-on-submit 為第一道、本守門為第二道)
      const since = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
      const { data: recentSimilar } = await supabaseAdmin
        .from('approval_requests')
        .select('id, form_data, created_at')
        .eq('applicant_id', realApplicantId)
        .eq('request_type', request_type)
        .gte('created_at', since)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(5);
      const incomingSig = stableStringify(form_data || {});
      const dup = (recentSimilar || []).find(r => stableStringify(r.form_data || {}) === incomingSig);
      if (dup) {
        // shape 對齊正常 create:{ id, message, skipped_manager_step }
        return res.status(201).json({
          id: dup.id,
          message: '申請已送出',
          skipped_manager_step: false,
          deduplicated: true,
        });
      }

      const { data: config, error: cfgErr } = await supabaseAdmin
        .from('approval_flow_configs').select('*').eq('request_type', request_type).single();
      if (cfgErr || !config) return res.status(400).json({ error: '找不到申請類型設定' });

      const steps = config.steps;
      const reqId = 'APR' + Date.now();

      // B12:撈 applicant 資料、判斷是否要自動跳過 manager step
      //   sole-manager dept(僅自己一個 manager)→ 自己送 → 找不到其他可批的人 → 跳過 step 1
      //   採 C 案:step 1 row 留著、status='skipped'、approver_id=NULL、audit note 記錄原因
      const { data: applicant } = await supabaseAdmin
        .from('employees').select('id, dept_id, is_manager')
        .eq('id', realApplicantId).maybeSingle();
      let skipManagerStep = false;
      if (applicant?.is_manager) {
        const otherMgrs = await findOtherActiveManagersInDept(applicant.dept_id, applicant.id);
        skipManagerStep = otherMgrs.length === 0;
      }

      // current_step:第一個不被 skip 的 step number(全 skip 退化 fallback 用 steps[0])
      const firstActive = steps.find(s => !(s.role === 'manager' && skipManagerStep)) || steps[0];
      const initialCurrentStep = firstActive.step;

      const { error: insertErr } = await supabaseAdmin.from('approval_requests').insert([{
        id: reqId,
        request_type,
        title: config.type_name,
        applicant_id: realApplicantId,
        current_step: initialCurrentStep,
        total_steps: steps.length,
        status: 'pending',
        form_data: form_data || {},
        attachments: attachments || [],
        note: note || '',
      }]);
      if (insertErr) return res.status(500).json({ error: insertErr.message });

      for (const step of steps) {
        const shouldSkip = step.role === 'manager' && skipManagerStep;
        const initialStatus = shouldSkip
          ? 'skipped'
          : (step.step === initialCurrentStep ? 'in_progress' : 'waiting');
        await supabaseAdmin.from('approval_steps').insert([{
          id: `${reqId}_S${step.step}`,
          request_id: reqId,
          step_number: step.step,
          step_name: step.name,
          approver_role: step.role,
          status: initialStatus,
          approver_id: null,
          handled_at: shouldSkip ? new Date().toISOString() : null,
          note: shouldSkip ? 'B12: auto-skipped (sole manager in dept)' : '',
        }]);
      }

      return res.status(201).json({
        id: reqId,
        message: '申請已送出',
        skipped_manager_step: skipManagerStep,
      });
    }

    // ── 審批通過 ────────────────────────────────────────────────────────────
    if (body.action === 'approve') {
      const { request_id, step_number, note } = body;
      // approver_id 強制用 caller.id、不接受 client 傳(防偽造)

      // 撈 request + applicant dept_id(canApproveStep 需要)
      const { data: request } = await supabaseAdmin
        .from('approval_requests').select('*').is('deleted_at', null).eq('id', request_id).single();
      if (!request) return res.status(404).json({ error: '找不到申請' });

      // self-approval guard
      if (caller.id === request.applicant_id) {
        return res.status(403).json({ error: '不可審核自己的申請' });
      }

      // 撈當下要簽的 step
      const { data: step } = await supabaseAdmin
        .from('approval_steps').select('*')
        .eq('request_id', request_id).eq('step_number', step_number).maybeSingle();
      if (!step) return res.status(404).json({ error: '找不到該步驟' });
      if (step.status !== 'in_progress') {
        return res.status(409).json({ error: '此步驟非進行中、無法簽', actual: step.status });
      }

      // role gate(canApproveStep + applicant dept_id)
      const { data: applicant } = await supabaseAdmin
        .from('employees').select('dept_id').eq('id', request.applicant_id).maybeSingle();
      if (!canApproveStep(caller, step, applicant?.dept_id)) {
        return res.status(403).json({
          error: '無權審核此步驟',
          step_role: step.approver_role,
          your_role: caller.role,
        });
      }

      // B32:CEO/chairman 代簽 HR step 場景旗標
      // (公司無獨立 HR、由 CEO 兼;此 case 需要放寬跨 step 同人連簽 guard + 加 audit note)
      const isCeoActingAsHr = (caller.role === 'ceo' || caller.role === 'chairman')
                            && step.approver_role === 'hr';

      // 跨 step 同人連簽 guard:caller.id 已在其他 step 簽過 → 403
      // B32 例外:CEO/chairman 代簽 HR step 時允許跨 step 同人(本來就是同人兩個角色)
      const { data: priorSteps } = await supabaseAdmin
        .from('approval_steps').select('approver_id, step_number, status')
        .eq('request_id', request_id).neq('step_number', step_number);
      const alreadySigned = (priorSteps || [])
        .filter(s => s.status === 'approved' && s.approver_id === caller.id);
      if (alreadySigned.length > 0 && !isCeoActingAsHr) {
        return res.status(403).json({
          error: '同一人不可跨 step 連簽',
          previous_step: alreadySigned[0].step_number,
        });
      }

      // B32:加 audit note 標記 CEO 代簽
      const auditSuffix = ' [CEO 代簽 HR step(公司無獨立 HR)]';
      const finalNote = isCeoActingAsHr
        ? (note ? `${note}${auditSuffix}` : auditSuffix.trim())
        : (note || '');

      await supabaseAdmin.from('approval_steps').update({
        status: 'approved',
        approver_id: caller.id,           // 強制用 caller.id
        note: finalNote,
        handled_at: new Date().toISOString(),
      }).eq('request_id', request_id).eq('step_number', step_number);

      const nextStep = step_number + 1;
      if (nextStep > request.total_steps) {
        await supabaseAdmin.from('approval_requests').update({
          status: 'completed',
          current_step: step_number,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', request_id);

        // 補打卡(punch_correction):核准後自動寫入 attendance 表
        // 不寫的話 = 員工申請通過了但 DB 沒紀錄、薪資結算還是會少一天。
        if (request.request_type === 'punch_correction') {
          await applyPunchCorrection(request);
        }
        // B7:離職(resignation)核准 → cascade employees.status='resigned' + resigned_at + resigned_reason
        // 不 cascade 的話 HR 還要手動按「離職」button、容易漏(EMP_01251101 incident 根因)
        if (request.request_type === 'resignation') {
          await applyResignation(request, caller);
        }
        // Phase 4a:請款核准 → cascade 寫 salary_expense_entries(target=隔月)+ 兩段式結算
        // best-effort,失敗只 audit、不擋 approval
        if (request.request_type === 'expense_reimbursement') {
          await applyExpenseReimbursement(request, caller, req.body?.settlement_mode);
        }

        // 通知申請人:審批完成
        const _p1 = { title: '✅ 申請已全部通過', body: `你的「${request.title}」已完成所有審批流程`, url: '/approvals.html' };
        sendPushToEmployees([request.applicant_id], { ..._p1, tag: 'approval-' + request_id }).catch(() => {});
        createNotifications([request.applicant_id], { ..._p1, type: 'approval' }).catch(() => {});
      } else {
        await supabaseAdmin.from('approval_requests').update({
          status: 'in_progress',
          current_step: nextStep,
          updated_at: new Date().toISOString(),
        }).eq('id', request_id);
        await supabaseAdmin.from('approval_steps')
          .update({ status: 'in_progress' })
          .eq('request_id', request_id).eq('step_number', nextStep);

        // 通知申請人:本步驟通過,等待下一步
        const _p2 = { title: '✅ 審批步驟通過', body: `你的「${request.title}」第 ${step_number} 步已通過,進入下一審批`, url: '/approvals.html' };
        sendPushToEmployees([request.applicant_id], { ..._p2, tag: 'approval-' + request_id }).catch(() => {});
        createNotifications([request.applicant_id], { ..._p2, type: 'approval' }).catch(() => {});

        // 通知下一步審批人
        const { data: nextStepData } = await supabaseAdmin
          .from('approval_steps')
          .select('approver_role')
          .eq('request_id', request_id)
          .eq('step_number', nextStep)
          .single();
        if (nextStepData?.approver_role) {
          const _p3 = { title: '📋 有新的審批待辦', body: `「${request.title}」等待你審批(第 ${nextStep} 步)`, url: '/approvals.html' };
          sendPushToRoles([nextStepData.approver_role], { ..._p3, tag: 'pending-' + request_id }).catch(() => {});
          createNotificationsForRoles([nextStepData.approver_role], { ..._p3, type: 'approval' }).catch(() => {});
        }
      }

      return res.status(200).json({ message: '已審批通過' });
    }

    // ── 退回 ────────────────────────────────────────────────────────────────
    if (body.action === 'reject') {
      const { request_id, step_number, note } = body;

      const { data: request } = await supabaseAdmin
        .from('approval_requests').select('*').is('deleted_at', null).eq('id', request_id).single();
      if (!request) return res.status(404).json({ error: '找不到申請' });

      // self-approval guard
      if (caller.id === request.applicant_id) {
        return res.status(403).json({ error: '不可退回自己的申請' });
      }

      const { data: step } = await supabaseAdmin
        .from('approval_steps').select('*')
        .eq('request_id', request_id).eq('step_number', step_number).maybeSingle();
      if (!step) return res.status(404).json({ error: '找不到該步驟' });
      if (step.status !== 'in_progress') {
        return res.status(409).json({ error: '此步驟非進行中、無法退回', actual: step.status });
      }

      const { data: applicant } = await supabaseAdmin
        .from('employees').select('dept_id').eq('id', request.applicant_id).maybeSingle();
      if (!canApproveStep(caller, step, applicant?.dept_id)) {
        return res.status(403).json({
          error: '無權退回此步驟',
          step_role: step.approver_role,
          your_role: caller.role,
        });
      }

      await supabaseAdmin.from('approval_steps').update({
        status: 'rejected',
        approver_id: caller.id,
        note: note || '',
        handled_at: new Date().toISOString(),
      }).eq('request_id', request_id).eq('step_number', step_number);

      await supabaseAdmin.from('approval_requests').update({
        status: 'rejected',
        updated_at: new Date().toISOString(),
      }).eq('id', request_id);

      // 通知申請人:被退回
      const _p4 = { title: '❌ 申請已被退回', body: `你的「${request.title}」申請已被退回,請確認原因`, url: '/approvals.html' };
      sendPushToEmployees([request.applicant_id], { ..._p4, tag: 'approval-' + request_id }).catch(() => {});
      createNotifications([request.applicant_id], { ..._p4, type: 'approval' }).catch(() => {});

      return res.status(200).json({ message: '已退回' });
    }

    // ── 取消申請 ────────────────────────────────────────────────────────────
    if (body.action === 'cancel') {
      const { request_id } = body;
      const { data: request } = await supabaseAdmin
        .from('approval_requests').select('id, applicant_id, status').is('deleted_at', null).eq('id', request_id).maybeSingle();
      if (!request) return res.status(404).json({ error: '找不到申請' });
      if (caller.id !== request.applicant_id) {
        return res.status(403).json({ error: '只有申請人本人能取消' });
      }
      if (!['pending', 'in_progress'].includes(request.status)) {
        return res.status(409).json({ error: '此狀態不可取消', actual: request.status });
      }
      await supabaseAdmin.from('approval_requests').update({
        status: 'cancelled',
        updated_at: new Date().toISOString(),
      }).eq('id', request_id);
      return res.status(200).json({ message: '已取消' });
    }

    // ── 更新流程設定 ────────────────────────────────────────────────────────
    // ── 簽附件 URL ─────────────────────────────────────────────────────────
    // 申請人本人 / backoffice / current step 的 eligible approver → 對該單已存在的
    // 附件 path 簽 60 秒 signed URL(用 service-role bypass storage RLS)。
    // path 必須屬於該單 attachments 陣列、防任意簽別單的檔。
    if (body.action === 'sign_attachment_url') {
      const { request_id, path } = body;
      if (!request_id || !path) {
        return res.status(400).json({ error: 'request_id 與 path 必填' });
      }
      const { data: request } = await supabaseAdmin
        .from('approval_requests').select('*').is('deleted_at', null).eq('id', request_id).single();
      if (!request) return res.status(404).json({ error: '找不到申請' });

      const atts = Array.isArray(request.attachments) ? request.attachments : [];
      if (!atts.some(a => a && a.path === path)) {
        return res.status(403).json({ error: '附件不屬於此申請' });
      }
      if (!(await canCallerSeeAttachmentsOfRequest(caller, request))) {
        return res.status(403).json({ error: '無權看此附件' });
      }
      const { data: signed, error: signErr } = await supabaseAdmin.storage
        .from('leave-attachments').createSignedUrl(path, 60);
      if (signErr) return res.status(500).json({ error: signErr.message });
      return res.status(200).json({ signedUrl: signed?.signedUrl });
    }

    // ── 補件(append 附件 metadata 進 attachments JSONB[]) ──────────────────
    // 同 sign_attachment_url 的權限 gate。實體檔案由 client-side _sb.storage 上傳到
    // leave-attachments bucket(對齊 employee-leave.html 既有 pattern),本 action 只
    // 寫 metadata + audit 一行。uploaded_by 強制用 caller.id、不接受前端傳。
    if (body.action === 'add_attachment') {
      const { request_id, attachment } = body;
      if (!request_id || !attachment || typeof attachment !== 'object') {
        return res.status(400).json({ error: 'request_id 與 attachment 必填' });
      }
      for (const k of ['path', 'name']) {
        if (!attachment[k] || typeof attachment[k] !== 'string') {
          return res.status(400).json({ error: `附件 ${k} 必填` });
        }
      }
      const { data: request } = await supabaseAdmin
        .from('approval_requests').select('*').is('deleted_at', null).eq('id', request_id).single();
      if (!request) return res.status(404).json({ error: '找不到申請' });

      if (!(await canCallerSeeAttachmentsOfRequest(caller, request))) {
        return res.status(403).json({ error: '無權補件' });
      }

      const current = Array.isArray(request.attachments) ? request.attachments : [];
      const cleaned = {
        path: attachment.path,
        name: attachment.name,
        mime: typeof attachment.mime === 'string' ? attachment.mime : null,
        size: typeof attachment.size === 'number' ? attachment.size : null,
        uploaded_at: attachment.uploaded_at || new Date().toISOString(),
        uploaded_by: caller.id,  // 強制 caller.id、不信前端
      };
      const next = [...current, cleaned];
      const nowDate = new Date().toISOString().slice(0, 10);
      const auditLine = `[${nowDate}] attach by ${caller.id}: ${cleaned.name}`;
      const nextAudit = request.admin_audit_note
        ? `${auditLine}\n${request.admin_audit_note}`
        : auditLine;
      const { error: upErr } = await supabaseAdmin
        .from('approval_requests')
        .update({
          attachments: next,
          admin_audit_note: nextAudit,
          updated_at: new Date().toISOString(),
        })
        .eq('id', request_id);
      if (upErr) return res.status(500).json({ error: upErr.message });
      return res.status(200).json({ attachments: next, audit: auditLine });
    }

    // ── 移除附件(從 attachments 陣列濾掉 + 嘗試刪 storage 實體檔)─────────────
    // 權限三選一:backoffice(任何狀態)/ 該附件上傳者本人 / 申請人本人但限未定案
    //   (申請人在 completed/rejected/cancelled 不能再動附件,避免破壞已完結紀錄)
    // storage.remove 是 best-effort:DB metadata 才是 source of truth,實體檔失敗
    // 也回 200(可能已被 GC、key 已 rename、或 RLS)、避免 DB / storage 不一致時前端 stuck。
    if (body.action === 'remove_attachment') {
      const { request_id, path } = body;
      if (!request_id || !path) {
        return res.status(400).json({ error: 'request_id 與 path 必填' });
      }
      const { data: request } = await supabaseAdmin
        .from('approval_requests').select('*').is('deleted_at', null).eq('id', request_id).single();
      if (!request) return res.status(404).json({ error: '找不到申請' });

      const current = Array.isArray(request.attachments) ? request.attachments : [];
      const target = current.find(a => a && a.path === path);
      if (!target) return res.status(404).json({ error: '找不到該附件' });

      const isBackoffice = isBackofficeRole(caller);
      const isUploader   = target.uploaded_by === caller.id;
      const isApplicantEditable = request.applicant_id === caller.id
        && !['completed', 'rejected', 'cancelled'].includes(request.status);
      if (!isBackoffice && !isUploader && !isApplicantEditable) {
        return res.status(403).json({ error: '無權移除此附件' });
      }

      const next = current.filter(a => !a || a.path !== path);
      const nowDate = new Date().toISOString().slice(0, 10);
      const auditLine = `[${nowDate}] remove attachment by ${caller.id}: ${target.name || path}`;
      const nextAudit = request.admin_audit_note
        ? `${auditLine}\n${request.admin_audit_note}`
        : auditLine;

      const { error: upErr } = await supabaseAdmin
        .from('approval_requests')
        .update({
          attachments: next,
          admin_audit_note: nextAudit,
          updated_at: new Date().toISOString(),
        })
        .eq('id', request_id);
      if (upErr) return res.status(500).json({ error: upErr.message });

      // best-effort 刪 storage 實體檔
      try {
        await supabaseAdmin.storage.from('leave-attachments').remove([path]);
      } catch (storageErr) {
        console.warn('[remove_attachment] storage remove failed:', storageErr.message);
      }

      return res.status(200).json({ attachments: next, audit: auditLine });
    }

    // ── 撤回核准(completed → in_progress、回退到最後核准步驟重審)─────────────
    // 限 admin / chairman / ceo,reason 必填。樂觀鎖 WHERE status='completed' 防 race。
    // 連動類別擋:resignation / punch_correction 已產生 cascade 資料(員工狀態變更 /
    // 補打卡 attendance row),不允許直接撤回(否則 cascade 不一致),需管理員手動處理。
    // 重置策略:target step(approved 最大 step_number)→ in_progress;target 之後的
    // step 強制 waiting(防禦性);target 前的 skipped/approved 不動。
    if (body.action === 'revoke_approval') {
      const { request_id, reason } = body;
      if (!request_id) return res.status(400).json({ error: 'request_id required' });
      if (!reason || typeof reason !== 'string' || !reason.trim()) {
        return res.status(400).json({ error: '撤回理由必填' });
      }
      const trimmedReason = reason.trim();
      if (trimmedReason.length > 500) {
        return res.status(400).json({ error: '撤回理由過長(上限 500 字)' });
      }

      const isExecutive = ['admin', 'chairman', 'ceo'].includes(caller.role);
      if (!isExecutive) {
        return res.status(403).json({ error: '無撤回權限(限 admin / chairman / ceo)' });
      }

      const { data: request } = await supabaseAdmin
        .from('approval_requests').select('*').is('deleted_at', null).eq('id', request_id).single();
      if (!request) return res.status(404).json({ error: '找不到申請' });
      if (request.status !== 'completed') {
        return res.status(409).json({ error: '此申請非已完成狀態、無法撤回', actual: request.status });
      }
      if (['resignation', 'punch_correction'].includes(request.request_type)) {
        return res.status(422).json({
          error: 'CASCADE_LOCKED',
          detail: '此類申請已產生連動資料(離職 / 補打卡)、無法直接撤回、請管理員手動處理',
          request_type: request.request_type,
        });
      }

      // 找 target step = approved 步驟裡最大的 step_number(最後核准的步驟)
      const { data: allSteps } = await supabaseAdmin
        .from('approval_steps').select('*')
        .eq('request_id', request_id).order('step_number');
      const approvedSteps = (allSteps || []).filter(s => s.status === 'approved');
      if (approvedSteps.length === 0) {
        return res.status(409).json({ error: '找不到可重開的核准步驟' });
      }
      const target = approvedSteps[approvedSteps.length - 1];
      const targetNum = target.step_number;

      // 樂觀鎖 update request:WHERE status='completed' 防 race
      const nowIso = new Date().toISOString();
      const nowDate = nowIso.slice(0, 10);
      const auditLine = `[${nowDate}] revoke by ${caller.id}: completed→in_progress (重開步驟 ${targetNum}) 理由: ${trimmedReason}`;
      const nextAudit = request.admin_audit_note
        ? `${auditLine}\n${request.admin_audit_note}`
        : auditLine;
      const { data: updReq, error: updReqErr } = await supabaseAdmin
        .from('approval_requests')
        .update({
          status: 'in_progress',
          current_step: targetNum,
          completed_at: null,
          admin_audit_note: nextAudit,
          updated_at: nowIso,
        })
        .eq('id', request_id).eq('status', 'completed')
        .select().maybeSingle();
      if (updReqErr) return res.status(500).json({ error: updReqErr.message });
      if (!updReq) return res.status(409).json({ error: 'STATUS_RACE_CONDITION' });

      // target step → in_progress(重開)、清 approver_id/handled_at/note
      await supabaseAdmin.from('approval_steps')
        .update({ status: 'in_progress', approver_id: null, handled_at: null, note: null })
        .eq('request_id', request_id).eq('step_number', targetNum);

      // 防禦性:target 之後的 step(理論上 completed 時應該都是 approved/skipped,
      // 不該有 waiting 以外的狀態,但保險起見強制 reset)
      await supabaseAdmin.from('approval_steps')
        .update({ status: 'waiting', approver_id: null, handled_at: null, note: null })
        .eq('request_id', request_id).gt('step_number', targetNum);

      // 通知申請人 + target step approver_role
      const _p1 = {
        title: '↩ 申請已被撤回核准',
        body: `你的「${request.title}」已被撤回核准、退回至第 ${targetNum} 步重新審核`,
        url: '/approvals.html',
      };
      sendPushToEmployees([request.applicant_id], { ..._p1, tag: 'approval-' + request_id }).catch(() => {});
      createNotifications([request.applicant_id], { ..._p1, type: 'approval' }).catch(() => {});

      if (target.approver_role) {
        const _p2 = {
          title: '📋 有撤回案待重審',
          body: `「${request.title}」第 ${targetNum} 步已被撤回核准、需重新審批`,
          url: '/approvals.html',
        };
        sendPushToRoles([target.approver_role], { ..._p2, tag: 'pending-' + request_id }).catch(() => {});
        createNotificationsForRoles([target.approver_role], { ..._p2, type: 'approval' }).catch(() => {});
      }

      return res.status(200).json({ request: updReq, target_step: targetNum, audit: auditLine });
    }

    if (body.action === 'update_config') {
      // 僅 hr / admin 可改流程設定(對齊 lib/roles.js::canEditApprovalConfig)
      if (!['hr', 'admin'].includes(caller.role)) {
        return res.status(403).json({ error: '無權修改流程設定' });
      }
      const { config_id, steps } = body;
      const { error } = await supabaseAdmin.from('approval_flow_configs')
        .update({ steps }).eq('id', config_id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: '流程已更新' });
    }

    // ── 進階編輯既有申請 ────────────────────────────────────────────────────
    // P7.1:HR / admin / CEO / chairman 修正 applicant 提錯的 form_data / 漏附的
    // attachments。其他欄位走既有 flow:status / current_step 走 approve/reject/cancel、
    // request_type / applicant_id / created_at 不可改、approval_steps 不允許 step-level
    // admin_edit。Audit 寫進 admin_audit_note(2026-05-19 migration 新欄位)。
    if (body.action === 'admin_edit') {
      if (!['hr', 'admin', 'ceo', 'chairman'].includes(caller.role)) {
        return res.status(403).json({ error: '無權進階編輯申請' });
      }
      const { id } = body;
      if (!id) return res.status(400).json({ error: 'id required' });

      const { data: existing } = await supabaseAdmin
        .from('approval_requests').select('*').is('deleted_at', null).eq('id', id).maybeSingle();
      if (!existing) return res.status(404).json({ error: '找不到申請' });

      // 白名單:只 form_data + attachments
      const callerPatch = {};
      if (body.form_data !== undefined) callerPatch.form_data = body.form_data;
      if (body.attachments !== undefined) callerPatch.attachments = body.attachments;
      if (Object.keys(callerPatch).length === 0) {
        return res.status(400).json({ error: 'no allowed fields to update' });
      }

      // validate
      if ('form_data' in callerPatch) {
        const fd = callerPatch.form_data;
        if (fd === null || typeof fd !== 'object' || Array.isArray(fd)) {
          return res.status(400).json({ error: 'invalid form_data', detail: 'must be plain object' });
        }
      }
      if ('attachments' in callerPatch && !Array.isArray(callerPatch.attachments)) {
        return res.status(400).json({ error: 'invalid attachments', detail: 'must be array' });
      }

      // diff audit changes
      const changes = [];
      if ('form_data' in callerPatch) {
        const oldFd = existing.form_data || {};
        const newFd = callerPatch.form_data;
        const allKeys = new Set([...Object.keys(oldFd), ...Object.keys(newFd)]);
        const changedKeys = [];
        for (const k of allKeys) {
          if (JSON.stringify(oldFd[k]) !== JSON.stringify(newFd[k])) changedKeys.push(k);
        }
        if (changedKeys.length > 0) changes.push(`form_data.{${changedKeys.join(', ')}} updated`);
      }
      if ('attachments' in callerPatch) {
        const oldAtt = existing.attachments || [];
        const newAtt = callerPatch.attachments;
        if (JSON.stringify(oldAtt) !== JSON.stringify(newAtt)) changes.push('attachments updated');
      }
      if (changes.length === 0) {
        return res.status(400).json({ error: 'no actual changes', detail: 'all submitted fields equal existing values' });
      }

      // audit log
      const nowDate = new Date().toISOString().slice(0, 10);
      const auditLine = `[${nowDate}] admin_edit by ${caller.id}: ${changes.join(', ')}`;
      const finalPatch = {
        ...callerPatch,
        admin_audit_note: existing.admin_audit_note
          ? `${auditLine}\n${existing.admin_audit_note}`
          : auditLine,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await supabaseAdmin
        .from('approval_requests').update(finalPatch).eq('id', id).select().maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, request: data, audit: auditLine });
    }

    // ── 軟刪除既有申請 ──────────────────────────────────────────────────────
    // 權限放寬(2026-06-12):
    //   - admin / chairman → 可刪任何狀態(原有行為、含 completed,清測試紀錄)
    //   - 其他後台角色(hr/ceo)→ 可刪 pending / in_progress(未觸發 cascade、安全)
    //   - 一般員工 → 403
    // 必填 reason。寫入 deleted_at/deleted_by/delete_reason 三欄 + append admin_audit_note。
    // 後續 SELECT 全部已加 .is('deleted_at',null) filter,刪除後不再出現在任何列表 / 詳情 / 待審。
    // 還原:DB 直接 UPDATE SET deleted_at=NULL(無 UI 入口)。
    if (body.action === 'delete') {
      const { id, reason } = body;
      if (!id) return res.status(400).json({ error: 'id required' });
      if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
        return res.status(400).json({ error: '刪除理由必填' });
      }
      const trimmedReason = reason.trim();
      if (trimmedReason.length > 500) {
        return res.status(400).json({ error: '刪除理由過長(上限 500 字)' });
      }

      // 撈 existing(.is('deleted_at',null) 防重複刪除已刪除的)
      const { data: existing } = await supabaseAdmin
        .from('approval_requests')
        .select('id, status, admin_audit_note, deleted_at')
        .is('deleted_at', null)
        .eq('id', id)
        .maybeSingle();
      if (!existing) return res.status(404).json({ error: '找不到申請' });

      // 權限判定:admin/chairman 任何狀態 OR 後台角色 + pending/in_progress
      const isFullDelete = canDeleteRecord(caller);
      const isBackoffice = isBackofficeRole(caller);
      const isEarlyStatus = ['pending', 'in_progress'].includes(existing.status);
      if (!isFullDelete && !(isBackoffice && isEarlyStatus)) {
        return res.status(403).json({ error: '無權限刪除此申請' });
      }

      const now = new Date();
      const noteLine = `[${now.toISOString().slice(0, 10)}] deleted by ${caller.id}: ${trimmedReason}`;
      const newNote = existing.admin_audit_note
        ? `${existing.admin_audit_note}\n${noteLine}`
        : noteLine;

      const { error: updErr } = await supabaseAdmin
        .from('approval_requests')
        .update({
          deleted_at: now.toISOString(),
          deleted_by: caller.id,
          delete_reason: trimmedReason,
          admin_audit_note: newNote,
        })
        .eq('id', id);
      if (updErr) return res.status(500).json({ error: updErr.message });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: '未知的 action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─────────────────────────────────────────────────────────────────
// 補打卡核准後 → 寫入 attendance 表
//
// form_data 從前端 approvals.html line 244-247 來:
//   correction_date  : 'YYYY-MM-DD'
//   correction_type  : '上班打卡' | '下班打卡'
//   expected_time    : 'HH:MM'
//   reason           : 員工說明
//
// 寫入策略:
//   1. 先找該員工該日已有的 attendance row(可能是漏打卡的同一天但只打了上班 / 下班)
//   2. 有 row → UPDATE 對應欄位(clock_in 或 clock_out)
//   3. 沒 row → INSERT 新 row、含 schedule_id(從 schedules 抓)
//   4. 若同時有 clock_in + clock_out,自動算 work_hours
//   5. 失敗(例如沒 schedule、或 DB error)只 log,不影響 approval status —
//      員工會在 attendance 列表發現沒寫進去、可請 HR 走人工補登
//      (寧可 approval 已 completed 但資料寫失敗,也不要 approval 已 completed 但 rollback)
// ─────────────────────────────────────────────────────────────────
async function applyPunchCorrection(request) {
  try {
    const fd = request.form_data || {};
    const employee_id = request.applicant_id;
    const work_date   = fd.correction_date;
    const punchTime   = fd.expected_time;     // 'HH:MM'
    const punchType   = fd.correction_type;   // '上班打卡' | '下班打卡'
    const reason      = fd.reason || '';

    if (!employee_id || !work_date || !punchTime || !punchType) {
      console.error('[applyPunchCorrection] 缺少必要欄位', { request_id: request.id, fd });
      return;
    }

    const isClockIn = punchType === '上班打卡';
    // 組 Asia/Taipei timezone 的 ISO timestamp
    const punchIso = `${work_date}T${punchTime}:00+08:00`;

    // 查當天已有 attendance row
    const { data: existing } = await supabaseAdmin
      .from('attendance').select('id, clock_in, clock_out, schedule_id, segment_no')
      .eq('employee_id', employee_id).eq('work_date', work_date)
      .maybeSingle();

    if (existing) {
      // 已有 row → 補對應欄位
      const update = isClockIn
        ? { clock_in: punchIso }
        : { clock_out: punchIso };
      // 兩端都有就算 work_hours
      const newClockIn  = isClockIn  ? punchIso : existing.clock_in;
      const newClockOut = isClockIn  ? existing.clock_out : punchIso;
      if (newClockIn && newClockOut) {
        update.work_hours = Math.max(0,
          Math.round((new Date(newClockOut) - new Date(newClockIn)) / 36000) / 100);
      }
      update.note = `補打卡(approval ${request.id}):${reason}`;
      await supabaseAdmin.from('attendance').update(update).eq('id', existing.id);
      return;
    }

    // 沒 row → INSERT 新 row,先撈 schedule_id 連結
    const { data: sched } = await supabaseAdmin
      .from('schedules').select('id, segment_no')
      .eq('employee_id', employee_id).eq('work_date', work_date)
      .order('segment_no').limit(1).maybeSingle();

    const insert = {
      id: `AC_${request.id}`, // AC = attendance from correction
      employee_id, work_date,
      schedule_id: sched?.id || null,
      segment_no: sched?.segment_no || 1,
      clock_in:  isClockIn ? punchIso : null,
      clock_out: isClockIn ? null     : punchIso,
      work_hours: 0,
      overtime_hours: 0,
      status: 'normal',
      note: `補打卡(approval ${request.id}):${reason}`,
    };
    await supabaseAdmin.from('attendance').insert([insert]);
  } catch (err) {
    // 不擋 approval status,只記 log
    console.error('[applyPunchCorrection] 寫入失敗', { request_id: request.id, err: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────
// B7:離職核准 → 自動 cascade 員工 employees.status='resigned'
//
// form_data 從 approvals.html 的 FORM_SCHEMA.resignation 來:
//   resign_date : 'YYYY-MM-DD' 預計離職日(approve 後寫入 resigned_at)
//   reason      : 員工填的離職原因(寫入 resigned_reason)
//   handover    : 交接事項(不寫入 employees、保留在 form_data 給 HR 看)
//
// 設計:
//   1. β 方案:不寫 employee_change_logs(CHECK 不允許 'status' 欄位、不擴 schema)
//      audit 走 approval_requests.completed_at + approval_steps.approver_id/handled_at
//      + employees.resigned_at + Vercel function logs
//   2. Idempotent guard:先撈 employees row、status 已 'resigned' 直接 return
//      (兩張 resignation 都 approve 的極端 case、第二張不重複 cascade)
//   3. try/catch best-effort:cascade 失敗只 log、不擋 approval completed
//      (寧可 approval 已 completed 但 employees 沒同步、也不要 rollback approval)
//   4. resigned_at 寫成 `${resign_date}T00:00:00+08:00`(可能是未來日)、
//      login.html 透過 LoginCheck.shouldBlockResignedLogin 在預計離職日當下才擋
// ─────────────────────────────────────────────────────────────────
async function applyResignation(request, caller) {
  try {
    const fd = request.form_data || {};
    const employee_id = request.applicant_id;
    const resign_date = fd.resign_date;
    const reason      = fd.reason || null;

    if (!employee_id) {
      console.error('[applyResignation] missing applicant_id', { request_id: request.id });
      return;
    }

    // 撈現況 + idempotent guard(name 給 cascade enhancement 3 HR 通知用;
    // base_salary / hourly_rate 給 Enhancement #4/#5 結算公式用 — B26 批次 2)
    const { data: before, error: beforeErr } = await supabaseAdmin
      .from('employees').select('id, name, status, resigned_at, base_salary, hourly_rate')
      .eq('id', employee_id).maybeSingle();

    if (beforeErr) {
      console.error('[applyResignation] employees fetch failed',
        { request_id: request.id, employee_id, err: beforeErr.message });
      return;
    }
    if (!before) {
      console.error('[applyResignation] employee not found',
        { request_id: request.id, employee_id });
      return;
    }
    if (before.status === 'resigned') {
      console.log('[applyResignation] employee already resigned, skip',
        { request_id: request.id, employee_id, before_resigned_at: before.resigned_at });
      return;
    }

    // resigned_at:預計離職日 +08:00。沒填 fallback 用 approve 完成的 NOW
    // (理論 resign_date 是 required、approvals.html FORM_SCHEMA.resignation 強制)
    const resignedAtIso = resign_date
      ? `${resign_date}T00:00:00+08:00`
      : new Date().toISOString();

    const { error: updErr } = await supabaseAdmin.from('employees').update({
      status: 'resigned',
      resigned_at: resignedAtIso,
      resigned_reason: reason,
    }).eq('id', employee_id);

    if (updErr) {
      console.error('[applyResignation] employees update failed',
        { request_id: request.id, employee_id, err: updErr.message });
      return;
    }

    console.log('[applyResignation] success', {
      request_id: request.id,
      employee_id,
      resigned_at: resignedAtIso,
      approver_id: caller?.id,
    });

    // ── Cascade Enhancement #1:清 push_subscriptions(隱私 + 推播成本)──
    // 離職員工不該繼續收 sendPushToRoles(['employee']) / 部門公告等廣播。
    // best-effort:失敗只 log、不擋後續。
    try {
      await supabaseAdmin.from('push_subscriptions').delete().eq('employee_id', employee_id);
      console.log('[applyResignation] push_subscriptions cleaned', { employee_id });
    } catch (err) {
      console.error('[applyResignation] push_subscriptions cleanup failed',
        { request_id: request.id, employee_id, err: err.message });
    }

    // ── Cascade Enhancement #2:建立離職檢核表 + 46 項 ──
    // 對應 migrations/2026_05_26_resignation_checklist.sql。HR 透過
    // /resignation-checklist.html?employee_id=X 點開逐項勾選完成。
    // best-effort:失敗只 log、不擋 approval completed、HR 可手動補建。
    let checklistId = null;
    try {
      checklistId = 'RCL' + Date.now();
      const { error: clErr } = await supabaseAdmin.from('resignation_checklists').insert([{
        id: checklistId,
        employee_id: employee_id,
        approval_request_id: request.id,
        status: 'draft',
      }]);
      if (clErr) throw clErr;

      // 系統自動完成項目(16/17/23/43/44/46)cascade 觸發時即標 done
      const nowIso = new Date().toISOString();
      const tsBase = Date.now();
      const itemsToInsert = RESIGNATION_CHECKLIST_SEED.map(seed => {
        const autoDone = AUTO_DONE_SEQS.has(seed.item_seq);
        return {
          id: `ITM${tsBase}${String(seed.item_seq).padStart(3, '0')}`,
          checklist_id: checklistId,
          category: seed.category,
          category_label: seed.category_label,
          item_seq: seed.item_seq,
          item_name: seed.item_name,
          regulation_basis: seed.regulation_basis,
          status: autoDone ? 'done' : 'pending',
          completed_at: autoDone ? nowIso : null,
          completed_by: null, // 系統自動完成、approver_id 不適用、保留 null by-design
          note: autoDone ? '系統自動完成' : '',
        };
      });

      const { error: itemsErr } = await supabaseAdmin
        .from('resignation_checklist_items').insert(itemsToInsert);
      if (itemsErr) throw itemsErr;

      console.log('[applyResignation] checklist created', {
        checklist_id: checklistId, items: itemsToInsert.length, employee_id,
      });
    } catch (err) {
      console.error('[applyResignation] checklist creation failed',
        { request_id: request.id, employee_id, err: err.message });
      // checklist row 沒寫入(或 partial 寫入)→ reset checklistId 為 null,
      // 讓 Enhancement #3 URL fallback 到 /employees.html、HR 不會點到不存在的 ?id=
      checklistId = null;
    }

    // ── Cascade Enhancement #3:通知 HR 啟動檢核表 ──
    // best-effort:失敗只 log、HR 可主動查 employees 列表發現新 resigned。
    try {
      const employeeName = before?.name || employee_id;
      const url = checklistId
        ? `/resignation-checklist.html?employee_id=${encodeURIComponent(employee_id)}`
        : '/employees.html';
      await sendPushToRoles(['hr', 'admin'], {
        title: '✅ 員工離職核准、請啟動離職檢核表',
        body: `${employeeName} 已核准離職、請執行後續離職事務檢核`,
        url,
      });
      console.log('[applyResignation] HR push sent', { employee_id });
    } catch (err) {
      console.error('[applyResignation] HR push failed',
        { request_id: request.id, employee_id, err: err.message });
    }

    // ── B26 批次 2 Cascade Enhancement #4:annual_leave_records 結算 ──
    // 對所有 status='active' record 標 'paid_out' + settlement_amount = remaining × (base/30)
    // (§38 法定特休折現公式、不同於 daily_wage_snapshot 用 workdaysInMonth)
    // leave_balance_logs.changed_by NOT NULL → caller.id 不存在時 fallback employee_id
    // (對齊 lib/leave/annual-rollover.js:60 「SYSTEM 沒 employees row 用本人 id 佔位」)
    // best-effort:失敗只 console.error、不擋。
    try {
      const baseSalary = Number(before?.base_salary) || 0;
      const dailyWageSettlement = baseSalary > 0 ? baseSalary / 30 : 0;
      const changedBy = caller?.id || employee_id;

      const { data: activeRecords, error: selErr } = await supabaseAdmin
        .from('annual_leave_records')
        .select('id, granted_days, used_days')
        .eq('employee_id', employee_id)
        .eq('status', 'active');
      if (selErr) throw selErr;

      for (const rec of activeRecords || []) {
        const remainingDays = Math.max(
          0,
          (Number(rec.granted_days) || 0) - (Number(rec.used_days) || 0),
        );
        const settlementAmount = Math.round(remainingDays * dailyWageSettlement * 100) / 100;

        const { error: updErr } = await supabaseAdmin
          .from('annual_leave_records').update({
            status: 'paid_out',
            settled_at: new Date().toISOString(),
            settled_by: changedBy,
            settlement_amount: settlementAmount,
          }).eq('id', rec.id);
        if (updErr) {
          console.error('[applyResignation] annual_leave UPDATE failed',
            { request_id: request.id, employee_id, record_id: rec.id, err: updErr.message });
          continue;
        }

        // append-only audit log(failed log 不擋 cascade、純 audit 缺失)
        try {
          await supabaseAdmin.from('leave_balance_logs').insert([{
            employee_id,
            balance_type: 'annual',
            annual_record_id: rec.id,
            change_type: 'settle',
            hours_delta: -(remainingDays * 8),
            changed_by: changedBy,
            reason: 'B7 cascade: resignation settlement',
          }]);
        } catch (logErr) {
          console.error('[applyResignation] leave_balance_logs INSERT failed (annual)',
            { record_id: rec.id, err: logErr.message });
        }

        console.log('[applyResignation] annual_leave settled',
          { record_id: rec.id, remaining_days: remainingDays, settlement_amount: settlementAmount });
      }
    } catch (err) {
      console.error('[applyResignation] annual_leave cascade failed',
        { request_id: request.id, employee_id, err: err.message });
    }

    // ── B26 批次 2 Cascade Enhancement #5:comp_time_balance 結算 ──
    // 對所有 status='active' record 標 'expired_paid' + expiry_payout_amount
    // payout = remaining_hours × hourly_rate × multiplier
    // MVP 用 multiplier=1.34(平日加班預設、對齊階段 1 偵察決定)、未來如要對齊
    // overtime_requests.pay_multiplier 需擴邏輯
    // best-effort:失敗只 console.error、不擋。
    try {
      const hourlyRate = Number(before?.hourly_rate)
                       || (Number(before?.base_salary) / 240)
                       || 0;
      const resignedAtDate = resignedAtIso.slice(0, 10);  // 'YYYY-MM-DD'
      const multiplier = 1.34;
      const changedBy = caller?.id || employee_id;

      const { data: activeComp, error: selErr } = await supabaseAdmin
        .from('comp_time_balance')
        .select('id, earned_hours, used_hours, expires_at')
        .eq('employee_id', employee_id)
        .eq('status', 'active');
      if (selErr) throw selErr;

      for (const rec of activeComp || []) {
        const remainingHours = Math.max(
          0,
          (Number(rec.earned_hours) || 0) - (Number(rec.used_hours) || 0),
        );
        const payout = Math.round(remainingHours * hourlyRate * multiplier * 100) / 100;

        // expires_at clamp:取既有 expires_at 跟 resigned_at 較早者
        // (避免 future expires_at 被覆寫到更晚的 resigned_at)
        const newExpiresAt = rec.expires_at && rec.expires_at < resignedAtDate
          ? rec.expires_at
          : resignedAtDate;

        const { error: updErr } = await supabaseAdmin
          .from('comp_time_balance').update({
            status: 'expired_paid',
            expires_at: newExpiresAt,
            expiry_payout_amount: payout,
            expiry_processed_at: new Date().toISOString(),
          }).eq('id', rec.id);
        if (updErr) {
          console.error('[applyResignation] comp_time UPDATE failed',
            { request_id: request.id, employee_id, record_id: rec.id, err: updErr.message });
          continue;
        }

        try {
          await supabaseAdmin.from('leave_balance_logs').insert([{
            employee_id,
            balance_type: 'comp',
            comp_record_id: rec.id,
            change_type: 'settle',
            hours_delta: -remainingHours,
            changed_by: changedBy,
            reason: 'B7 cascade: resignation comp settlement',
          }]);
        } catch (logErr) {
          console.error('[applyResignation] leave_balance_logs INSERT failed (comp)',
            { record_id: rec.id, err: logErr.message });
        }

        console.log('[applyResignation] comp settled',
          { record_id: rec.id, remaining_hours: remainingHours, payout });
      }
    } catch (err) {
      console.error('[applyResignation] comp_time cascade failed',
        { request_id: request.id, employee_id, err: err.message });
    }

    // ── B26 批次 3 Cascade Enhancement #6:salary_records final-month draft ──
    // 在 resigned_at 月份建 / 更新一筆 salary_records draft、標 is_final_month=true。
    // HR 後續進 /salary.html 點「重 calculate」→ calculator pro-rata 整鏈路算對。
    // 不在這裡 trigger calculate:避免 cascade chain 越來越長、HR 主動點才跑。
    // best-effort:失敗只 console.error、不擋。
    try {
      // 用 resignedAtIso slice 拆 YYYY-MM-DD(避時區陷阱、不走 Date.getUTCDate)
      // resignedAtIso = `${resign_date}T00:00:00+08:00`、slice(0,10)直接得 Taipei 日期 string
      const resignDateStr = resignedAtIso.slice(0, 10);
      const [yearStr, monthStr, dayStr] = resignDateStr.split('-');
      const year = parseInt(yearStr, 10);
      const month = parseInt(monthStr, 10);   // 1-indexed
      const workedDays = parseInt(dayStr, 10); // 月內第幾日 = 在職曆日
      // Date.UTC 月份是 0-indexed,傳 1-indexed month 後 day=0 = 上月最後日 = 當月日數
      const totalDaysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

      // recordId pattern 對齊 api/salary/_repo.js:255 upsertSalaryRecord
      const recordId = `S_${employee_id}_${year}_${String(month).padStart(2, '0')}`;
      const { data: existing, error: selErr } = await supabaseAdmin
        .from('salary_records').select('id, status').eq('id', recordId).maybeSingle();
      if (selErr) throw selErr;

      if (existing) {
        if (['draft', 'calculating'].includes(existing.status)) {
          const { error: updErr } = await supabaseAdmin
            .from('salary_records').update({
              is_final_month: true,
              worked_days: workedDays,
              total_days_in_month: totalDaysInMonth,
              pro_rata_mode: 'calendar_day',
              updated_at: new Date().toISOString(),
            }).eq('id', recordId);
          if (updErr) throw updErr;
          console.log('[applyResignation] salary_records UPDATE is_final_month',
            { record_id: recordId, worked_days: workedDays, total_days: totalDaysInMonth });
        } else {
          // confirmed / paid / locked → 不動、HR 需手動 reopen(走既有 salary state machine)
          console.warn('[applyResignation] salary_records exists but locked, HR 需手動 reopen',
            { record_id: recordId, status: existing.status });
        }
      } else {
        const { error: insErr } = await supabaseAdmin.from('salary_records').insert([{
          id: recordId,
          employee_id,
          year,
          month,
          base_salary: Number(before?.base_salary) || 0,
          is_final_month: true,
          worked_days: workedDays,
          total_days_in_month: totalDaysInMonth,
          pro_rata_mode: 'calendar_day',
          status: 'draft',
        }]);
        if (insErr) throw insErr;
        console.log('[applyResignation] salary_records INSERT new draft',
          { record_id: recordId, worked_days: workedDays, total_days: totalDaysInMonth });
      }
    } catch (err) {
      console.error('[applyResignation] salary_records cascade failed',
        { request_id: request.id, employee_id, err: err.message });
    }
  } catch (err) {
    console.error('[applyResignation] unexpected error',
      { request_id: request.id, err: err.message });
  }
}

// B12:撈申請人 dept 內其他 active manager(排除自己),用於 create flow
// 偵測 sole-manager dept 並自動跳過 step 1 manager(因 sole manager 無法 self-approve)。
// 同 dept 還有其他 active manager → step 1 走既有 manager 互批 flow(B13 dept-scope 已支援)。
async function findOtherActiveManagersInDept(deptId, excludeId) {
  if (!deptId) return [];  // applicant 無 dept_id(資料異常)→ 視同 sole manager、保險升 CEO
  const { data, error } = await supabaseAdmin
    .from('employees')
    .select('id')
    .eq('dept_id', deptId)
    .eq('is_manager', true)
    .eq('status', 'active')
    .neq('id', excludeId);
  if (error) throw error;
  return data || [];
}

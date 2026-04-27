# RLS + Auth 改造設計文 v1

> 對應 commit base：`0b3899b`（含 vitest infra）
> 設計日期：2026-04-27
> 目標：把 HR-System v2 從 demo 安全模式（allow_all）改造成 production-grade 多層防禦

---

## 1. 背景與決策

### 1.1 現況不安全的本質

現有架構有三層「假安全」：

**Layer 1（資料庫層 RLS）— 假**
25 條 policy 全部 `USING (true) WITH CHECK (true)`，等於沒設防。任何人持 anon key 直連 Supabase REST API 可以做任何事。

**Layer 2（中間件層 lib/auth.js）— 假**
`requireAuth` / `requireRole` / `requireRoleOrPass` 三個函式在 token 失敗、role 不符時全部 return 一個 mock object 放行。註解明說「dev mode、寬鬆模式」。

**Layer 3（Handler 內 explicit check）— 真實但不完整**
各 endpoint 自己寫 `if (!['hr','admin'].includes(caller.role)) return 403`。但：
- 不是每支 endpoint 都寫
- 寫了的 endpoint 也只擋 application path、擋不了 client 直連 Supabase
- caller 從 lib/auth.js 來、本身就是 mock object（沒登入也回 mock）—這個 if 在沒登入時用 caller.role==null 比對 array、永遠 false、判定不通過——意外的「歪打正著」防禦

實際安全等級：依賴第 3 層的歪打正著。

### 1.2 「最嚴謹」的範圍定義

依拍板原則「未來問題最少、變動最少、結果為導向」：

範圍涵蓋：
1. ✅ 39 張 public schema 表全部上 RLS（不分階段）
2. ✅ lib/supabase.js 拆 anon + service_role 兩個 client
3. ✅ lib/auth.js dev-mode 改 strict-mode（含 email→auth_user_id 統一）
4. ✅ 45 支 API endpoint 全部改用 supabaseAdmin（service_role）
5. ✅ approvals_v2 4 張表納入 policy 設計（即使 source code 缺失）
6. ✅ ROLLBACK SQL 一併寫好

不涵蓋：
1. ❌ 不建 staging 環境（prod 直跑、transaction 包好）
2. ❌ 不重寫 apps-* / lib/approvals_v2/ source code（之後另一個 phase）
3. ❌ 不修 dept vs dept_id 資料正規化問題（記入「已知未解」）

### 1.3 架構決策：service_role + anon 拆分

**決策**：
client-side（瀏覽器）→ 用 anon key → 受 RLS 限制
server-side（API endpoint）→ 用 service_role key → 繞過 RLS

**為什麼這樣選**：

業界標準。Supabase 文件、PostgREST 文件、所有 RLS 教學都這樣設計。理由：

1. server 已有 application-layer 權限邏輯（handler 內 `if (!['hr','admin'])`）——RLS 對 server 是多餘層、會增加複雜度
2. RLS 設計成「擋 client 直連」這個邊界、policy 邏輯比較簡單
3. service_role key 只在 Vercel env var、不出現在 client bundle、安全
4. 未來如果要做 Realtime / Storage 直連 client、RLS 仍有效

**反方案（不採用）**：

「全部用 anon key、policy 寫複雜一點同時允許 server」——policy 內要檢查 caller 是不是 service_role role、寫法很扭曲、bug 容易、且 service_role 本來就會自動繞過 RLS、何必扭曲。

### 1.4 lib/auth.js dev → strict

dev-mode 三個 function 的修法：

| Function | 現況 | strict 後 |
|---|---|---|
| `getAuthUser` | token 失敗 return null | 不變（行為已正確） |
| `getEmployee` | 用 email 反查 | 改用 auth_user_id 反查（修統一性 bug） |
| `requireAuth` | 失敗 return mock | 失敗 return null + res.status(401) |
| `requireRole` | role 不符 return mock | role 不符 return null + res.status(403) |
| `requireRoleOrPass` | 永遠放行 | 整個 function 刪除（誤導命名、不該存在） |

`requireRoleOrPass` 被刪掉、現有用到它的 endpoint 改用 `requireRole`。

### 1.5 部署策略

5 個 Phase、每 phase 獨立 commit、可獨立 ROLLBACK。
Phase 1: lib/supabase.js + Vercel env var SUPABASE_SERVICE_ROLE_KEY
行為：完全無感（兩個 client 都加進去、暫時沒人用 supabaseAdmin）
Phase 2: lib/auth.js dev→strict
行為：未登入或 role 不符的 request 開始回 401/403
RLS 仍是 allow_all、所以 application 層的權限變嚴 = 唯一防線變嚴
Phase 3: API endpoint 改用 supabaseAdmin
行為：server-side 操作行為不變（service_role 也是 allow_all）
但為 Phase 4 鋪路
Phase 4: RLS SQL（drop allow_all、建嚴格 policy）
行為：client 直連 Supabase 開始受限
server 因為用 service_role 不受影響
Phase 5: Smoke test + 觀察 prod 24-48 小時

每個 Phase 之間留 buffer（觀察 1-2 小時）、避免問題堆疊。

---

## 2. 程式碼改造方案

### 2.1 lib/supabase.js 拆兩個 client

新版檔案內容：

```js
// lib/supabase.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
}

if (!supabaseServiceRoleKey) {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY (required for server-side operations)');
}

/**
 * Anon client.
 * 給驗證 user JWT 用（auth.getUser）、不該用來讀寫業務表。
 * 業務表讀寫請用 supabaseAdmin。
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * Service role client.
 * 繞過 RLS、有完整資料庫存取權。
 * 只在 server-side（api/ + lib/）使用、絕對不能進 client bundle。
 */
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
```

**Breaking change 風險**：

- 既有 21 個檔 import `supabase`、Phase 1 不改它們、行為不變
- Phase 3 才一個個改成 `supabaseAdmin`

**部署前要做**：

Vercel Project Settings → Environment Variables 加 `SUPABASE_SERVICE_ROLE_KEY`（從 Supabase Dashboard → Settings → API → service_role secret 複製）。

### 2.2 lib/auth.js 改造

新版檔案內容：

```js
// lib/auth.js — 共用授權工具（嚴格模式）
import { supabase, supabaseAdmin } from './supabase.js';

/**
 * 從 Authorization header 取得登入使用者，失敗回傳 null。
 * 用 anon client + token、走 Supabase Auth 驗證。
 */
export async function getAuthUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

/**
 * 取得登入使用者對應的員工資料。
 * 用 auth_user_id（uuid）反查、不用 email。
 * 回傳含 id, role, is_manager, dept_id, manager_id。
 * 用 supabaseAdmin 是因為 employees 表上 RLS 後、anon 看不到別人的 row。
 */
export async function getEmployee(user) {
  if (!user || !user.id) return null;
  const { data } = await supabaseAdmin
    .from('employees')
    .select('id, role, is_manager, dept_id, manager_id, status')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  if (!data) return null;
  if (data.status !== 'active') return null; // 離職員工不能用
  return data;
}

/**
 * 驗證 JWT、未登入回 401。
 * 回傳 caller object 或 null。null 時 res 已經寫了 401、handler 應該 return。
 */
export async function requireAuth(req, res) {
  const user = await getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized: missing or invalid token' });
    return null;
  }
  const emp = await getEmployee(user);
  if (!emp) {
    res.status(401).json({ error: 'Unauthorized: no active employee record' });
    return null;
  }
  return emp;
}

/**
 * 驗證 JWT + role 白名單、role 不符回 403。
 * 回傳 caller object 或 null。null 時 res 已經寫了 401/403、handler 應該 return。
 *
 * @param {string[]} allowedRoles - 允許通過的 role 白名單
 * @param {{ allowManager?: boolean }} [opts] - allowManager=true → is_manager=true 也通過
 */
export async function requireRole(req, res, allowedRoles, { allowManager = false } = {}) {
  const caller = await requireAuth(req, res);
  if (!caller) return null; // res 已被 requireAuth 寫好

  const passByRole = allowedRoles.includes(caller.role);
  const passByManager = allowManager && caller.is_manager === true;

  if (!passByRole && !passByManager) {
    res.status(403).json({ error: 'Forbidden: insufficient role' });
    return null;
  }
  return caller;
}

// requireRoleOrPass 已刪除、所有用到的地方改用 requireRole
```

**改造重點**：

1. **`requireRoleOrPass` 整個刪掉**——這個函式名「OrPass」就是 dev mode 的遺跡、誤導
2. **getEmployee 改用 auth_user_id**——修統一性 bug
3. **getEmployee 用 supabaseAdmin**——因為 RLS 上線後 anon 看不到 employees 別人的 row、auth 流程會壞
4. **加 status='active' 檢查**——離職員工不能登入

### 2.3 45 支 API endpoint 改造

每支 endpoint 要做兩件事：

**Action 1：將 `requireRoleOrPass` 全部換成 `requireRole`**

換的時候要對齊新 signature：原本「permissive、永遠不報錯」的設計、現在變成「失敗時 res 已寫好、handler 應 early return」——所有 caller 為 null 的分支都要加 `if (!caller) return;`。

**Action 2：所有業務表的讀寫從 `supabase` 改 `supabaseAdmin`**

20 個檔、80 處 `supabase.from()`——全部改 `supabaseAdmin.from()`。

例外：
- lib/auth.js 內的 `supabase.auth.getUser(token)` 保留 anon client（這個就是要驗證 user JWT、用 service_role 沒意義）

**改造順序建議**（Claude Code 實作時參考）：

按 endpoint 重要性排序、保證每個都個別測試：
Tier 1（高頻、員工每天用）

api/attendance/* (打卡)
api/leaves/* (請假)
api/schedules/* (排班查詢)
api/schedule-periods/* (月排班)
api/employees/[id].js (個人資料)

Tier 2（HR 後台用）

api/holidays/*
api/attendance-penalties/*
api/attendance-penalty-records/*
api/overtime-* (加班全套)
api/comp-time/*
api/annual-leaves/*
api/salary/*

Tier 3（cron + 雜項）

api/cron-* (6 個)
api/announcements.js
api/calendar/*
api/approvals.js
api/auth.js
api/salary-grade.js


每 tier 做完跑 vitest 全綠才進下一 tier。

### 2.4 Repo pattern 觀察（不在本次 scope）

部分 endpoint（attendance-penalties / leaves / salary / overtime-requests）已經有 `_repo.js`、把 db 操作集中。其他沒拆。

**本次設計不強推 repo pattern 推進**——避免 scope creep。但 Claude Code 改 supabase→supabaseAdmin 時、_repo.js 內的 supabase reference 也要一併改。

---

## 3. RLS Helper Function 設計

### 3.1 為什麼要 helper function

每張表的 RLS policy 都會問同樣的問題：

- 這個 auth.uid() 對應到哪個 employees row？
- 那個 employees row 的 role 是什麼？
- 那個 employees row 是不是 manager？
- 那個 employees row 在哪個部門？

如果每條 policy 都重寫 subquery，policy 變得超長、難維護、效能差（每條 query 都重複 join）。

正確做法：寫 helper function 包起來、policy 呼叫 function。

### 3.2 Helper function 設計

放在 db 層、用 PL/pgSQL：

```sql
-- ============================================
-- RLS Helper Functions
-- ============================================

-- 取得目前登入 auth user 對應的 employee record
-- 回傳 NULL 表示沒登入或 employees row 找不到
CREATE OR REPLACE FUNCTION public.auth_employee()
RETURNS TABLE (
  id text,
  role text,
  is_manager boolean,
  dept_id text,
  manager_id text,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, role, is_manager, dept_id, manager_id, status
  FROM employees
  WHERE auth_user_id = auth.uid()
    AND status = 'active'
  LIMIT 1
$$;

-- 取得目前登入員工的 id
CREATE OR REPLACE FUNCTION public.auth_employee_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM employees WHERE auth_user_id = auth.uid() AND status = 'active' LIMIT 1
$$;

-- 取得目前登入員工的 role
CREATE OR REPLACE FUNCTION public.auth_employee_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM employees WHERE auth_user_id = auth.uid() AND status = 'active' LIMIT 1
$$;

-- 判斷目前登入員工是否為主管
CREATE OR REPLACE FUNCTION public.auth_is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(is_manager, false) FROM employees WHERE auth_user_id = auth.uid() AND status = 'active' LIMIT 1
$$;

-- 取得目前登入員工的 dept_id
CREATE OR REPLACE FUNCTION public.auth_employee_dept_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT dept_id FROM employees WHERE auth_user_id = auth.uid() AND status = 'active' LIMIT 1
$$;

-- 判斷目前登入員工的 role 是否在指定 list 內
CREATE OR REPLACE FUNCTION public.auth_role_in(VARIADIC roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth_employee_role() = ANY(roles)
$$;

-- HR/Admin/CEO/Chairman 簡寫（最常用的權限組）
CREATE OR REPLACE FUNCTION public.auth_is_hr_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth_employee_role() IN ('hr', 'admin', 'ceo', 'chairman')
$$;

-- 判斷某個 employee_id 是不是「我的部門內」（我是 manager 且該員工在我的部門）
CREATE OR REPLACE FUNCTION public.auth_is_my_dept_member(target_employee_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM employees e
    WHERE e.id = target_employee_id
      AND e.dept_id IS NOT NULL
      AND e.dept_id = auth_employee_dept_id()
      AND auth_is_manager()
  )
$$;
```

### 3.3 設計決策說明

**SECURITY DEFINER**
所有 helper function 用 `SECURITY DEFINER`、以建立者（postgres）權限執行。這讓 function 可以查 employees 表（即使 caller 沒權限直接 SELECT）。

**SET search_path = public**
SECURITY DEFINER 函式必須鎖 search_path、防止 schema injection 攻擊。

**STABLE 而非 VOLATILE**
function 在同一個 query 內結果不變、Postgres 可以快取結果、效能更好。

**LIMIT 1 + maybeSingle 邏輯**
employees.auth_user_id 沒有 UNIQUE constraint（schema 確認過）——理論上一個 auth user 應該只對應一個 employee、但 db 沒強制。LIMIT 1 是防護。

**status='active' 內建**
所有 helper 都過濾離職員工。離職員工的 auth account 還在、employees row 還在、但業務上不該有任何權限。

---

## 4. 權限矩陣

### 4.1 角色定義

從 employees.role 欄位可見值：

| Role | 中文 | 數量（prod） | 權限級別 |
|---|---|---|---|
| `chairman` | 董事長 | 2 | 最高、看全公司 |
| `ceo` | 執行長 | 1 | 看全公司、含 HR 後台 |
| `admin` | 系統管理員 | 2（EMP_ADMIN + EMP_99999999、待清理） | 系統管理級 |
| `hr` | 人資 | 0 | HR 後台級 |
| `manager` | 主管 | 0（用 is_manager=true 標記、不用 role='manager'） | - |
| `employee` | 一般員工 | 多數 | 自己的 |

prod 上沒有 role='manager' 的員工——manager 是用 `is_manager=true` 來標、role 仍是 `employee`。

`is_manager` 跟 role 是兩個獨立 dimension：
- `role='employee'` + `is_manager=true` → 部門主管（看部門內）
- `role='hr'` + `is_manager=false` → HR 後台人員（看全公司、但不是部門主管）

`chairman` 跟 `ceo` 沒在現有 code 區分過——本次設計把它們等同處理（都是「全公司唯讀 + 部分操作權」）。

### 4.2 權限 Scope 定義

每張表的每種操作、scope 是下面四種之一：

| Scope | 條件 | 用什麼 helper |
|---|---|---|
| `OWN` | row 屬於自己 | `employee_id = auth_employee_id()` |
| `DEPT` | row 屬於自己部門（且自己是 manager） | `auth_is_my_dept_member(employee_id)` |
| `ALL` | 全公司可看可改 | `auth_is_hr_admin()` |
| `NONE` | 無權限 | (deny by default) |

組合規則（給某個 role 對某個操作的權限）：
employee:    OWN
manager:     OWN + DEPT
hr/admin:    ALL（含 OWN + DEPT）
ceo/chairman: ALL（部分操作只讀）

### 4.3 39 張表的權限矩陣

下面是矩陣概覽。每張表的細節 policy SQL 在 §5。

#### 員工核心

| 表 | SELECT | INSERT | UPDATE | DELETE | 備註 |
|---|---|---|---|---|---|
| employees | OWN+DEPT / hr+ALL | hr+admin | OWN limited / hr+ALL | hr+admin | 員工只能改自己 phone/address/avatar |
| departments | ALL（all roles read） | hr+admin | hr+admin | hr+admin | 全公司可見部門結構 |

#### 排班系統

| 表 | SELECT | INSERT | UPDATE | DELETE | 備註 |
|---|---|---|---|---|---|
| schedule_periods | OWN+DEPT / hr+ALL | OWN / hr+ALL | OWN if status='draft' / hr+ALL | hr+admin | 員工建自己的、draft 才能改 |
| schedules | OWN+DEPT / hr+ALL | OWN if period.status='draft' / hr+ALL | OWN if period.status='draft' / hr+ALL | OWN if period.status='draft' / hr+ALL | 排班 row 受 period 狀態約束 |
| schedule_change_logs | OWN+DEPT / hr+ALL | server only（API 寫入）| - | - | append-only audit log |
| shift_types | ALL read | hr+admin | hr+admin | hr+admin | 班別主檔、全員可見 |

#### 出勤系統

| 表 | SELECT | INSERT | UPDATE | DELETE | 備註 |
|---|---|---|---|---|---|
| attendance | OWN+DEPT / hr+ALL | OWN（打卡）/ hr+ALL | OWN limited（補打卡）/ hr+ALL | hr+admin | 一般員工打卡、HR 修正 |
| holidays | ALL read | hr+admin | hr+admin | hr+admin | 國定假日、全員可見 |

#### 請假系統

| 表 | SELECT | INSERT | UPDATE | DELETE | 備註 |
|---|---|---|---|---|---|
| leave_requests | OWN+DEPT / hr+ALL | OWN | OWN if status='pending' / DEPT for review / hr+ALL | hr+admin | 多階段審批 |
| leave_types | ALL read | hr+admin | hr+admin | hr+admin | 假別主檔 |
| leave_balance_logs | OWN / hr+ALL | server only | - | - | append-only audit log |
| annual_leave_records | OWN / hr+ALL | hr+admin / cron | hr+admin / cron | hr+admin | 特休餘額、cron 自動產生 |

#### 加班補休

| 表 | SELECT | INSERT | UPDATE | DELETE | 備註 |
|---|---|---|---|---|---|
| overtime_requests | OWN+DEPT / hr+ALL | OWN | OWN if status='pending' / DEPT for manager review / ceo for ceo review / hr+ALL | hr+admin | 多階段審批 |
| overtime_request_logs | OWN / hr+ALL | server only | - | - | audit log |
| overtime_limits | ALL read（員工要知道自己上限） | hr+admin | hr+admin | hr+admin | 加班上限規則 |
| system_overtime_settings | ALL read（員工查費率） | hr+admin | hr+admin | hr+admin | 全系統加班設定、單例 |
| comp_time_balance | OWN / hr+ALL | server only / cron | server only / hr+ALL | hr+admin | 補休餘額 |

#### 出勤獎懲

| 表 | SELECT | INSERT | UPDATE | DELETE | 備註 |
|---|---|---|---|---|---|
| attendance_penalties | ALL read（員工要知道規則） | hr+admin | hr+admin | hr+admin | 獎懲規則主檔 |
| attendance_penalty_records | OWN / hr+ALL | server only / cron | hr+admin（waive 操作）| hr+admin | 個別員工懲處紀錄 |

#### 薪資（最敏感）

| 表 | SELECT | INSERT | UPDATE | DELETE | 備註 |
|---|---|---|---|---|---|
| salary_records | OWN / hr+admin+ceo | hr+admin | hr+admin | hr+admin | 員工只看自己、manager 也不能看部下薪資 |
| salary_grade | hr+admin | hr+admin | hr+admin | hr+admin | 薪資級距、員工不可見 |

#### 保險

| 表 | SELECT | INSERT | UPDATE | DELETE | 備註 |
|---|---|---|---|---|---|
| insurance_settings | ALL read | hr+admin | hr+admin | hr+admin | 公司保險設定 |
| insurance_change_requests | OWN / hr+ALL | OWN | hr+ALL | hr+admin | 員工申請保險異動 |
| labor_insurance_brackets | ALL read | hr+admin | hr+admin | hr+admin | 級距主檔 |
| health_insurance_brackets | ALL read | hr+admin | hr+admin | hr+admin | 級距主檔 |

#### 通知公告

| 表 | SELECT | INSERT | UPDATE | DELETE | 備註 |
|---|---|---|---|---|---|
| announcements | ALL read | hr+admin+ceo | hr+admin+ceo | hr+admin | 全員可見 |
| announcement_reads | OWN / hr+ALL | OWN | OWN | hr+admin | 已讀紀錄、自己的 |
| notifications | OWN / hr+ALL | server only | OWN（標已讀）/ server | hr+admin | 個人通知 |
| push_subscriptions | OWN / hr+ALL | OWN | OWN | OWN | Push token |

#### 既有審批（舊系統）

| 表 | SELECT | INSERT | UPDATE | DELETE | 備註 |
|---|---|---|---|---|---|
| approval_requests | OWN+DEPT / hr+ALL | OWN | OWN limited / DEPT for review / hr+ALL | hr+admin | 舊版審批、保留現行行為 |
| approval_steps | 跟 request 同 scope | server only | server only | hr+admin | audit-like |
| approval_flow_configs | ALL read | hr+admin | hr+admin | hr+admin | 流程設定 |
| shift_swap_requests | OWN+DEPT / hr+ALL | OWN | OWN if pending / DEPT review / hr+ALL | hr+admin | 換班申請 |

#### approvals_v2（source code 缺失、保守設計）

| 表 | SELECT | INSERT | UPDATE | DELETE | 備註 |
|---|---|---|---|---|---|
| approvals_v2_applications | OWN+DEPT / hr+ALL | OWN | OWN if draft / DEPT review / hr+ALL | hr+admin | 申請主表 |
| approvals_v2_approval_actions | 跟 application 同 scope | server only | - | hr+admin | audit log |
| approvals_v2_notifications | OWN / hr+ALL | server only | OWN（標已讀） | hr+admin | 個人通知 |
| approvals_v2_role_assignments | ALL read（attendance ceo-review.js 需要查） | hr+admin | hr+admin | hr+admin | 角色指派 |

#### 系統設定

| 表 | SELECT | INSERT | UPDATE | DELETE | 備註 |
|---|---|---|---|---|---|
| system_settings | ALL read | hr+admin | hr+admin | hr+admin | 系統設定（kv-style）|

---

## 5. 每張表的 Policy SQL

依表分節、每張表給完整 4 條 policy（SELECT/INSERT/UPDATE/DELETE）。

慣例：

- 全部 policy 命名 `<table>_<op>_<scope>`
- 先 `ENABLE ROW LEVEL SECURITY`（已開的會 no-op）
- 先 `DROP POLICY IF EXISTS allow_all`（清掉舊 demo policy）
- `FOR SELECT/INSERT/UPDATE/DELETE` 分開、不用 `FOR ALL`（粒度清晰）

### 5.1 員工核心表

```sql
-- ============================================
-- employees
-- ============================================
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON employees;

CREATE POLICY employees_select_own_or_dept_or_hr ON employees FOR SELECT
USING (
  id = auth_employee_id()
  OR auth_is_my_dept_member(id)
  OR auth_is_hr_admin()
);

CREATE POLICY employees_insert_hr_admin ON employees FOR INSERT
WITH CHECK (auth_role_in('hr', 'admin'));

CREATE POLICY employees_update_own_or_hr ON employees FOR UPDATE
USING (id = auth_employee_id() OR auth_role_in('hr', 'admin'))
WITH CHECK (id = auth_employee_id() OR auth_role_in('hr', 'admin'));

CREATE POLICY employees_delete_hr_admin ON employees FOR DELETE
USING (auth_role_in('hr', 'admin'));

-- ============================================
-- departments
-- ============================================
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON departments;

CREATE POLICY departments_select_all ON departments FOR SELECT USING (true);
CREATE POLICY departments_insert_hr_admin ON departments FOR INSERT
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY departments_update_hr_admin ON departments FOR UPDATE
USING (auth_role_in('hr', 'admin'))
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY departments_delete_hr_admin ON departments FOR DELETE
USING (auth_role_in('hr', 'admin'));
```

### 5.2 排班系統

```sql
-- ============================================
-- schedule_periods
-- ============================================
ALTER TABLE schedule_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON schedule_periods;

CREATE POLICY schedule_periods_select_own_or_dept_or_hr ON schedule_periods FOR SELECT
USING (
  employee_id = auth_employee_id()
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
);

CREATE POLICY schedule_periods_insert_own_or_hr ON schedule_periods FOR INSERT
WITH CHECK (
  employee_id = auth_employee_id()
  OR auth_is_hr_admin()
);

CREATE POLICY schedule_periods_update_own_draft_or_hr ON schedule_periods FOR UPDATE
USING (
  (employee_id = auth_employee_id() AND status IN ('draft', 'submitted'))
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
)
WITH CHECK (
  (employee_id = auth_employee_id() AND status IN ('draft', 'submitted'))
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
);

CREATE POLICY schedule_periods_delete_hr_admin ON schedule_periods FOR DELETE
USING (auth_role_in('hr', 'admin'));

-- ============================================
-- schedules
-- ============================================
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON schedules;

CREATE POLICY schedules_select_own_or_dept_or_hr ON schedules FOR SELECT
USING (
  employee_id = auth_employee_id()
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
);

CREATE POLICY schedules_insert_own_draft_or_hr ON schedules FOR INSERT
WITH CHECK (
  (
    employee_id = auth_employee_id()
    AND EXISTS (
      SELECT 1 FROM schedule_periods sp
      WHERE sp.employee_id = schedules.employee_id
        AND sp.period_year = EXTRACT(YEAR FROM schedules.work_date)::int
        AND sp.period_month = EXTRACT(MONTH FROM schedules.work_date)::int
        AND sp.status = 'draft'
    )
  )
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
);

CREATE POLICY schedules_update_own_draft_or_hr ON schedules FOR UPDATE
USING (
  (
    employee_id = auth_employee_id()
    AND EXISTS (
      SELECT 1 FROM schedule_periods sp
      WHERE sp.employee_id = schedules.employee_id
        AND sp.period_year = EXTRACT(YEAR FROM schedules.work_date)::int
        AND sp.period_month = EXTRACT(MONTH FROM schedules.work_date)::int
        AND sp.status IN ('draft', 'submitted')
    )
  )
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
)
WITH CHECK (
  (
    employee_id = auth_employee_id()
    AND EXISTS (
      SELECT 1 FROM schedule_periods sp
      WHERE sp.employee_id = schedules.employee_id
        AND sp.period_year = EXTRACT(YEAR FROM schedules.work_date)::int
        AND sp.period_month = EXTRACT(MONTH FROM schedules.work_date)::int
        AND sp.status IN ('draft', 'submitted')
    )
  )
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
);

CREATE POLICY schedules_delete_own_draft_or_hr ON schedules FOR DELETE
USING (
  (
    employee_id = auth_employee_id()
    AND EXISTS (
      SELECT 1 FROM schedule_periods sp
      WHERE sp.employee_id = schedules.employee_id
        AND sp.period_year = EXTRACT(YEAR FROM schedules.work_date)::int
        AND sp.period_month = EXTRACT(MONTH FROM schedules.work_date)::int
        AND sp.status = 'draft'
    )
  )
  OR auth_is_hr_admin()
);

-- ============================================
-- schedule_change_logs (audit, append-only)
-- ============================================
ALTER TABLE schedule_change_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON schedule_change_logs;

CREATE POLICY schedule_change_logs_select_own_or_dept_or_hr ON schedule_change_logs FOR SELECT
USING (
  employee_id = auth_employee_id()
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
);

CREATE POLICY schedule_change_logs_insert_hr ON schedule_change_logs FOR INSERT
WITH CHECK (auth_is_hr_admin());

-- 不設 UPDATE/DELETE policy = 任何 anon 操作都被擋

-- ============================================
-- shift_types (master data, all-readable)
-- ============================================
ALTER TABLE shift_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON shift_types;

CREATE POLICY shift_types_select_all ON shift_types FOR SELECT USING (true);
CREATE POLICY shift_types_insert_hr ON shift_types FOR INSERT
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY shift_types_update_hr ON shift_types FOR UPDATE
USING (auth_role_in('hr', 'admin'))
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY shift_types_delete_hr ON shift_types FOR DELETE
USING (auth_role_in('hr', 'admin'));
```

### 5.3 出勤系統

```sql
-- ============================================
-- attendance
-- ============================================
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON attendance;

CREATE POLICY attendance_select_own_or_dept_or_hr ON attendance FOR SELECT
USING (
  employee_id = auth_employee_id()
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
);

CREATE POLICY attendance_insert_own_or_hr ON attendance FOR INSERT
WITH CHECK (
  employee_id = auth_employee_id()
  OR auth_is_hr_admin()
);

CREATE POLICY attendance_update_own_or_hr ON attendance FOR UPDATE
USING (
  employee_id = auth_employee_id()
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
)
WITH CHECK (
  employee_id = auth_employee_id()
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
);

CREATE POLICY attendance_delete_hr ON attendance FOR DELETE
USING (auth_role_in('hr', 'admin'));

-- ============================================
-- holidays (master data, all-readable)
-- ============================================
ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON holidays;

CREATE POLICY holidays_select_all ON holidays FOR SELECT USING (true);
CREATE POLICY holidays_insert_hr ON holidays FOR INSERT
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY holidays_update_hr ON holidays FOR UPDATE
USING (auth_role_in('hr', 'admin'))
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY holidays_delete_hr ON holidays FOR DELETE
USING (auth_role_in('hr', 'admin'));
```

### 5.4 請假系統

```sql
-- ============================================
-- leave_requests
-- ============================================
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON leave_requests;

CREATE POLICY leave_requests_select_own_or_dept_or_hr ON leave_requests FOR SELECT
USING (
  employee_id = auth_employee_id()
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
);

CREATE POLICY leave_requests_insert_own ON leave_requests FOR INSERT
WITH CHECK (
  employee_id = auth_employee_id()
  OR auth_is_hr_admin()
);

CREATE POLICY leave_requests_update_pending_or_review_or_hr ON leave_requests FOR UPDATE
USING (
  (employee_id = auth_employee_id() AND status = 'pending')
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
)
WITH CHECK (
  (employee_id = auth_employee_id() AND status = 'pending')
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
);

CREATE POLICY leave_requests_delete_hr ON leave_requests FOR DELETE
USING (auth_role_in('hr', 'admin'));

-- ============================================
-- leave_types
-- ============================================
ALTER TABLE leave_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON leave_types;

CREATE POLICY leave_types_select_all ON leave_types FOR SELECT USING (true);
CREATE POLICY leave_types_insert_hr ON leave_types FOR INSERT
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY leave_types_update_hr ON leave_types FOR UPDATE
USING (auth_role_in('hr', 'admin'))
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY leave_types_delete_hr ON leave_types FOR DELETE
USING (auth_role_in('hr', 'admin'));

-- ============================================
-- leave_balance_logs (audit, append-only)
-- ============================================
ALTER TABLE leave_balance_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON leave_balance_logs;

CREATE POLICY leave_balance_logs_select_own_or_hr ON leave_balance_logs FOR SELECT
USING (
  employee_id = auth_employee_id()
  OR auth_is_hr_admin()
);

CREATE POLICY leave_balance_logs_insert_hr ON leave_balance_logs FOR INSERT
WITH CHECK (auth_is_hr_admin());

-- 不設 UPDATE/DELETE policy = anon 都擋

-- ============================================
-- annual_leave_records
-- ============================================
ALTER TABLE annual_leave_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON annual_leave_records;

CREATE POLICY annual_leave_records_select_own_or_hr ON annual_leave_records FOR SELECT
USING (
  employee_id = auth_employee_id()
  OR auth_is_hr_admin()
);

CREATE POLICY annual_leave_records_insert_hr ON annual_leave_records FOR INSERT
WITH CHECK (auth_is_hr_admin());

CREATE POLICY annual_leave_records_update_hr ON annual_leave_records FOR UPDATE
USING (auth_is_hr_admin())
WITH CHECK (auth_is_hr_admin());

CREATE POLICY annual_leave_records_delete_hr ON annual_leave_records FOR DELETE
USING (auth_role_in('hr', 'admin'));
```

### 5.5 加班補休系統

```sql
-- ============================================
-- overtime_requests
-- ============================================
ALTER TABLE overtime_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON overtime_requests;

CREATE POLICY overtime_requests_select_own_or_dept_or_hr ON overtime_requests FOR SELECT
USING (
  employee_id = auth_employee_id()
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
);

CREATE POLICY overtime_requests_insert_own ON overtime_requests FOR INSERT
WITH CHECK (
  employee_id = auth_employee_id()
  OR auth_is_hr_admin()
);

CREATE POLICY overtime_requests_update_pending_or_review_or_hr ON overtime_requests FOR UPDATE
USING (
  (employee_id = auth_employee_id() AND status = 'pending')
  OR auth_is_my_dept_member(employee_id)
  OR auth_role_in('ceo', 'chairman')
  OR auth_is_hr_admin()
)
WITH CHECK (
  (employee_id = auth_employee_id() AND status = 'pending')
  OR auth_is_my_dept_member(employee_id)
  OR auth_role_in('ceo', 'chairman')
  OR auth_is_hr_admin()
);

CREATE POLICY overtime_requests_delete_hr ON overtime_requests FOR DELETE
USING (auth_role_in('hr', 'admin'));

-- ============================================
-- overtime_request_logs (audit)
-- ============================================
ALTER TABLE overtime_request_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON overtime_request_logs;

CREATE POLICY overtime_request_logs_select_via_request ON overtime_request_logs FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM overtime_requests r
    WHERE r.id = overtime_request_logs.request_id
      AND (
        r.employee_id = auth_employee_id()
        OR auth_is_my_dept_member(r.employee_id)
        OR auth_is_hr_admin()
      )
  )
);

CREATE POLICY overtime_request_logs_insert_hr ON overtime_request_logs FOR INSERT
WITH CHECK (auth_is_hr_admin());

-- 不設 UPDATE/DELETE = 擋光

-- ============================================
-- overtime_limits (master data, all-readable)
-- ============================================
ALTER TABLE overtime_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON overtime_limits;

CREATE POLICY overtime_limits_select_all ON overtime_limits FOR SELECT USING (true);
CREATE POLICY overtime_limits_insert_hr ON overtime_limits FOR INSERT
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY overtime_limits_update_hr ON overtime_limits FOR UPDATE
USING (auth_role_in('hr', 'admin'))
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY overtime_limits_delete_hr ON overtime_limits FOR DELETE
USING (auth_role_in('hr', 'admin'));

-- ============================================
-- system_overtime_settings (singleton)
-- ============================================
ALTER TABLE system_overtime_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON system_overtime_settings;

CREATE POLICY system_overtime_settings_select_all ON system_overtime_settings FOR SELECT USING (true);
CREATE POLICY system_overtime_settings_update_hr ON system_overtime_settings FOR UPDATE
USING (auth_role_in('hr', 'admin'))
WITH CHECK (auth_role_in('hr', 'admin'));
-- 不設 INSERT/DELETE = 擋光（這是單例表）

-- ============================================
-- comp_time_balance
-- ============================================
ALTER TABLE comp_time_balance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON comp_time_balance;

CREATE POLICY comp_time_balance_select_own_or_hr ON comp_time_balance FOR SELECT
USING (
  employee_id = auth_employee_id()
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
);

CREATE POLICY comp_time_balance_insert_hr ON comp_time_balance FOR INSERT
WITH CHECK (auth_is_hr_admin());

CREATE POLICY comp_time_balance_update_hr ON comp_time_balance FOR UPDATE
USING (auth_is_hr_admin())
WITH CHECK (auth_is_hr_admin());

CREATE POLICY comp_time_balance_delete_hr ON comp_time_balance FOR DELETE
USING (auth_role_in('hr', 'admin'));
```

### 5.6 出勤獎懲

```sql
-- ============================================
-- attendance_penalties (master data)
-- ============================================
ALTER TABLE attendance_penalties ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON attendance_penalties;

CREATE POLICY attendance_penalties_select_all ON attendance_penalties FOR SELECT USING (true);
CREATE POLICY attendance_penalties_insert_hr ON attendance_penalties FOR INSERT
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY attendance_penalties_update_hr ON attendance_penalties FOR UPDATE
USING (auth_role_in('hr', 'admin'))
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY attendance_penalties_delete_hr ON attendance_penalties FOR DELETE
USING (auth_role_in('hr', 'admin'));

-- ============================================
-- attendance_penalty_records
-- ============================================
ALTER TABLE attendance_penalty_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON attendance_penalty_records;

CREATE POLICY attendance_penalty_records_select_own_or_dept_or_hr ON attendance_penalty_records FOR SELECT
USING (
  employee_id = auth_employee_id()
  OR auth_is_my_dept_member(employee_id)
  OR auth_is_hr_admin()
);

CREATE POLICY attendance_penalty_records_insert_hr ON attendance_penalty_records FOR INSERT
WITH CHECK (auth_is_hr_admin());

CREATE POLICY attendance_penalty_records_update_hr ON attendance_penalty_records FOR UPDATE
USING (auth_is_hr_admin())
WITH CHECK (auth_is_hr_admin());

CREATE POLICY attendance_penalty_records_delete_hr ON attendance_penalty_records FOR DELETE
USING (auth_role_in('hr', 'admin'));
```

### 5.7 薪資系統（最敏感）

```sql
-- ============================================
-- salary_records
-- ============================================
ALTER TABLE salary_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON salary_records;

CREATE POLICY salary_records_select_own_or_hr ON salary_records FOR SELECT
USING (
  employee_id = auth_employee_id()
  OR auth_is_hr_admin()
);

CREATE POLICY salary_records_insert_hr ON salary_records FOR INSERT
WITH CHECK (auth_is_hr_admin());

CREATE POLICY salary_records_update_hr ON salary_records FOR UPDATE
USING (auth_is_hr_admin())
WITH CHECK (auth_is_hr_admin());

CREATE POLICY salary_records_delete_hr ON salary_records FOR DELETE
USING (auth_role_in('hr', 'admin'));

-- ============================================
-- salary_grade
-- ============================================
ALTER TABLE salary_grade ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON salary_grade;

CREATE POLICY salary_grade_select_hr ON salary_grade FOR SELECT
USING (auth_is_hr_admin());
CREATE POLICY salary_grade_insert_hr ON salary_grade FOR INSERT
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY salary_grade_update_hr ON salary_grade FOR UPDATE
USING (auth_role_in('hr', 'admin'))
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY salary_grade_delete_hr ON salary_grade FOR DELETE
USING (auth_role_in('hr', 'admin'));
```

### 5.8 保險

```sql
-- ============================================
-- insurance_settings (master data)
-- ============================================
ALTER TABLE insurance_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON insurance_settings;

CREATE POLICY insurance_settings_select_all ON insurance_settings FOR SELECT USING (true);
CREATE POLICY insurance_settings_insert_hr ON insurance_settings FOR INSERT
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY insurance_settings_update_hr ON insurance_settings FOR UPDATE
USING (auth_role_in('hr', 'admin'))
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY insurance_settings_delete_hr ON insurance_settings FOR DELETE
USING (auth_role_in('hr', 'admin'));

-- ============================================
-- insurance_change_requests
-- ============================================
ALTER TABLE insurance_change_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON insurance_change_requests;

CREATE POLICY insurance_change_requests_select_own_or_hr ON insurance_change_requests FOR SELECT
USING (
  employee_id = auth_employee_id()
  OR auth_is_hr_admin()
);

CREATE POLICY insurance_change_requests_insert_own ON insurance_change_requests FOR INSERT
WITH CHECK (
  employee_id = auth_employee_id()
  OR auth_is_hr_admin()
);

CREATE POLICY insurance_change_requests_update_hr ON insurance_change_requests FOR UPDATE
USING (auth_is_hr_admin())
WITH CHECK (auth_is_hr_admin());

CREATE POLICY insurance_change_requests_delete_hr ON insurance_change_requests FOR DELETE
USING (auth_role_in('hr', 'admin'));

-- ============================================
-- labor_insurance_brackets / health_insurance_brackets (master)
-- ============================================
ALTER TABLE labor_insurance_brackets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON labor_insurance_brackets;
CREATE POLICY labor_insurance_brackets_select_all ON labor_insurance_brackets FOR SELECT USING (true);
CREATE POLICY labor_insurance_brackets_insert_hr ON labor_insurance_brackets FOR INSERT
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY labor_insurance_brackets_update_hr ON labor_insurance_brackets FOR UPDATE
USING (auth_role_in('hr', 'admin')) WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY labor_insurance_brackets_delete_hr ON labor_insurance_brackets FOR DELETE
USING (auth_role_in('hr', 'admin'));

ALTER TABLE health_insurance_brackets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON health_insurance_brackets;
CREATE POLICY health_insurance_brackets_select_all ON health_insurance_brackets FOR SELECT USING (true);
CREATE POLICY health_insurance_brackets_insert_hr ON health_insurance_brackets FOR INSERT
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY health_insurance_brackets_update_hr ON health_insurance_brackets FOR UPDATE
USING (auth_role_in('hr', 'admin')) WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY health_insurance_brackets_delete_hr ON health_insurance_brackets FOR DELETE
USING (auth_role_in('hr', 'admin'));
```

### 5.9 通知公告

注意：announcement_reads / notifications / push_subscriptions 的擁有者欄位名是推測值（推測 employee_id / recipient_id）、Phase 4 上 prod 前 Claude Code 必須先確認實際 schema、必要時調整。

```sql
-- ============================================
-- announcements
-- ============================================
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON announcements;

CREATE POLICY announcements_select_all ON announcements FOR SELECT USING (true);
CREATE POLICY announcements_insert_hr_ceo ON announcements FOR INSERT
WITH CHECK (auth_role_in('hr', 'admin', 'ceo', 'chairman'));
CREATE POLICY announcements_update_hr_ceo ON announcements FOR UPDATE
USING (auth_role_in('hr', 'admin', 'ceo', 'chairman'))
WITH CHECK (auth_role_in('hr', 'admin', 'ceo', 'chairman'));
CREATE POLICY announcements_delete_hr ON announcements FOR DELETE
USING (auth_role_in('hr', 'admin'));

-- ============================================
-- announcement_reads (假設欄位 employee_id、待 Claude Code 確認)
-- ============================================
ALTER TABLE announcement_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON announcement_reads;

CREATE POLICY announcement_reads_select_own_or_hr ON announcement_reads FOR SELECT
USING (
  employee_id = auth_employee_id()
  OR auth_is_hr_admin()
);
CREATE POLICY announcement_reads_insert_own ON announcement_reads FOR INSERT
WITH CHECK (employee_id = auth_employee_id() OR auth_is_hr_admin());
CREATE POLICY announcement_reads_update_own ON announcement_reads FOR UPDATE
USING (employee_id = auth_employee_id() OR auth_is_hr_admin())
WITH CHECK (employee_id = auth_employee_id() OR auth_is_hr_admin());
CREATE POLICY announcement_reads_delete_hr ON announcement_reads FOR DELETE
USING (auth_role_in('hr', 'admin'));

-- ============================================
-- notifications (假設欄位 recipient_id、待 Claude Code 確認)
-- ============================================
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON notifications;

CREATE POLICY notifications_select_own_or_hr ON notifications FOR SELECT
USING (
  recipient_id = auth_employee_id()
  OR auth_is_hr_admin()
);
CREATE POLICY notifications_insert_hr ON notifications FOR INSERT
WITH CHECK (auth_is_hr_admin());
CREATE POLICY notifications_update_own_or_hr ON notifications FOR UPDATE
USING (recipient_id = auth_employee_id() OR auth_is_hr_admin())
WITH CHECK (recipient_id = auth_employee_id() OR auth_is_hr_admin());
CREATE POLICY notifications_delete_hr ON notifications FOR DELETE
USING (auth_role_in('hr', 'admin'));

-- ============================================
-- push_subscriptions (假設欄位 employee_id、待 Claude Code 確認)
-- ============================================
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON push_subscriptions;

CREATE POLICY push_subscriptions_select_own_or_hr ON push_subscriptions FOR SELECT
USING (employee_id = auth_employee_id() OR auth_is_hr_admin());
CREATE POLICY push_subscriptions_insert_own ON push_subscriptions FOR INSERT
WITH CHECK (employee_id = auth_employee_id() OR auth_is_hr_admin());
CREATE POLICY push_subscriptions_update_own ON push_subscriptions FOR UPDATE
USING (employee_id = auth_employee_id() OR auth_is_hr_admin())
WITH CHECK (employee_id = auth_employee_id() OR auth_is_hr_admin());
CREATE POLICY push_subscriptions_delete_own ON push_subscriptions FOR DELETE
USING (employee_id = auth_employee_id() OR auth_is_hr_admin());
```

### 5.10 既有審批（舊系統）

注意：approval_requests / shift_swap_requests 欄位待 Claude Code 確認、調整 policy。

```sql
-- ============================================
-- approval_requests / approval_steps / approval_flow_configs / shift_swap_requests
-- ============================================

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON approval_requests;

CREATE POLICY approval_requests_select_own_or_dept_or_hr ON approval_requests FOR SELECT
USING (
  applicant_id = auth_employee_id()
  OR auth_is_my_dept_member(applicant_id)
  OR auth_is_hr_admin()
);
CREATE POLICY approval_requests_insert_own ON approval_requests FOR INSERT
WITH CHECK (applicant_id = auth_employee_id() OR auth_is_hr_admin());
CREATE POLICY approval_requests_update_own_or_dept_or_hr ON approval_requests FOR UPDATE
USING (
  applicant_id = auth_employee_id()
  OR auth_is_my_dept_member(applicant_id)
  OR auth_is_hr_admin()
)
WITH CHECK (
  applicant_id = auth_employee_id()
  OR auth_is_my_dept_member(applicant_id)
  OR auth_is_hr_admin()
);
CREATE POLICY approval_requests_delete_hr ON approval_requests FOR DELETE
USING (auth_role_in('hr', 'admin'));

ALTER TABLE approval_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON approval_steps;
CREATE POLICY approval_steps_select_via_request ON approval_steps FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM approval_requests r
    WHERE r.id = approval_steps.request_id
      AND (
        r.applicant_id = auth_employee_id()
        OR auth_is_my_dept_member(r.applicant_id)
        OR auth_is_hr_admin()
      )
  )
);
CREATE POLICY approval_steps_insert_hr ON approval_steps FOR INSERT
WITH CHECK (auth_is_hr_admin());

ALTER TABLE approval_flow_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON approval_flow_configs;
CREATE POLICY approval_flow_configs_select_all ON approval_flow_configs FOR SELECT USING (true);
CREATE POLICY approval_flow_configs_insert_hr ON approval_flow_configs FOR INSERT
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY approval_flow_configs_update_hr ON approval_flow_configs FOR UPDATE
USING (auth_role_in('hr', 'admin')) WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY approval_flow_configs_delete_hr ON approval_flow_configs FOR DELETE
USING (auth_role_in('hr', 'admin'));

ALTER TABLE shift_swap_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON shift_swap_requests;
CREATE POLICY shift_swap_requests_select_own_or_dept_or_hr ON shift_swap_requests FOR SELECT
USING (
  requester_id = auth_employee_id()
  OR auth_is_my_dept_member(requester_id)
  OR auth_is_hr_admin()
);
CREATE POLICY shift_swap_requests_insert_own ON shift_swap_requests FOR INSERT
WITH CHECK (requester_id = auth_employee_id() OR auth_is_hr_admin());
CREATE POLICY shift_swap_requests_update_own_or_dept_or_hr ON shift_swap_requests FOR UPDATE
USING (
  requester_id = auth_employee_id()
  OR auth_is_my_dept_member(requester_id)
  OR auth_is_hr_admin()
) WITH CHECK (
  requester_id = auth_employee_id()
  OR auth_is_my_dept_member(requester_id)
  OR auth_is_hr_admin()
);
CREATE POLICY shift_swap_requests_delete_hr ON shift_swap_requests FOR DELETE
USING (auth_role_in('hr', 'admin'));
```

### 5.11 approvals_v2 系列

```sql
-- ============================================
-- approvals_v2_applications
-- ============================================
ALTER TABLE approvals_v2_applications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON approvals_v2_applications;

CREATE POLICY approvals_v2_applications_select_own_or_dept_or_hr ON approvals_v2_applications FOR SELECT
USING (
  applicant_id = auth_employee_id()
  OR (supervisor_id = auth_employee_id())
  OR auth_is_my_dept_member(applicant_id)
  OR auth_is_hr_admin()
);

CREATE POLICY approvals_v2_applications_insert_own ON approvals_v2_applications FOR INSERT
WITH CHECK (
  applicant_id = auth_employee_id()
  OR auth_is_hr_admin()
);

CREATE POLICY approvals_v2_applications_update_own_or_review_or_hr ON approvals_v2_applications FOR UPDATE
USING (
  (applicant_id = auth_employee_id() AND status = 'draft')
  OR (supervisor_id = auth_employee_id())
  OR auth_role_in('ceo', 'chairman')
  OR auth_is_hr_admin()
)
WITH CHECK (
  (applicant_id = auth_employee_id() AND status = 'draft')
  OR (supervisor_id = auth_employee_id())
  OR auth_role_in('ceo', 'chairman')
  OR auth_is_hr_admin()
);

CREATE POLICY approvals_v2_applications_delete_hr ON approvals_v2_applications FOR DELETE
USING (auth_role_in('hr', 'admin'));

-- ============================================
-- approvals_v2_approval_actions (audit)
-- ============================================
ALTER TABLE approvals_v2_approval_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON approvals_v2_approval_actions;

CREATE POLICY approvals_v2_approval_actions_select_via_app ON approvals_v2_approval_actions FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM approvals_v2_applications a
    WHERE a.id = approvals_v2_approval_actions.app_id
      AND (
        a.applicant_id = auth_employee_id()
        OR a.supervisor_id = auth_employee_id()
        OR auth_is_my_dept_member(a.applicant_id)
        OR auth_is_hr_admin()
      )
  )
);

CREATE POLICY approvals_v2_approval_actions_insert_hr ON approvals_v2_approval_actions FOR INSERT
WITH CHECK (auth_is_hr_admin());

-- ============================================
-- approvals_v2_notifications
-- ============================================
ALTER TABLE approvals_v2_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON approvals_v2_notifications;

CREATE POLICY approvals_v2_notifications_select_own ON approvals_v2_notifications FOR SELECT
USING (recipient_id = auth_employee_id() OR auth_is_hr_admin());

CREATE POLICY approvals_v2_notifications_insert_hr ON approvals_v2_notifications FOR INSERT
WITH CHECK (auth_is_hr_admin());

CREATE POLICY approvals_v2_notifications_update_own_read ON approvals_v2_notifications FOR UPDATE
USING (recipient_id = auth_employee_id() OR auth_is_hr_admin())
WITH CHECK (recipient_id = auth_employee_id() OR auth_is_hr_admin());

-- ============================================
-- approvals_v2_role_assignments
-- ============================================
-- attendance ceo-review.js 會查這張表（用 anon client 動態 import）
-- 需要 SELECT 全開、其他操作 hr+admin
ALTER TABLE approvals_v2_role_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON approvals_v2_role_assignments;

CREATE POLICY approvals_v2_role_assignments_select_all ON approvals_v2_role_assignments FOR SELECT USING (true);
CREATE POLICY approvals_v2_role_assignments_insert_hr ON approvals_v2_role_assignments FOR INSERT
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY approvals_v2_role_assignments_update_hr ON approvals_v2_role_assignments FOR UPDATE
USING (auth_role_in('hr', 'admin')) WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY approvals_v2_role_assignments_delete_hr ON approvals_v2_role_assignments FOR DELETE
USING (auth_role_in('hr', 'admin'));
```

### 5.12 系統設定

```sql
-- ============================================
-- system_settings
-- ============================================
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON system_settings;

CREATE POLICY system_settings_select_all ON system_settings FOR SELECT USING (true);
CREATE POLICY system_settings_insert_hr ON system_settings FOR INSERT
WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY system_settings_update_hr ON system_settings FOR UPDATE
USING (auth_role_in('hr', 'admin')) WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY system_settings_delete_hr ON system_settings FOR DELETE
USING (auth_role_in('hr', 'admin'));
```

---

## 6. 部署順序

### Phase 1：lib/supabase.js 改造 + Vercel env var

**前置**：
1. 從 Supabase Dashboard → Settings → API 複製 service_role key
2. Vercel Project Settings → Environment Variables → 新增 `SUPABASE_SERVICE_ROLE_KEY`、scope 選 production + preview + development、貼上 key
3. 不要 redeploy

**Action**：
1. Claude Code 改 lib/supabase.js（加 supabaseAdmin export）
2. vitest 跑、確認 400/400 仍綠
3. commit、push、Vercel auto deploy
4. 觀察 prod 1 小時、確認沒 error log

**預期行為**：完全無感、沒人用 supabaseAdmin。

**ROLLBACK**：commit revert + 移除 env var。

---

### Phase 2：lib/auth.js 改造

**Action**：
1. Claude Code 改 lib/auth.js（dev → strict、刪 requireRoleOrPass）
2. Claude Code 改用到 requireRoleOrPass 的所有 endpoint（換成 requireRole）
3. cron endpoint 加 secret 認證（見 §9.6）
4. vitest 跑、確認 400/400 全綠
5. commit、push、Vercel auto deploy
6. 觀察 prod 2 小時、smoke test 各 role 登入

**預期行為**：未登入 / role 不符 → 401/403（之前是 mock 放行）。

**風險**：如果有 endpoint 之前靠 dev mode 放行邊角情境、現在會擋。會看到 401/403 噴出來。

**ROLLBACK**：commit revert。

---

### Phase 3：API endpoint 改用 supabaseAdmin

**Action**（分 3 個 commit）：

Commit 3a：Tier 1 endpoints（attendance / leaves / schedules / schedule-periods / employees-self）
Commit 3b：Tier 2 endpoints（hr 後台類）
Commit 3c：Tier 3 endpoints（cron / 雜項 + ceo-review.js 動態 import）

每 commit：
1. Claude Code 改 supabase → supabaseAdmin
2. vitest 跑、確認 400/400 全綠
3. commit、push、Vercel auto deploy
4. 觀察 prod 2 小時

**預期行為**：完全無感（service_role 在 RLS allow_all 下、跟 anon 同效）。

**ROLLBACK**：commit revert。

---

### Phase 4：RLS SQL 上 prod

**前置**：
1. Phase 1-3 全部穩定運行 24+ 小時
2. ROLLBACK SQL 準備好（§7）
3. Smoke test 清單準備好（§8）
4. Claude Code 確認 §9 內所有 schema 推測欄位

**Action**：

```sql
BEGIN;

-- 1. 建 helper functions（§3.2 整段）
-- 2. 對 39 張表逐一 DROP allow_all + CREATE 嚴格 policy（§5 整段）

-- 3. 驗證
SELECT tablename, COUNT(*) AS policy_count
FROM pg_policies WHERE schemaname = 'public'
GROUP BY tablename ORDER BY tablename;

SELECT tablename, COUNT(*) FROM pg_policies
WHERE schemaname = 'public' AND policyname = 'allow_all'
GROUP BY tablename;
-- 應該回傳 0 row

-- 4. 全部對才 COMMIT；任何不對都 ROLLBACK
COMMIT;
-- (or ROLLBACK;)
```

**Action 後**：
1. 立刻跑 §8 Smoke test 清單、所有 role 都試
2. 觀察 prod 2 小時、看 error log
3. 觀察 Supabase Dashboard 看有沒有 RLS error 暴增

**ROLLBACK**：跑 §7 ROLLBACK SQL、回到 allow_all。

---

### Phase 5：Smoke Test + 觀察期

連續 24 小時觀察：
- Vercel error log 量
- Supabase Logs (Postgres / Auth / API) error 量
- 員工回報

無異常 → 改造完成。

---

## 7. ROLLBACK 計畫

### 7.1 各 Phase ROLLBACK

| Phase | ROLLBACK 方式 |
|---|---|
| Phase 1 | git revert + 移除 Vercel env var |
| Phase 2 | git revert |
| Phase 3 | git revert（單個 commit 或全部） |
| Phase 4 | 跑 §7.2 SQL（嚴格 policy → allow_all） |

### 7.2 緊急 ROLLBACK SQL（Phase 4）

```sql
-- 緊急 ROLLBACK：把所有表 RLS policy 退回 allow_all 模式
-- 用法：BEGIN; <貼整段>; COMMIT;
-- 用時間：1-2 秒

BEGIN;

DO $$
DECLARE
  t text;
  p text;
  tables text[] := ARRAY[
    'announcement_reads', 'announcements',
    'annual_leave_records',
    'approval_flow_configs', 'approval_requests', 'approval_steps',
    'approvals_v2_applications', 'approvals_v2_approval_actions',
    'approvals_v2_notifications', 'approvals_v2_role_assignments',
    'attendance', 'attendance_penalties', 'attendance_penalty_records',
    'comp_time_balance',
    'departments', 'employees',
    'health_insurance_brackets', 'holidays',
    'insurance_change_requests', 'insurance_settings',
    'labor_insurance_brackets',
    'leave_balance_logs', 'leave_requests', 'leave_types',
    'notifications',
    'overtime_limits', 'overtime_request_logs', 'overtime_requests',
    'push_subscriptions',
    'salary_grade', 'salary_records',
    'schedule_change_logs', 'schedule_periods', 'schedules',
    'shift_swap_requests', 'shift_types',
    'system_overtime_settings', 'system_settings'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    FOR p IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p, t);
    END LOOP;
    EXECUTE format('CREATE POLICY allow_all ON %I FOR ALL USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- 移除 helper functions（可選）
-- DROP FUNCTION IF EXISTS public.auth_employee();
-- DROP FUNCTION IF EXISTS public.auth_employee_id();
-- DROP FUNCTION IF EXISTS public.auth_employee_role();
-- DROP FUNCTION IF EXISTS public.auth_is_manager();
-- DROP FUNCTION IF EXISTS public.auth_employee_dept_id();
-- DROP FUNCTION IF EXISTS public.auth_role_in(text[]);
-- DROP FUNCTION IF EXISTS public.auth_is_hr_admin();
-- DROP FUNCTION IF EXISTS public.auth_is_my_dept_member(text);

SELECT tablename, policyname FROM pg_policies
WHERE schemaname = 'public' AND policyname = 'allow_all'
ORDER BY tablename;

COMMIT;
```

---

## 8. Smoke Test 清單

### 8.1 Admin role（用 EMP_99999999 / 99999999 + 密碼）

- [ ] 登入成功
- [ ] 進員工資料頁、看到全部 23 個員工
- [ ] 進薪資頁、看到全部薪資
- [ ] 改某個員工資料、儲存成功
- [ ] 進 holidays-admin、新增一個假日、儲存成功
- [ ] 進 attendance-penalty-admin、改規則、儲存成功

### 8.2 CEO role（Ray 自己 EMP_01250901）

- [ ] 登入成功
- [ ] 進「我的勤務」全部頁面（打卡 / 我的排班 / 請假 / 補休）
- [ ] 進 HR 後台所有頁面（holidays / attendance-penalty / 加班 / 薪資管理）
- [ ] 員工自助操作（自己排班、打卡）

### 8.3 Manager role（要找一個 is_manager=true 的員工測）

- [ ] 登入成功
- [ ] 進「我的勤務」自己用
- [ ] 進「勤務管理」看部門員工排班
- [ ] 看不到別部門員工
- [ ] 不能進薪資管理頁面（403）
- [ ] 看不到部下薪資（salary_records.SELECT 不放行 manager）

### 8.4 一般 employee role

- [ ] 登入成功
- [ ] 「我的勤務」全部 OK
- [ ] 看自己排班、自己打卡、自己請假
- [ ] 看不到別人的請假申請
- [ ] 看不到別人的薪資
- [ ] 看不到別人的個人資料
- [ ] 看不到 HR 後台選單

### 8.5 直連 Supabase 驗 RLS（最重要、驗 RLS 真的擋）

用瀏覽器 console 跑（用一般員工 token）：

```js
// 試圖讀別人的薪資
const { data, error } = await supabase
  .from('salary_records')
  .select('*')
  .neq('employee_id', '<我的 id>');
console.log(data); // 期待：[] 空陣列（RLS filter 掉）
```

```js
// 試圖改別人的請假申請
const { data, error } = await supabase
  .from('leave_requests')
  .update({ status: 'approved' })
  .neq('employee_id', '<我的 id>');
console.log(error); // 期待：non-null error 或 0 rows affected
```

如果員工能透過 anon client 讀寫不該讀寫的資料 → RLS 沒生效、要 ROLLBACK 重做。

---

## 9. 風險與已知未解

### 9.1 chairman role 的存在性確認

設計矩陣假設 `chairman` role 存在、跟 `ceo` 同等對待。
**Action**：Phase 4 之前跑 SQL 確認：

```sql
SELECT DISTINCT role FROM employees ORDER BY role;
```

如果沒有 chairman、helper function `auth_role_in('hr', 'admin', 'ceo', 'chairman')` 不影響功能（多列出來無害）。

### 9.2 dept vs dept_id 並存

employees 表有 `dept` (text, NOT NULL) 跟 `dept_id` (text, nullable) 兩個欄位。RLS 設計用 `dept_id`、但部分舊資料可能 dept_id 是 null。

**影響**：dept_id=null 的員工在 `auth_is_my_dept_member()` 永遠 false → manager 看不到他、他看不到別人。
**Action**：
1. Phase 4 之前跑 SQL 盤點：`SELECT COUNT(*) FROM employees WHERE dept_id IS NULL AND status = 'active';`
2. 如果有 → 補資料：`UPDATE employees SET dept_id = (SELECT id FROM departments WHERE name = employees.dept) WHERE dept_id IS NULL;`

### 9.3 approvals_v2 source code 缺失

prod 上 4 張 approvals_v2 表存在、但 lib/approvals_v2/ + api/apps.js 都不存在。
**影響**：本次 RLS 涵蓋這 4 張表、但 application layer 邏輯不在 repo 內。
**Action**：本次設計範圍不重寫 approvals_v2、留待之後 phase。

### 9.4 announcement_reads / notifications / push_subscriptions / shift_swap_requests / approval_requests schema

設計時假設了欄位名（如 employee_id / recipient_id / requester_id / applicant_id）、但 schema 沒在這次盤點中包含這幾張表。

**Action**：Phase 4 之前 Claude Code 確認這些表的實際欄位名、必要時調整 policy SQL。

### 9.5 動態 import：ceo-review.js

`api/overtime-requests/[id]/ceo-review.js` 用 `await import('../../../lib/supabase.js')` 動態載入。Phase 3 改 supabase → supabaseAdmin 時要確保動態 import 也改。

**Action**：Claude Code 實作 Phase 3 時注意這個 edge case。

### 9.6 cron endpoint 認證

6 個 cron endpoint（cron-absence-detection, cron-annual-leave-rollover, cron-comp-expiry, cron-comp-expiry-warning, cron-schedule-lock, cron-schedule-reminder）由 Vercel cron 觸發、不會帶 user JWT。

**影響**：lib/auth.js strict mode 後、cron 進來會被擋（沒 token → 401）。
**Action**：
- cron endpoint 用 Vercel cron secret header 認證、跳過 lib/auth.js
- 或在 lib/auth.js 加 `bypass for cron secret` 邏輯
- Phase 2 實作時要處理這個

### 9.7 EMP_ADMIN 廢資料

prod 上有兩個 admin role 員工（EMP_ADMIN + EMP_99999999）、之前盤點過 EMP_ADMIN 是廢資料（schedule_periods 有 1 筆孤兒、其他全 0）。

**影響**：RLS 上線後 EMP_ADMIN 還能不能登入要看它有沒有對應 auth_user_id。
**Action**：本次 phase 結束後、Step 「最後清理」時處理（清 EMP_ADMIN row）。

### 9.8 性能影響

每個 SELECT/INSERT/UPDATE/DELETE 都會跑 helper function、helper function 內又是 subquery employees。可能對 query 效能有影響。

**Action**：
- 確保 employees.auth_user_id 有 index
- Phase 4 後觀察 Supabase Dashboard 的 slow query log
- 必要時加 index：`CREATE INDEX IF NOT EXISTS idx_employees_auth_user_id ON employees(auth_user_id);`

---

## 10. 實作 Checklist（給 Claude Code 用）

### Phase 1
- [ ] 確認 Vercel env var `SUPABASE_SERVICE_ROLE_KEY` 已設好（Ray 操作）
- [ ] 改 lib/supabase.js（按 §2.1）
- [ ] 跑 vitest 全綠
- [ ] commit + push + 觀察 prod 1 小時

### Phase 2
- [ ] 確認 §9.6 cron endpoint 認證方案
- [ ] 改 lib/auth.js（按 §2.2）
- [ ] grep 用到 requireRoleOrPass 的 endpoint、全換 requireRole
- [ ] 各 endpoint 補 `if (!caller) return;` 早期 return
- [ ] cron endpoint 加 secret 認證
- [ ] 跑 vitest 全綠
- [ ] commit + push + 觀察 prod 2 小時

### Phase 3
- [ ] commit 3a：Tier 1 endpoints 改 supabase → supabaseAdmin
- [ ] vitest 全綠 + push + 觀察 2 小時
- [ ] commit 3b：Tier 2 endpoints
- [ ] vitest 全綠 + push + 觀察 2 小時
- [ ] commit 3c：Tier 3 endpoints + ceo-review.js 動態 import
- [ ] vitest 全綠 + push + 觀察 2 小時

### Phase 4
- [ ] 跑 §9 各條 Action 預檢查
- [ ] 確認 §9.4 schema 推測欄位、調整 policy SQL
- [ ] 確認 §9.7 EMP_ADMIN 處理（先不刪、上完 RLS 一起處理）
- [ ] BEGIN; 跑 helper functions + 39 表 policy + 驗證 query；COMMIT;
- [ ] 立刻跑 §8 smoke test
- [ ] 觀察 24 小時

### Phase 5
- [ ] 確認 prod 穩定 24+ 小時
- [ ] 處理 EMP_ADMIN cleanup（§9.7）
- [ ] 處理 Ray locked period
- [ ] 處理晚班 ST002 NULL 設計
- [ ] 員工試排班完整流程驗證

---

## 11. 設計總結

| 維度 | 之前 | 之後 |
|---|---|---|
| RLS 政策 | 25 條全 allow_all | 38 表 × 4 操作 = ~150 條精確 policy |
| Server client | anon key | service_role key |
| Client client | anon key | anon key（受 RLS 限制） |
| lib/auth.js | dev pass-through | strict 401/403 |
| Cron 認證 | 沒有 | secret header |
| 員工身份反查 | email | auth_user_id |
| 防線層數 | 1（handler check 歪打正著） | 3（handler + auth.js + RLS） |

預估時程：

| Phase | 預估 |
|---|---|
| Phase 1 | 半天（含 env var + observe）|
| Phase 2 | 半天到 1 天（cron 認證設計 + endpoint 改 + observe）|
| Phase 3 | 1 天（45 endpoints 分 3 tier + observe）|
| Phase 4 | 半天（SQL + smoke test）|
| Phase 5 | 24-48 小時觀察期（不需主動工作）|

合計：3-4 天工作 + 1-2 天觀察。

---

# 文件結束

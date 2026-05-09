# HR 月度薪資計算 SOP（標準作業流程）

> 適用版本:hr-system-v2 / 階段 0+1+2+3+4 完成後  
> 對應 prod URL:https://chuwa-hr-system.vercel.app  
> 更新日期:2026-05-10

---

## 目錄

1. [系統概覽](#1-系統概覽)
2. [角色與權限](#2-角色與權限)
3. [月結前置作業（每月 25 日前完成）](#3-月結前置作業每月-25-日前完成)
4. [月結試算（月底執行）](#4-月結試算月底執行)
5. [試算結果驗證 ★ 最關鍵](#5-試算結果驗證--最關鍵)
6. [老闆審核](#6-老闆審核)
7. [標記發放](#7-標記發放)
8. [期間鎖定](#8-期間鎖定)
9. [員工申訴與修改](#9-員工申訴與修改)
10. [排錯指南](#10-排錯指南)
11. [Appendix A:薪資計算公式 reference](#appendix-a薪資計算公式-reference)
12. [Appendix B:SQL 檢驗 query 集](#appendix-bsql-檢驗-query-集)
13. [Appendix C:名詞定義](#appendix-c名詞定義)

---

## 1. 系統概覽

### 1.1 工作流階段（payroll_periods 狀態機）

```
draft → calculating → pending_review → approved → paid → locked
 草稿     計算中         待審核         已核准    已發放   已鎖定
```

| 階段 | 觸發者 | 動作 | 可退回 |
|---|---|---|---|
| draft | HR 建立期間時 | 期間建立、尚未跑試算 | — |
| calculating | HR 按「跑試算」 | 系統正在計算中（30~60 秒） | → draft（取消試算） |
| pending_review | calculator 跑完自動 | 等待老闆審核 | → calculating（重跑） |
| approved | 老闆按「核准」 | 已核准、待發放 | → calculating（退回重算、需填原因） |
| paid | HR 按「標記已發放」 | 已實際匯款 | — |
| locked | admin 或月底 cron | 永久鎖定、無法修改 | — |

### 1.2 模組架構

| 元件 | 用途 |
|---|---|
| `payroll_periods` 表 | 薪資期間狀態 + 統計 cache |
| `salary_records` 表 | 個別員工薪資資料（每員工每月一筆） |
| `insurance_settings` 表 | 員工投保 / 月提繳工資 / 自願提繳率 |
| `lib/salary/calculator.js` | 月結計算引擎（15 步主流程） |
| `lib/salary/tax-withholding.js` | 所得稅扣繳計算 |
| `lib/salary/supplementary-health.js` | 二代健保補充保費 |
| `lib/salary/pension-deduction.js` | 勞退提繳計算 |
| `lib/salary/employer-cost.js` | 雇主成本 6 項計算 |
| `lib/salary/period-stats.js` | 期間統計 cache reconcile |

### 1.3 主要前端入口

| 頁面 | 用途 | 角色 |
|---|---|---|
| `/dashboard.html` | 看當月薪資期間 widget（進度條） | HR / admin / ceo / chairman |
| `/salary-period.html` | 期間管理（建立 / 跑試算 / 核准 / 發放 / 鎖定） | HR / admin / ceo / chairman |
| `/salary.html` | 個別員工薪資編輯（lock deduct_tax 等） | HR / admin |
| `/payslip.html` | 個別員工薪資單（可列印 / 存 PDF） | 員工 / HR |
| `/employee-salary.html` | 員工自己看每月薪資 | 員工本人 |

---

## 2. 角色與權限

| 角色 | 可做 | 不可做 |
|---|---|---|
| 員工 | 看自己的薪資單、列印 | 看別人薪資、改薪資 |
| 主管 | 同員工（不額外授予薪資權限） | 看部屬薪資 |
| HR | 期間 CRUD、跑試算、退回、標記發放、編輯 _manual 欄位 | 核准、永久鎖定 |
| CEO / 董事長 | HR 全部 + **核准** + 退回已核准的期間 | 永久鎖定（防誤操作） |
| Admin | 全部 + **永久鎖定** | — |

⚠️ **重要區分**:
- 「核准」(approved) — 表示老闆同意這個月薪資金額、流程上的 milestone
- 「永久鎖定」(locked) — 表示這個期間之後永久不可修改、是不可逆操作

---

## 3. 月結前置作業（每月 25 日前完成）

⚠️ **若 25 日後才補資料、calculator 會用「跑試算當下」的資料、可能造成計算錯誤、必須重跑。**

### 3.1 員工資料完整性檢查

#### A. 在職員工 base_salary

打開 `/employees.html`、確認每個在職員工:
- ✅ `base_salary` 已設（不是 0、不是 NULL）
- ✅ `employment_type` 正確（full_time / part_time）
- ✅ `dept_id` 正確
- ✅ 預計離職員工 `resign_date` 已標
- ✅ 已離職員工 `status='resigned'`、`resigned_at` 已標

#### B. 員工數確認

```sql
-- 在 Supabase Studio 跑、確認在職員工數
SELECT 
  COUNT(*) AS total_employees,
  COUNT(*) FILTER (WHERE status='active') AS active_employees,
  COUNT(*) FILTER (WHERE status='resigned') AS resigned_employees
FROM employees;
```

預期 `active_employees` = 跑試算時會被計算的員工數。

### 3.2 投保資料 / 自願提繳設定

#### A. 員工投保資料

打開 `/insurance.html`、確認每個 has_insurance=true 的員工:
- ✅ `labor_ins_bracket`（勞保投保金額、依勞保級距表）
- ✅ `health_ins_bracket`（健保投保金額）
- ✅ `pension_wage`（月提繳工資、通常 = labor_ins_bracket）
- ✅ `pension_voluntary_rate`（員工自願提繳率、0~6、預設 0）
- ✅ `health_ins_dependents`（健保眷屬數、預設 0）

⚠️ **特別注意**:`pension_wage` 是 0.1 階段加的欄位、prod 既有員工可能 = 0(已 hot fix backfill 處理)。新增員工要主動設、避免 employer_cost_pension 算 0。

#### B. SQL 一次驗證

```sql
SELECT 
  e.id, e.name, e.base_salary, e.status,
  i.labor_ins_bracket, i.health_ins_bracket,
  i.pension_wage, i.pension_voluntary_rate,
  i.has_insurance
FROM employees e
LEFT JOIN insurance_settings i ON i.employee_id = e.id
WHERE e.status = 'active'
ORDER BY e.id;
```

**檢查點**:
- 在職員工 has_insurance=true 但 `labor_ins_bracket IS NULL` → ❌ 缺投保資料
- has_insurance=true 但 `pension_wage = 0` → ⚠️ employer_cost_pension 會算 0、要修
- `pension_voluntary_rate > 0` 的員工 → 確認本人有簽自願提繳同意書

### 3.3 出勤資料完整性

#### A. 確認該月出勤記錄完整

打開 `/calendar.html` 看月曆、確認:
- ✅ 沒有員工該月份完全沒打卡
- ✅ 異常出勤（曠職 / 遲到）已 review

```sql
-- 該月份缺少打卡記錄的員工
SELECT 
  e.id, e.name, COUNT(a.id) AS attendance_count
FROM employees e
LEFT JOIN attendance_records a 
  ON a.employee_id = e.id 
  AND EXTRACT(YEAR FROM a.work_date) = 2026
  AND EXTRACT(MONTH FROM a.work_date) = 5
WHERE e.status = 'active'
GROUP BY e.id, e.name
ORDER BY attendance_count;
```

預期每個在職員工該月應該有 20+ 筆打卡記錄。

#### B. 加班 / 請假審核完成

確認:
- ✅ 該月份所有 `overtime_requests.status` 都是 `approved` 或 `rejected`(無 pending)
- ✅ 該月份所有 `leave_requests.status` 都是 `approved` 或 `rejected`(無 pending)

```sql
-- pending 加班 / 請假申請
SELECT 'overtime' AS type, COUNT(*) FROM overtime_requests
WHERE status = 'pending' 
  AND EXTRACT(YEAR FROM work_date) = 2026
  AND EXTRACT(MONTH FROM work_date) = 5
UNION ALL
SELECT 'leave', COUNT(*) FROM leave_requests
WHERE status = 'pending'
  AND EXTRACT(YEAR FROM start_date) = 2026
  AND EXTRACT(MONTH FROM start_date) = 5;
-- expect: 兩條都是 0
```

### 3.4 假日 / 國定假日設定

確認 `holidays` 表該月份完整:

```sql
SELECT date, holiday_type, name, pay_multiplier
FROM holidays
WHERE EXTRACT(YEAR FROM date) = 2026 AND EXTRACT(MONTH FROM date) = 5
ORDER BY date;
```

**檢查點**:
- ✅ 國定假日（national）都已建
- ✅ 公司休假日（company）都已建
- ✅ pay_multiplier 設定正確（國定通常 2.0、補休通常 1.0）

### 3.5 前置作業檢查清單

| 項目 | 檢查方式 | 通過條件 |
|---|---|---|
| 在職員工 base_salary | SQL 3.1.B | active 員工 base_salary > 0 |
| 員工投保 / 月提繳 | SQL 3.2.B | has_insurance=true 員工 labor_ins_bracket / pension_wage 都有值 |
| 該月出勤 | SQL 3.3.A | 在職員工都有 20+ 筆打卡 |
| 加班 / 請假 | SQL 3.3.B | pending = 0 |
| 假日設定 | SQL 3.4 | 該月國定 / 公司假日都已建 |

✅ 全部通過 → 可進月結試算

---

## 4. 月結試算（月底執行）

### 4.1 建立薪資期間

打開 `/salary-period.html`:

1. 點「**+ 開新期間**」按鈕
2. 填入:
   - 年:2026
   - 月:5
   - 期間開始:2026-05-01
   - 期間結束:2026-05-31
   - 出勤截止日:2026-05-31
   - 發薪日:2026-06-10（依公司規定）
   - 備註:可空
3. 點「**建立**」

✅ 列表出現 `PP_2026_05` row、status：「草稿」

### 4.2 跑試算

1. 在期間列表點 `PP_2026_05` row
2. 開啟「詳細」modal
3. 點「**跑試算**」按鈕
4. 點確認對話框（⚠️ 跑下去 calculator 會把該月份所有員工算過、_auto 欄位被覆蓋）
5. **等候 30~60 秒**（依員工數、約 3~6 秒/員工）

### 4.3 監看試算結果

試算完成後:
- ✅ Toast 顯示「試算完成、X 筆」
- ✅ 期間列表 row status 自動變「**待審核**」
- ✅ 員工數 / 應發合計 / 實發合計 / 雇主成本 cache 寫入

回 dashboard 看「本月薪資期間」widget:
- ✅ 進度條走到「**待審核**」（藍色 highlight）
- ✅ 4 個統計數字都有值（不是 0）
- ✅ 「最後計算」時間是剛才跑的時間

⚠️ **若試算超過 60 秒沒結果** → 看 [10.1 試算超時](#101-試算超時)

---

## 5. 試算結果驗證 ★ 最關鍵

⚠️ **這個章節最重要、別跳過**。試算只是「算出來」、是否「算對」要 HR 自己驗證。一旦標 paid、就無法輕易回頭。

### 5.1 整體 sanity check（5 分鐘可完成）

#### A. 員工數對不對

開 dashboard 看 widget「員工數」、應該等於該月**有薪資要計算的員工數**:
- 在職員工 + 該月離職員工（部分發放）
- 不含完全沒投保的（如果有特殊情況）

```sql
-- 該月份應該被計算的員工數
SELECT COUNT(*) FROM employees
WHERE status = 'active' OR (status = 'resigned' AND resigned_at >= '2026-05-01');
```

預期跟 widget 一致。

#### B. 應發合計合理範圍

應發合計 ≈ Σ(員工 base_salary + attendance_bonus + 加班費 + 獎金)

粗估:
- 31 人 × 平均薪資 35,000 = ~1,085,000
- 若應發合計差超過 ±10%、要排查

#### C. 雇主成本占比合理

```
雇主成本 / 應發合計 ≈ 16~22%
```

組成（典型）:
- 勞保雇主 70% ≈ 應發 × 7%
- 健保雇主 60% ≈ 應發 × 4%
- 勞退 6% ≈ 應發 × 6%
- 職災 / 就保 / 福利金 ≈ 1~3%

若 < 14% 或 > 24% 要排查。

```sql
SELECT 
  employee_count,
  gross_total,
  net_total,
  employer_cost_total,
  ROUND(employer_cost_total / NULLIF(gross_total, 0) * 100, 1) AS employer_cost_pct
FROM payroll_periods
WHERE id = 'PP_2026_05';
```

### 5.2 個別員工抽查（5 種情境、15 分鐘）

從 salary.html 點各種代表性員工的「編輯」、檢查數字。

#### 情境 A:月薪低 + 滿勤（基準對照）

選一個月薪 30,000 / 出勤滿勤 / 沒加班 / 沒獎金的員工:

| 欄位 | 預期值 | 算法 |
|---|---|---|
| `base_salary` | 30,000 | 員工資料 |
| `attendance_bonus_actual` | 2,000 | 全勤獎金（依公司設定） |
| `gross_salary` | 32,000 | 30,000 + 2,000 |
| `deduct_labor_ins` | ~600 | 從 brackets.employee_premium |
| `deduct_health_ins` | ~430 | 從 brackets.employee_premium |
| `deduct_tax` | 0 | 月薪 < 88,500 免稅額 |
| `deduct_pension_voluntary` | 0 | 沒設自願率 |
| `net_salary` | ~30,970 | gross - 勞健保 |
| `employer_cost_pension` | 1,800 | 30,000 × 6% |

⚠️ 若任何欄位差太多、立即查 SQL（見 5.3）。

#### 情境 B:月薪中 + 加班費

選一個月薪 35,000 + 有加班費的員工:

預期:
- `overtime_pay_auto` > 0（從 overtime_requests 算）
- `gross_salary` 比基本 base 多
- `deduct_tax` 仍可能 = 0（除非含獎金 + 加班讓 taxable > 88,500）

#### 情境 C:月薪高（超過免稅額）

選一個月薪 ≥ 90,000 的員工:

| 預期 | 計算 |
|---|---|
| `taxable_income_snapshot` | gross_pre_tax - deduct_pension_voluntary |
| `deduct_tax` | (taxable - 88,500) × 6% |

例如月薪 100,000 / 0 扶養 / 不自願提繳:
- taxable = 100,000
- deduct_tax = (100,000 - 88,500) × 6% = **690**

#### 情境 D:有自願勞退提繳

選一個 `pension_voluntary_rate > 0` 的員工（從 insurance.html 確認）:

例如 pension_voluntary_rate = 6 / pension_wage = 45,800:
- `deduct_pension_voluntary` = 45,800 × 6% = **2,748**
- 同時 `taxable_income_snapshot` 會減去 2,748（自願提繳免稅）
- 因此 `deduct_tax` 比沒自願時低

#### 情境 E:有獎金 + 二代健保補充保費

選一個有獎金（HR 已填 bonus_yearend / festival 等）的員工:

預期 `deduct_supplementary_health`:
- 該年度累計獎金 > insured_salary_health × 4 倍時、超過部分扣 2.11%
- 例如 health 投保 50,000 × 4 = 200,000 門檻
- 若該員工今年到目前累計獎金（含本月）= 250,000、本月獎金 100,000 → 跨越門檻
- 補充保費 = 50,000 × 2.11% = **1,055**

### 5.3 SQL 詳細驗證

#### A. 高薪員工有沒有正確扣稅

```sql
-- 月薪超過 88,500 的員工本月應該扣稅
SELECT 
  s.employee_id,
  e.name,
  s.base_salary,
  s.gross_salary,
  s.taxable_income_snapshot,
  s.deduct_tax,
  s.deduct_tax_manual_override,
  CASE
    WHEN s.deduct_tax_manual_override THEN '🔒 HR 鎖定'
    WHEN s.taxable_income_snapshot <= 88500 THEN '免稅（< 免稅額）'
    ELSE ROUND((s.taxable_income_snapshot - 88500) * 0.06)::TEXT || ' 預期'
  END AS expected
FROM salary_records s
JOIN employees e ON e.id = s.employee_id
WHERE s.year = 2026 AND s.month = 5
  AND s.taxable_income_snapshot > 88500
ORDER BY s.taxable_income_snapshot DESC;
```

✅ 對:`deduct_tax` 跟 expected 一致（除非 HR 鎖定）

#### B. 雇主強制 6% 勞退提繳

```sql
SELECT 
  s.employee_id,
  e.name,
  s.pension_wage_snapshot,
  s.employer_cost_pension,
  ROUND(s.pension_wage_snapshot * 0.06) AS expected,
  CASE 
    WHEN s.pension_wage_snapshot = 0 THEN '⚠️ pension_wage = 0、要 backfill'
    WHEN ABS(s.employer_cost_pension - s.pension_wage_snapshot * 0.06) <= 1 THEN '✅'
    ELSE '❌ 不符'
  END AS check
FROM salary_records s
JOIN employees e ON e.id = s.employee_id
WHERE s.year = 2026 AND s.month = 5
ORDER BY s.employee_id;
```

✅ 對:所有有投保員工 `employer_cost_pension = pension_wage_snapshot × 6%`

#### C. 員工自願勞退與課稅薪資扣除

```sql
SELECT 
  s.employee_id,
  e.name,
  s.pension_wage_snapshot,
  i.pension_voluntary_rate,
  s.deduct_pension_voluntary,
  ROUND(s.pension_wage_snapshot * i.pension_voluntary_rate / 100.0) AS expected,
  s.taxable_income_snapshot
FROM salary_records s
JOIN employees e ON e.id = s.employee_id
LEFT JOIN insurance_settings i ON i.employee_id = s.employee_id
WHERE s.year = 2026 AND s.month = 5
  AND i.pension_voluntary_rate > 0
ORDER BY s.employee_id;
```

✅ 對:`deduct_pension_voluntary = pension_wage × voluntary_rate / 100`

#### D. 二代健保補充保費（若有員工有獎金）

```sql
WITH ytd_bonus AS (
  SELECT 
    employee_id,
    SUM(COALESCE(bonus_yearend, 0) + COALESCE(bonus_festival, 0) 
      + COALESCE(bonus_performance, 0) + COALESCE(bonus_other, 0)) AS total_ytd_bonus
  FROM salary_records
  WHERE year = 2026 AND month <= 5
  GROUP BY employee_id
)
SELECT 
  s.employee_id,
  e.name,
  s.insured_salary_health_snapshot AS health_insured,
  s.insured_salary_health_snapshot * 4 AS threshold,
  yb.total_ytd_bonus AS ytd_bonus,
  COALESCE(s.bonus_yearend, 0) + COALESCE(s.bonus_festival, 0) 
    + COALESCE(s.bonus_performance, 0) + COALESCE(s.bonus_other, 0) AS month_bonus,
  s.deduct_supplementary_health AS supplementary,
  CASE
    WHEN yb.total_ytd_bonus <= s.insured_salary_health_snapshot * 4 THEN '未跨越門檻'
    ELSE '已跨越、應扣補充保費'
  END AS status
FROM salary_records s
JOIN employees e ON e.id = s.employee_id
JOIN ytd_bonus yb ON yb.employee_id = s.employee_id
WHERE s.year = 2026 AND s.month = 5
  AND yb.total_ytd_bonus > 0
ORDER BY yb.total_ytd_bonus DESC;
```

#### E. gross_salary / net_salary 公式對齊

```sql
SELECT 
  employee_id,
  base_salary, attendance_bonus_actual, allowance, extra_allowance,
  overtime_pay_auto + overtime_pay_manual AS overtime_total,
  comp_expiry_payout, holiday_work_pay, settlement_amount,
  bonus_yearend + bonus_festival + bonus_performance + bonus_other AS bonus_total,
  gross_salary,
  -- 手動驗算
  base_salary + attendance_bonus_actual + allowance + extra_allowance
    + overtime_pay_auto + overtime_pay_manual + comp_expiry_payout
    + holiday_work_pay + settlement_amount
    + bonus_yearend + bonus_festival + bonus_performance + bonus_other AS manual_gross,
  CASE 
    WHEN gross_salary = (base_salary + attendance_bonus_actual + allowance + extra_allowance
      + overtime_pay_auto + overtime_pay_manual + comp_expiry_payout
      + holiday_work_pay + settlement_amount
      + bonus_yearend + bonus_festival + bonus_performance + bonus_other) 
    THEN '✅' ELSE '❌' END AS check
FROM salary_records
WHERE year = 2026 AND month = 5
ORDER BY employee_id LIMIT 10;
```

✅ 全部 `check = ✅`

### 5.4 異常數字判斷準則

| 異常 | 可能原因 | 處置 |
|---|---|---|
| 員工數比預期少 | 該員工沒投保 / 已離職 / 完全沒打卡 | 查 5.1.A、補資料、重跑 |
| 應發合計過低 | base_salary 沒設、attendance_bonus 沒算 | 查 employees / 重跑 |
| 雇主成本占比 < 14% | pension_wage = 0 / labor_ins_bracket 沒設 | Backfill insurance_settings、重跑 |
| 雇主成本占比 > 24% | brackets 設定錯、行業職災率設定異常 | 查 insurance_settings 跟 brackets |
| `deduct_tax > 0` 但月薪 < 88,500 | calculator 算錯 / HR 手動鎖定錯誤 | 查 deduct_tax_manual_override |
| `deduct_pension_voluntary > 0` 但員工沒簽自願 | insurance_settings 設定錯 | 改 pension_voluntary_rate = 0、重跑 |
| `employer_cost_pension = 0` 且 has_insurance=true | pension_wage 沒設 | Backfill、重跑 |
| 補充保費突然很高 | 累計獎金跨門檻、合理 | 對照 5.3.D 確認 |

### 5.5 驗證結果記錄

建議 HR 在每次月結後填一份簡單的驗證紀錄:

```
==== 2026-05 月結驗證紀錄 ====
驗證日期:2026-05-31
驗證者:[HR 姓名]

5.1 整體 sanity check:
  - 員工數:31 / 預期 31  ✅
  - 應發合計:1,085,234  合理 ✅
  - 雇主成本占比:18.3%  合理範圍 ✅

5.2 個別員工抽查（5 種情境）:
  - 情境 A（EMP_xxx 月薪 30,000 滿勤）:✅
  - 情境 B（EMP_xxx 加班）:✅
  - 情境 C（EMP_xxx 月薪 95,000 課稅）:✅
  - 情境 D（EMP_xxx 自願 6%）:✅
  - 情境 E（EMP_xxx 獎金 + 補充保費）:✅

5.3 SQL 詳細驗證:
  - A 高薪扣稅:✅
  - B 雇主勞退 6%:✅
  - C 自願勞退:✅
  - D 補充保費:✅
  - E 公式對齊:✅

5.4 異常:無

可進入老闆審核階段:✅
```

存檔備查、Excel 或 docs 都行。

---

## 6. 老闆審核

### 6.1 老闆登入後操作

CEO / 董事長登入後:

1. 開 `/dashboard.html`
2. 看「本月薪資期間」widget、進度條停在「**待審核**」
3. 點「管理期間 →」進 salary-period.html
4. 點 row → 「詳細」
5. 看完整資訊（員工數、應發、實發、雇主成本、最後計算時間）
6. 若想看細節、開 salary.html 抽查（同 5.2）
7. 確認 OK → 點「**核准**」按鈕
8. row status 自動變「**已核准**」

### 6.2 退回計算的時機

⚠️ 老闆 / 董事長退回時、**必須填退回原因**(會記錄在 period.note)。

退回的常見情況:
- 發現某員工算錯（HR 漏標 deduct_tax_manual_override）
- 該月有員工資料異動還沒同步
- 某員工的獎金沒入帳

退回後:
- status 變 `calculating`
- HR 修正資料 → 重新跑試算 → 走流程到 `pending_review`

---

## 7. 標記發放

### 7.1 確認薪資已實際匯款

⚠️ 「**標記已發放**」是流程節點、不會自動匯款。HR 應該在實際匯款 / 給員工現金後才標記。

匯款管道（依公司情況）:
- 銀行薪資匯款（最常見）
- ATM 轉帳
- 現金（小公司）

### 7.2 標記 paid

1. salary-period.html 點 row → 詳細
2. 確認狀態是「**已核准**」
3. 點「**標記已發放**」按鈕
4. row status 變「**已發放**」、`paid_at` 寫入

### 7.3 開立扣繳憑單（年底）

⚠️ 本系統階段 4 完成、未含「年度扣繳憑單匯出」功能（規劃在後續階段）。

當前作法:
- HR 自行從 SQL 撈年度資料、匯入會計系統處理
- 或外部薪資系統（例如政府勞保網站）

```sql
-- 年度扣繳憑單原始資料
SELECT 
  employee_id,
  SUM(gross_salary) AS yearly_gross,
  SUM(deduct_tax) AS yearly_tax_withholding,
  SUM(deduct_pension_voluntary) AS yearly_pension_voluntary
FROM salary_records
WHERE year = 2026 AND status IN ('paid', 'locked')
GROUP BY employee_id;
```

---

## 8. 期間鎖定

### 8.1 月底自動鎖定

⚠️ 本系統階段 4 完成、**未含 cron 自動鎖定**（規劃在階段 5）。

當前作法:由 admin 手動鎖定。

### 8.2 手動鎖定

1. salary-period.html 點 row（status='已發放'）
2. 點「**鎖定**」按鈕（僅 admin 角色看得到）
3. row status 變「**已鎖定**」、`locked_at` 寫入

⚠️ **鎖定是不可逆操作**。鎖定後即使 admin 也無法在 UI 上修改、必須直接動 DB（極少發生）。

---

## 9. 員工申訴與修改

### 9.1 申訴期間

公司應規定明確的申訴期間（建議實發後 7 日內）。

### 9.2 修改流程（status 在 paid 之前）

#### A. 期間還在 pending_review / approved / paid（未鎖定）

HR 可以:
1. 退回到 calculating（pending_review HR 可退、approved 限老闆退）
2. 修改員工的 _manual 欄位（在 salary.html 編輯）
3. 重新跑試算
4. 走流程到 paid

#### B. 期間已 paid 但未 locked

如果是個別員工的問題:
1. salary.html 找到該員工 row → 編輯
2. 直接改 _manual 欄位
3. _auto 欄位（gross_salary / net_salary 等）GENERATED 自動更新

⚠️ 改 _manual 欄位後、**period 統計 cache 會過期**。可以重跑 batch_v2 或手動 reconcile。

#### C. 期間已 locked

僅 admin 能透過 SQL 直接改、且必須記錄完整 audit。

### 9.3 員工要求看薪資單

員工自己看 `/employee-salary.html` → 點月份 row 的「🖨 列印薪資單」→ 開啟 `/payslip.html` → ctrl+P 存 PDF / 列印。

HR 也能透過 `/salary.html` 點任何員工 row 的「🖨」按鈕、打開該員工的薪資單給員工看 / 寄 PDF。

---

## 10. 排錯指南

### 10.1 試算超時

**症狀**:點「跑試算」、等 60+ 秒沒反應、F12 Network 看到 fetch (pending) 卡住。

**可能原因**:
1. Vercel function timeout（Hobby 10s / Pro 60s）— 員工太多 / DB query 慢
2. calculator 在某員工卡住（例如某 lib 報錯）
3. DB 連線異常

**處置**:
1. 重新整理頁面、等 30 秒再試
2. 看 Vercel Dashboard logs（Functions → batch_v2）找錯誤
3. 拆批跑（不建議、改進空間）

### 10.2 員工沒有 row

**症狀**:salary.html 該月份缺某員工的 row。

**可能原因**:
1. 員工 status='resigned' 且 resigned_at < 該月份 1 日
2. 員工 has_insurance=false 且 base_salary=0
3. calculator 跑到該員工時 throw 錯誤

**處置**:
- 查員工 status / resigned_at
- 若是該員工該月份應該有薪資、單獨重跑該員工 batch_v2（系統有支援）
- 看 Vercel logs 找錯誤訊息

### 10.3 deduct_tax 算錯

**症狀**:HR 預期 deduct_tax = X、實際 = Y。

**檢查**:

```sql
SELECT 
  employee_id, base_salary, gross_salary,
  taxable_income_snapshot,
  deduct_pension_voluntary,
  deduct_tax,
  deduct_tax_manual_override
FROM salary_records
WHERE employee_id = 'EMP_xxx' AND year = 2026 AND month = 5;
```

**判斷**:
- `deduct_tax_manual_override = true` → HR 手動鎖定、calculator 不會自動算
- `taxable_income_snapshot < 88,500` → 免稅、deduct_tax 應 = 0
- `taxable_income_snapshot > 88,500` → 應扣 (taxable - 88,500) × 6%
- 扶養人數從 `insurance_settings.health_ins_dependents` 讀

**修法**:
- 若 lock 但要解鎖 → 編輯員工 row、取消「鎖定 deduct_tax」checkbox、重跑
- 若課稅基礎不對 → 檢查 insurance_settings.pension_voluntary_rate 等

### 10.4 employer_cost_pension = 0

**症狀**:某員工 has_insurance=true 但 employer_cost_pension = 0。

**根因**:`insurance_settings.pension_wage` 沒設或 = 0。

**修法（單筆）**:

```sql
-- 查該員工 pension_wage
SELECT employee_id, labor_ins_bracket, pension_wage 
FROM insurance_settings 
WHERE employee_id = 'EMP_xxx';

-- 若 pension_wage = 0、補值
UPDATE insurance_settings
SET pension_wage = labor_ins_bracket
WHERE employee_id = 'EMP_xxx';
```

然後重跑該月份 batch。

⚠️ Calculator 階段 2.7 加了 fallback、若 pension_wage = 0 會 fallback 到 labor_ins_bracket、所以新版 calculator 不會踩這個坑。但 insurance_settings.pension_wage 還是建議補上、保持資料完整。

### 10.5 二代健保補充保費算錯

**症狀**:HR 預期某員工要扣補充保費、實際沒扣。

**檢查**:

```sql
-- ytd 累計獎金 + 投保金額
WITH ytd AS (
  SELECT 
    employee_id,
    SUM(COALESCE(bonus_yearend,0)+COALESCE(bonus_festival,0)
      +COALESCE(bonus_performance,0)+COALESCE(bonus_other,0)) AS ytd_bonus
  FROM salary_records WHERE year=2026 AND month <= 5
  GROUP BY employee_id
)
SELECT 
  s.employee_id,
  s.insured_salary_health_snapshot * 4 AS threshold,
  ytd.ytd_bonus,
  s.deduct_supplementary_health
FROM salary_records s
JOIN ytd ON ytd.employee_id = s.employee_id
WHERE s.employee_id = 'EMP_xxx' AND s.year = 2026 AND s.month = 5;
```

**判斷**:
- `ytd_bonus < threshold` → 未跨越門檻、不扣補充保費（合理）
- `ytd_bonus > threshold` 但 `deduct_supplementary_health = 0` → calculator 算錯

### 10.6 _manual 欄位被覆蓋

**症狀**:HR 之前改的 deduct_labor_ins / deduct_health_ins / 等 _manual 欄位、重跑後變回 0。

**根因**:HR 該欄位設定後、insurance_settings 的對應值改變、calculator 重算覆蓋。

**檢查**:
- 從 employee_change_logs 看是否有人改 insurance_settings
- 看 calculator.js Step 10 的 row payload _manual 處理

**修法**:
- 修 insurance_settings.labor_ins_employee 等到正確值
- 重跑

### 10.7 dashboard widget 顯示「期間尚未建立」

**症狀**:dashboard 看到「2026-05 期間尚未建立」。

**處置**:
- 點「前往建立期間」連結 → 跳到 salary-period.html
- 點「+ 開新期間」建立

---

## Appendix A:薪資計算公式 reference

### A.1 應發合計（gross_salary、GENERATED column）

```
gross_salary =
    base_salary
  + attendance_bonus_actual
  + allowance
  + extra_allowance
  + (overtime_pay_auto + overtime_pay_manual)
  + comp_expiry_payout
  + holiday_work_pay
  + settlement_amount
  + bonus_yearend
  + bonus_festival
  + bonus_performance
  + bonus_other
```

### A.2 實發合計（net_salary、GENERATED column）

```
net_salary = gross_salary
  - deduct_absence
  - deduct_labor_ins
  - deduct_health_ins
  - deduct_tax
  - attendance_penalty_total
  - deduct_pension_voluntary
  - deduct_supplementary_health
  - deduct_welfare_fund
  - deduct_union_fee
  - deduct_court_garnishment
  - deduct_loan_repayment
  - deduct_other
```

### A.3 所得稅扣繳（公式法、薪資所得扣繳辦法 §8）

```
totalAllowance = 88,500 + 扶養人數 × 88,500
taxable = max(0, gross_pre_tax - 自願勞退提繳)
deduct_tax = max(0, (taxable - totalAllowance) × 6%)
```

⚠️ 法規數字（88,500 / 6%）每年可能調整、見財政部公告。

### A.4 二代健保補充保費（健保法 §31）

```
threshold = insured_salary_health × 4
ytdAfter = ytdAccumulatedBonusBefore + monthlyBonus

if ytdAfter <= threshold:
    chargeable = 0
elif ytdAccumulatedBonusBefore < threshold:
    chargeable = ytdAfter - threshold  // 跨越部分
else:
    chargeable = monthlyBonus  // 整筆扣

deduct_supplementary_health = min(chargeable, 1,000,000) × 2.11%
```

### A.5 員工自願勞退（勞退條例 §14）

```
deduct_pension_voluntary = pension_wage × voluntary_rate / 100

(0 ≤ voluntary_rate ≤ 6、員工自選)
```

### A.6 雇主強制勞退（勞退條例 §14）

```
employer_cost_pension = pension_wage × 6%

(法定強制率、不可少於 6%)
```

### A.7 雇主勞健保（從 brackets 表取）

```
employer_cost_labor  = insurance_settings.labor_ins_company  -- direct premium
employer_cost_health = insurance_settings.health_ins_company -- direct premium

(brackets 表已預先算好雇主負擔額)
```

---

## Appendix B:SQL 檢驗 query 集

### B.1 月結期間整體 sanity

```sql
SELECT 
  id,
  status,
  employee_count,
  gross_total,
  net_total,
  employer_cost_total,
  ROUND(employer_cost_total / NULLIF(gross_total, 0) * 100, 1) AS employer_pct,
  calculated_at,
  approved_at,
  paid_at
FROM payroll_periods
WHERE year = 2026 AND month = 5;
```

### B.2 該月份所有員工總覽

```sql
SELECT 
  s.employee_id,
  e.name,
  s.base_salary,
  s.gross_salary,
  s.net_salary,
  s.deduct_tax,
  s.deduct_pension_voluntary,
  s.deduct_supplementary_health,
  s.employer_cost_labor,
  s.employer_cost_health,
  s.employer_cost_pension,
  s.payroll_period_id,
  s.status,
  s.calculated_at
FROM salary_records s
JOIN employees e ON e.id = s.employee_id
WHERE s.year = 2026 AND s.month = 5
ORDER BY s.employee_id;
```

### B.3 找出可能有問題的 row

```sql
-- 多種異常條件一次查
SELECT 
  s.employee_id,
  e.name,
  e.status AS emp_status,
  s.base_salary,
  s.gross_salary,
  s.deduct_tax,
  s.deduct_tax_manual_override,
  s.employer_cost_pension,
  s.pension_wage_snapshot,
  CASE
    WHEN s.gross_salary < s.base_salary THEN '⚠️ gross < base'
    WHEN s.net_salary < 0 THEN '❌ net < 0、扣項過大'
    WHEN s.taxable_income_snapshot > 88500 AND s.deduct_tax = 0 
         AND NOT s.deduct_tax_manual_override THEN '⚠️ 應扣稅但 = 0'
    WHEN s.pension_wage_snapshot > 0 AND s.employer_cost_pension = 0 THEN '⚠️ 雇主勞退 = 0'
    WHEN e.status = 'resigned' AND s.gross_salary > 0 THEN 'ℹ️ 離職員工有薪資'
    ELSE '✅'
  END AS check
FROM salary_records s
JOIN employees e ON e.id = s.employee_id
WHERE s.year = 2026 AND s.month = 5
ORDER BY check DESC, s.employee_id;
```

### B.4 公式自我驗算（gross / net）

```sql
SELECT 
  employee_id,
  gross_salary,
  base_salary + COALESCE(attendance_bonus_actual,0) + COALESCE(allowance,0)
    + COALESCE(extra_allowance,0) + COALESCE(overtime_pay_auto,0) + COALESCE(overtime_pay_manual,0)
    + COALESCE(comp_expiry_payout,0) + COALESCE(holiday_work_pay,0) + COALESCE(settlement_amount,0)
    + COALESCE(bonus_yearend,0) + COALESCE(bonus_festival,0)
    + COALESCE(bonus_performance,0) + COALESCE(bonus_other,0) AS manual_gross,
  net_salary,
  gross_salary
    - COALESCE(deduct_absence,0) - COALESCE(deduct_labor_ins,0) - COALESCE(deduct_health_ins,0)
    - COALESCE(deduct_tax,0) - COALESCE(attendance_penalty_total,0)
    - COALESCE(deduct_pension_voluntary,0) - COALESCE(deduct_supplementary_health,0)
    - COALESCE(deduct_welfare_fund,0) - COALESCE(deduct_union_fee,0)
    - COALESCE(deduct_court_garnishment,0) - COALESCE(deduct_loan_repayment,0)
    - COALESCE(deduct_other,0) AS manual_net
FROM salary_records
WHERE year = 2026 AND month = 5
LIMIT 5;

-- gross_salary 應該 = manual_gross
-- net_salary 應該 = manual_net
```

### B.5 雇主成本 break-down

```sql
SELECT 
  s.employee_id,
  s.gross_salary,
  s.employer_cost_labor,
  s.employer_cost_health,
  s.employer_cost_pension,
  s.employer_cost_occupational,
  s.employer_cost_employment,
  s.employer_cost_welfare,
  (s.employer_cost_labor + s.employer_cost_health + s.employer_cost_pension
   + s.employer_cost_occupational + s.employer_cost_employment + s.employer_cost_welfare) AS total,
  ROUND(
    (s.employer_cost_labor + s.employer_cost_health + s.employer_cost_pension
     + s.employer_cost_occupational + s.employer_cost_employment + s.employer_cost_welfare)
     / NULLIF(s.gross_salary, 0) * 100, 1) AS pct
FROM salary_records s
WHERE s.year = 2026 AND s.month = 5
ORDER BY s.employee_id;
```

### B.6 audit 完整性

```sql
-- 該月份所有 row 應該有 calculated_by / calculated_at / payroll_period_id
SELECT 
  COUNT(*) AS total,
  COUNT(calculated_by) AS with_calc_by,
  COUNT(calculated_at) AS with_calc_at,
  COUNT(payroll_period_id) AS with_period_id
FROM salary_records
WHERE year = 2026 AND month = 5;

-- expect: total = with_calc_by = with_calc_at = with_period_id
```

### B.7 投保資料完整性（前置作業檢查）

```sql
-- has_insurance=true 員工的 insurance_settings 是否完整
SELECT 
  e.id, e.name, e.status,
  CASE WHEN i.id IS NULL THEN '❌ 無 insurance row' ELSE '✅' END AS row_check,
  i.labor_ins_bracket,
  i.health_ins_bracket,
  i.pension_wage,
  i.pension_voluntary_rate,
  CASE
    WHEN i.id IS NULL THEN '❌'
    WHEN i.labor_ins_bracket IS NULL OR i.labor_ins_bracket = 0 THEN '❌ 缺勞保'
    WHEN i.health_ins_bracket IS NULL OR i.health_ins_bracket = 0 THEN '❌ 缺健保'
    WHEN i.pension_wage IS NULL OR i.pension_wage = 0 THEN '⚠️ 缺月提繳工資'
    ELSE '✅'
  END AS data_check
FROM employees e
LEFT JOIN insurance_settings i ON i.employee_id = e.id
WHERE e.status = 'active' AND COALESCE(e.has_insurance, true) = true
ORDER BY data_check, e.id;
```

---

## Appendix C:名詞定義

| 名詞 | 定義 |
|---|---|
| _auto 欄位 | 由 calculator 自動算出、每次重跑被覆蓋 |
| _manual 欄位 | 由 HR 手動填、重跑時保留既有值（不被覆蓋） |
| Override flag | `deduct_tax_manual_override` 之類的 boolean flag、true 時把對應 _auto 欄位視為 _manual 不被覆蓋 |
| GENERATED column | `gross_salary` / `net_salary`、由 DB 自動算、無法手動寫 |
| Snapshot 欄位 | `taxable_income_snapshot` / `pension_wage_snapshot` 等、計算當下的時點值、防月中異動造成查表錯 |
| 投保金額 | `labor_ins_bracket` / `health_ins_bracket`、依勞保 / 健保級距表查、決定保費基數 |
| 月提繳工資 | `pension_wage`、依勞退月提繳工資分級表查、決定勞退提繳基數 |
| 雇主成本 | `employer_cost_*`、雇主負擔的 6 項成本（影子計算、不從員工薪資扣）|
| 補充保費 | 二代健保補充保費、高額獎金累計超過投保 4 倍時扣 2.11% |
| 自願提繳 | 員工自願在 0~6% 間提撥薪資到勞退個人帳戶、免稅 |
| YTD | Year-to-date、年初到目前累計值（用於補充保費門檻判斷） |

---

## 修改記錄

| 日期 | 版本 | 修改 |
|---|---|---|
| 2026-05-10 | v1.0 | 初版、對應 hr-system-v2 階段 0+1+2+3+4 完成 |

---

> 文件位置:`docs/hr-payroll-sop.md`  
> 維護:HR + 工程協作  
> 任何 prod 異常請優先參考第 10 節排錯指南、若指南未涵蓋、請聯繫工程協助。

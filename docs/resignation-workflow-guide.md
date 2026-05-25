# 離職流程操作手冊

對應系統:CHUWA HR System
適用對象:員工 / 主管 / CEO / HR / 老闆兼 HR
更新日期:2026-05-26

本手冊涵蓋從員工送出離職申請到最後月薪發放的完整流程,含系統自動處理範圍 / HR 後續手動事項 / 法定義務時間軸 / 故障排除。柯郁含案(EMP_01251101)作為實際範例貫穿全文。

---

# 1. 員工視角

## 1.1 送出離職申請

1. 登入 HR 系統、進 `/approvals.html`
2. 點「📝 新申請」→ 申請類型選「離職申請」
3. 填表單三個欄位:

| 欄位 | 內容 | 法定提醒 |
|---|---|---|
| **預計離職日**(resign_date) | 真正生效日期(可未來日) | 預告期:年資 3-12 月 → 10 日 / 1-3 年 → 20 日 / >3 年 → 30 日(《勞基法 §16》、自願離職也建議遵守) |
| **離職原因**(reason) | 簡述、自願 / 非自願 | 非自願(資遣)由公司開立離職證明書、用於勞保失業給付 |
| **交接事項說明**(handover) | 列點寫清楚進行中專案 / 客戶 / 文件位置 | HR 後續核對交接清單依此驗證 |

4. 送出後流程:**直屬主管 → CEO → HR** 依序簽核

## 1.2 預計離職日前後的登入行為

- **離職日前**:仍可正常登入、繼續打卡 / 申請假單 / 看薪資
- **離職日當天 00:00 起**:系統 login 自動擋下、顯示「此帳號已停用、請聯絡管理員」
- 若有疑問需要查資料:聯絡 HR、由 HR 走員工檔案頁查

## 1.3 取消申請

- `status='pending'` 期間(直屬主管尚未簽)可在 `/approvals.html`「我的申請」tab 點「取消申請」
- 已 step 1 approved 後就不能取消,需聯繫主管駁回 / HR 進階編輯

---

# 2. Manager 視角

## 2.1 收到通知

- Push notification:「📋 有新的審批待辦」
- Dashboard「待我審批」widget 顯示 pending 數字
- 點進去到 `/approvals.html` → 「待我審批」tab

## 2.2 審核重點

1. **離職日合理性**:看 form_data.resign_date、是否符合勞基法預告期(看員工 hire_date 計算年資)
2. **交接事項是否完整**:form_data.handover 是否列點清楚、有無未交接的關鍵客戶 / 專案
3. **未結算事項預警**:
   - 員工特休未休 → 提醒員工是否有需要先消化
   - 加班費未發 → 確認 overtime_requests 已 settle
   - 補休餘額 → 提醒員工是否需先消化

## 2.3 操作

- **通過**:點「✓ 審批通過」、可選填 note
- **駁回**:點「✗ 退回」、**必填 reject_reason**(說明原因給員工看)

## 2.4 特殊狀況:sole-manager dept

當你是部門裡唯一的 manager、自己也送離職申請時:

- 系統建立申請時自動偵測「該 dept 無其他 active manager」
- step 1 自動標 `status='skipped'`、`note='B12: auto-skipped (sole manager in dept)'`
- 流程直接從 step 2 CEO 開始
- 你不會在「待我審批」看到自己送的申請(已被 skip)

這是合法的「無法自己審自己」設計、勞檢可解釋。

---

# 3. CEO 視角

## 3.1 step 2 審批

1. 收 push notification、進 `/approvals.html` → 「待我審批」tab
2. 確認直屬主管已簽 step 1(或 sole-manager dept 已 skipped)
3. 看完整申請內容 → 通過 / 駁回
4. 通過後流程進入 step 3 HR

## 3.2 公司無獨立 HR 時(中小企業老闆兼 HR)

系統設計允許 CEO/chairman 兼簽 HR step 3:

- 「待我審批」tab 同時顯示 step 2(ceo)+ step 3(hr)pending
- 點 step 3 簽核時、系統自動加 audit note 後綴「[CEO 代簽 HR step(公司無獨立 HR)]」
- 跨 step 同人連簽防呆 guard 對此場景**放寬**(否則 CEO 簽完 step 2 又簽 step 3 會被擋)

---

# 4. HR 視角(含 CEO 兼 HR)

最複雜的角色。本章節最詳細。

## 4.1 簽核 step 3 前確認

- **員工資料卡**:basic info 看一遍、有無錯誤
- **form_data**:resign_date / reason / handover 三欄位完整
- **步驟 1 + 2 已通過**:看 approval_steps 都 status='approved'(或 step 1 skipped)
- **附件**:若員工有上傳辭呈 / 證明文件

## 4.2 簽核完成後 cascade 自動處理(7 段)

按下「✓ 審批通過」step 3 後,系統按序自動執行 7 件事。每段 best-effort(失敗不擋下一段),audit 在 Vercel function logs 可查:

| # | 動作 | 結果 |
|---|---|---|
| 1 | UPDATE `employees` | `status='resigned'` / `resigned_at=resign_date+08:00` / `resigned_reason` 寫入 |
| 2 | DELETE `push_subscriptions` | 該員工所有推播訂閱清掉(隱私 + 推播成本) |
| 3 | INSERT `resignation_checklists` + 46 個 items | 6 個系統自動完成、40 個 HR 手動勾 |
| 4 | `sendPushToRoles(['hr','admin'])` | HR 收推播「✅ 員工離職核准、請啟動離職檢核表」、含 deep-link |
| 5 | UPDATE `annual_leave_records` 全 active → paid_out | 計算 `settlement_amount = remaining × (base/30)`(§38) |
| 6 | UPDATE `comp_time_balance` 全 active → expired_paid | 計算 `expiry_payout_amount = remaining × hourly × 1.34`(平日加班預設) |
| 7 | UPDATE / INSERT `salary_records` 該月 draft | 標 `is_final_month=true` + worked_days + total_days_in_month + pro_rata_mode='calendar_day' |

cascade 跑完、HR 收到推播、點進 `/resignation-checklist.html?employee_id=X` 看 46 項。

## 4.3 HR 後續手動處理(46 項 checklist)

進 `/resignation-checklist.html?employee_id=X` 看 46 項分 8 大類。6 個系統自動完成項 cascade 已標 done、剩 40 項 HR 逐項勾選。

### 1. HR 行政(9 項、seq 1-9)

| Seq | 項目 | 法源 / 截止 |
|---|---|---|
| 1 | 勞保退保 | 《勞保條例 §11》、離職起 5 日內 |
| 2 | 健保退保 | 《健保法 §15》、離職起 3 日內 |
| 3 | 勞退提繳停止 | 《勞退條例 §7》 |
| 4 | 就業保險退保 | 《就保法 §5》 |
| 5 | 服務證明書 | 《勞基法 §19》、員工要求時提供 |
| 6 | 離職證明書 | 用於失業給付申請、非自願才需 |
| 7 | 所得稅扣繳憑單 | 次年 1/31 前統一發放 |
| 8 | 健保眷屬轉出 | 若有眷屬掛保;無眷屬標 n/a |
| 9 | 其他法定文件補充 | 視個案 |

**操作建議**:勞保 / 健保 / 勞退 / 就保(seq 1-4)走「勞保局 e-政府」+「健保署網申」官網辦,可一次性辦完。

### 2. 薪資結算(6 項、seq 10-15、最重要)

| Seq | 項目 | 操作 |
|---|---|---|
| 10 | 最後月薪 pro-rata | **看「2.1 重 calculate SOP」**(下方詳細展開) |
| 11 | 加班費結算 | 看 overtime_requests 已 approved 但未付的、確認 settle |
| 12 | 特休未休折現 | cascade 自動算進 `salary_records.settlement_amount`、不需手動 |
| 13 | 補休餘額折現 | cascade 自動算進 `comp_expiry_payout`、不需手動 |
| 14 | 獎金 / 績效金 pro-rata | HR 在 salary.html 詳情頁手動填 `bonus_yearend` / `_performance` 欄位 |
| 15 | 預發薪資 / 借支扣回 | HR 手動填 `deduct_other` 欄位、note 寫明原因 |

#### 2.1 重 calculate SOP(關鍵流程)

員工離職後、cascade 已標 `is_final_month=true`、但 calculator 不會自動跑 — HR 必須主動觸發:

1. 進 `/salary.html`、切到員工離職月份(例柯郁含案:2026 / 5)
2. 找該員工 row、應顯示**紅色「✦ 離職月」pill** + 員工編號下方
3. 點 row「編輯」開啟 modal、看「✦ 離職月 Pro-rata 結算」紅框 section:
   - 在職曆日:**X / Y** 日(calendar_day mode)
   - 原月薪:$XX,XXX
   - Pro-rata 月薪:**(初次)$—** ← 因 calculator 還沒跑、`prorata_base` 是 NULL
4. 關閉 modal、點頁面「批次重算」按鈕(觸發 `POST /api/salary?v=2&year=YYYY&month=MM`)
5. 等 alert「處理 N 員工、成功 N 失敗 0」(離職員工會被一起撈到)
6. **重新**點該 row「編輯」、看 Pro-rata section 數字都填上:
   - Pro-rata 月薪:$XX,XXX = base × worked/total
   - §38 結算日薪:$XXX = base / 30
   - 特休未休折現 / 補休餘額折現
7. 驗 deduct_labor_ins / _health_ins / employer_cost_xxx 都已按比例縮減(看「自動」欄位)
8. 確認 gross / net 合理
9. 標 `status='pending_review'` → `'confirmed'` → `'paid'`(走 salary 既有 state machine)

### 3. 系統權限撤銷(9 項、seq 16-24)

| Seq | 項目 | 自動 / 手動 |
|---|---|---|
| 16 | HR 系統 status='resigned' | 系統自動(cascade #1) |
| 17 | HR 系統 login 擋下 | 系統自動(LoginCheck.shouldBlockResignedLogin) |
| 18 | Supabase Auth 帳號停用 | 手動 supabase dashboard(後台 → Authentication → 找該用戶 → Delete) |
| 19 | 公司 email 帳號停用 | Google Workspace / O365 後台 |
| 20 | Slack/Notion/SaaS 撤銷 | 各 SaaS 後台 |
| 21 | VPN / 內網存取撤銷 | IT 部門 |
| 22 | 共享雲端硬碟所有權轉移 | Drive / OneDrive 後台 |
| 23 | Push subscription 清除 | 系統自動(cascade #2) |
| 24 | GitHub/GitLab 撤銷 | 如適用 |

### 4. 排班 / 出勤 / 假勤(5 項、seq 25-29)

| Seq | 項目 |
|---|---|
| 25 | 離職日後排班刪除 |
| 26 | 離職日後 absent 紀錄清除(若 auto-absent cron 跑過) |
| 27 | 未審完 leave_requests 取消 |
| 28 | 未審完 approval_requests 取消(非 resignation) |
| 29 | 未審完 overtime_requests 取消 |

**目前手動 SQL DELETE**(系統暫無自動清:離職月後排班 cron 沒擋)。SQL 範例:

```sql
DELETE FROM schedules
WHERE employee_id = 'EMP_X' AND work_date > 'YYYY-MM-DD'  -- resigned_at 那天
  AND status IN ('draft', 'confirmed');
```

### 5. 組織關係(2 項、seq 30-31)

| Seq | 項目 |
|---|---|
| 30 | 若是部門 manager → 部門 manager_id 轉移 / NULL |
| 31 | 若有下屬 → 下屬 manager_id 轉移 |

查詢 SQL:

```sql
-- 該員工是否為任何部門主管
SELECT id, name FROM departments WHERE manager_id = 'EMP_X';

-- 是否有員工以該員工為直屬主管
SELECT id, name FROM employees WHERE manager_id = 'EMP_X' AND status = 'active';
```

### 6. 實體資產回收(7 項、seq 32-38)

電腦 / 筆電歸還 / 手機 / 平板 / 門禁卡 / 識別證 / 辦公室鑰匙 / 印章 / 大小章 / 公務手機 SIM / 制服 / 員工專屬物品。

### 7. 工作交接(4 項、seq 39-42)

| Seq | 項目 |
|---|---|
| 39 | 交接清單確認(form_data.handover 已填) |
| 40 | 客戶 / 廠商聯絡轉交 |
| 41 | 進行中專案 / 任務轉交 |
| 42 | 離職面談(exit interview) |

### 8. 通知 / Audit(4 項、seq 43-46)

| Seq | 項目 | 自動 / 手動 |
|---|---|---|
| 43 | HR 收到 cascade 通知 | 系統自動(cascade #4) |
| 44 | 直屬主管通知 | 系統自動(approval flow 推播) |
| 45 | 同部門同事知悉 | 手動發 Slack 或 dept 公告 |
| 46 | 離職原因記錄 + 統計 | 系統自動(employees.resigned_reason 已寫) |

## 4.4 柯郁含案實際 walk-through

**員工資料**:
- ID:EMP_01251101 / 姓名:柯郁含 / 部門:倉儲後勤部(D1777368423626)
- 離職日:2026-05-13(自願)
- base_salary:30,000

**cascade 自動處理(step 3 HR approve 完當下)**:
- `employees.status='resigned'`、`resigned_at='2026-05-12T16:00:00Z'`(= 5/13 台北 00:00)
- annual_leave Record 73(2026-05-03 ~ 11-02、active):→ paid_out、remaining=0、settlement=0
- comp_time Record 54(8h、未過期):→ expired_paid、`payout = 8 × 125 × 1.34 = 1,340`
- salary_records `S_EMP_01251101_2026_05` draft:`is_final_month=true / worked_days=13 / total_days_in_month=31 / pro_rata_mode='calendar_day'`

**HR 觸發重 calculate 後**:

| 欄位 | 值 | 公式 |
|---|---|---|
| `prorata_base` | 12,580.65 | 30000 × 13/31 |
| `daily_wage_settlement` | 1,000.00 | 30000 / 30 |
| `settlement_amount` | 0 | Record 73 remaining=0 |
| `comp_expiry_payout` | 1,340 | cascade #5 寫入 |
| `deduct_labor_ins` | 251 | round(599 × 13/31) |
| `deduct_health_ins` | 210 | round(500 × 13/31) |
| `employer_cost_labor` | 879 | round(2100 × 13/31) |
| `employer_cost_health` | 419 | round(1000 × 13/31) |
| `gross_salary`(GENERATED) | 14,738.39 | COALESCE(prorata_base, base) + 所有 income |
| `net_salary`(GENERATED) | 14,277.39 | gross - 所有 deduction(已 pro-rata) |

**柯郁含 5 月實領** = **NT$ 14,277**。

---

# 5. 法定義務時間軸

從離職日 D 起算(對柯郁含案:D = 2026-05-13):

| 時點 | 動作 | 法源 |
|---|---|---|
| **D+0** | 離職生效。系統 login 擋下。**HR 手動清離職後排班**(系統不自動) | — |
| **D+3** | 健保退保(網申或紙本) | 《全民健康保險法 §16》 |
| **D+5** | 勞保退保 + 勞退提繳停止 + 就保退保 | 《勞工保險條例 §11》《勞退條例 §7》《就保法 §5》 |
| **D+30 / 月底** | HR 完成離職月薪結算、發 `net_salary` | 《勞基法 §23》(勞工終止勞動契約時應發給工資) |
| **D+90** | 員工檔案歸檔 | 內部 SOP |
| **次年 1/31** | 所得稅扣繳憑單發放 | 《所得稅法 §92》 |

**柯郁含案具體期限**:
- 健保退保:**2026-05-16 前**
- 勞保 / 勞退 / 就保:**2026-05-18 前**
- 5 月薪資結算發放:**2026-05 月底 / 6 月初**
- 扣繳憑單:**2027-01-31 前**

---

# 6. 系統設計原理

給未來 dev / HR 維護人員理解設計意圖。

## 6.1 Cascade 7 段

- **觸發點**:HR(或 CEO 兼)簽 approval step 3 完成那一刻
- **執行順序**:固定上述 1-7 順序、不可重排
- **Idempotent guard**:第一段「fetch employees」就會 check 若 `status='resigned'` 直接 return,避免重複 cascade
- **Best-effort try/catch**:每段獨立 try/catch,任一段失敗只 console.error、不擋下一段
- **失敗修補**:看 Vercel function logs 該 `request_id` 對應 `[applyResignation] xxx failed` log、手動補 SQL

## 6.2 Sole-manager dept skip(B12)

- 員工自己是該 dept 唯一 active manager 時、申請建立階段自動偵測
- step 1 status='skipped' / approver_id=NULL / handled_at=NOW / note='B12: auto-skipped (sole manager in dept)'
- 沒人需要簽 step 1、流程直接從 step 2 開始
- audit 留全紀錄、勞檢可解釋

## 6.3 CEO 代簽 HR step(B32)

- `canApproveStep` 對 `step.approver_role='hr'` 分支放寬接受 `['hr', 'ceo', 'chairman']`
- 「待我審批」list:`role='ceo'` 或 `'chairman'` 撈 `step_number IN (2, 3)`(兼簽 HR step)
- 簽核 audit 自動加後綴「[CEO 代簽 HR step(公司無獨立 HR)]」
- 跨 step 同人連簽防呆 guard 對此場景放寬(否則 CEO 簽完 step 2 不能再簽 step 3)

## 6.4 離職月 Pro-rata 結算(B26)

- `pro_rata_mode='calendar_day'`:`base × worked_days / total_days_in_month`(按曆日、勞動局慣例)
- `daily_wage_settlement = base / 30`(《勞基法 §38-Ⅳ》法定特休折現公式)
- 勞健保按投保日數 pro-rata:`× worked / total`(對齊勞保局收據)
- 雇主負擔 6 項全部同步 × ratio
- 員工自願勞退提繳同步 × ratio
- DB GENERATED `gross_salary` / `net_salary` 用 `COALESCE(prorata_base, base_salary)` 自動選對(非離職月 NULL 走 base、離職月走 prorata)

## 6.5 Annual leave 結算

- 《勞基法 §38-Ⅳ》:未休天數 × `(base / 30)`
- cascade Enhancement #5 自動標 `paid_out` + 寫 `settlement_amount`
- HR 不需手動點 `/annual-leave-admin` 結算(以前手動 case 仍 work、但 cascade 後不必要)

## 6.6 Comp time 折現

- 《勞基法 §24》加班費率,平日 1.34(MVP 預設、未來可對齊 `overtime_requests.pay_multiplier`)
- cascade Enhancement #6 自動算 + 標 `expired_paid`
- `expires_at` clamp 到 `resigned_at`(防覆寫未來日)

## 6.7 hourly_rate auto-recalc

- `api/employees/[id].js` PUT handler 偵測 `body.base_salary` 改變時、若前端沒帶 `hourly_rate` 自動算 `base / 240` 寫入
- 防 `hourly_rate=0` init bug 再次發生(2026-05-26 backfill 修了 19 個員工)

## 6.8 Audit log 位置

| 資訊 | 位置 |
|---|---|
| 簽核紀錄(誰、何時、簽哪步) | `approval_requests` + `approval_steps` |
| 離職時間戳 | `employees.resigned_at` |
| 特休 / 補休結算 | `leave_balance_logs`(`change_type='settle'`) |
| Cascade 各段執行 | Vercel Function logs(filter `/api/approvals` + request_id) |
| 員工資料變更 | `employee_change_logs` |
| 檢核表項目進度 | `resignation_checklist_items.completed_at` / `completed_by` |

---

# 7. 故障排除

## 7.1 Cascade 部分失敗

**症狀**:HR 簽完 step 3、approval status='completed' 但 employees 沒變 resigned / annual_leave 沒結算 / checklist 沒建。

**Debug 步驟**:
1. 開 Vercel dashboard → Logs → filter `/api/approvals`
2. 找該 `request_id` 對應的 cascade log,看哪段 `[applyResignation] xxx failed`
3. 依失敗段別手動補:

| 失敗段 | 修補 SQL |
|---|---|
| employees update | `UPDATE employees SET status='resigned', resigned_at=...` |
| push_subscriptions DELETE | `DELETE FROM push_subscriptions WHERE employee_id=...`(失敗不擋、可選) |
| checklist 建立 | `INSERT INTO resignation_checklists ...` + 46 items |
| HR push | 重發或忽略 |
| annual_leave 結算 | `UPDATE annual_leave_records SET status='paid_out', settlement_amount=remaining*base/30 WHERE ...` |
| comp_time 結算 | `UPDATE comp_time_balance SET status='expired_paid', expiry_payout_amount=remaining*hourly*1.34 WHERE ...` |
| salary_records | `UPDATE / INSERT salary_records SET is_final_month=true, worked_days=X, total_days_in_month=Y, pro_rata_mode='calendar_day'` |

## 7.2 重 calculate 出錯

**症狀**:HR 點「批次重算」、alert 顯示某員工失敗、或 `prorata_base` 為 NaN。

**Debug**:
1. F12 Network 看 `POST /api/salary?v=2` response、看哪個 employee_id 失敗
2. 查 Supabase `salary_records WHERE id='S_EMP_X_YYYY_MM'`、確認 4 final-month 欄位都填了
   - `is_final_month=true`、`worked_days` 有值、`total_days_in_month` 有值、`pro_rata_mode` 有值
3. 若 `worked_days=NULL`(cascade #7 沒跑成功)→ 手動 UPDATE 補
4. 若 `insurance_settings` 缺(`has_insurance=false`)→ 確認該員工是否真的不投保;若該投保但 setting 缺、手動補

## 7.3 cascade 跑了第二次

**症狀**:重複 approve 同一張 resignation(不該發生、但極端 case)。

**行為**:
- `applyResignation` 第一個動作就 check `employees.status='resigned'`、直接 return
- 後續 6 段 cascade 都不會跑
- 不會破壞既有資料

**若真要重跑全 cascade**:
1. 不建議(會把已 paid_out 的 annual_leave 跑兩次、雖然第二次撈不到 active 也 noop、但 audit log 會誤導)
2. 真要重跑:`UPDATE employees SET status='active', resigned_at=NULL WHERE id=...` 再重 approve(極端 case、不推薦)
3. 替代:依 7.1 表手動補各段、不重觸發 cascade

## 7.4 settlement / comp 金額不對

**症狀**:特休或補休折現金額跟預期不符。

**Debug**:
1. 確認 cascade #5 / #6 真有跑(Vercel logs 看 `annual_leave settled` / `comp settled`)
2. 確認公式:
   - 特休 = `remaining_days × (base / 30)`
   - 補休 = `remaining_hours × hourly_rate × 1.34`
3. 若 `hourly_rate=0`(init bug)→ 補休會算成 0,需先 backfill 然後重跑

## 7.5 GENERATED gross / net 不對

**症狀**:看 `salary_records.gross_salary` 跟 income 加總對不上。

**Debug**:
- GENERATED 公式:`COALESCE(prorata_base, base_salary) + 11 個 income 欄位`
- 若 `prorata_base` 有值、會走 prorata 而非 base — 確認是離職月才該有 prorata_base
- 若非離職月卻 `prorata_base != NULL`、表示資料異常、需 UPDATE 設 NULL

---

# 8. Backlog 已知未補

下列功能 MVP 時已 flag、後續分階段補強:

| ID | 項目 |
|---|---|
| F1 | 離職檢核表 PDF 匯出(含勾選狀態 / 完成日期 / 經手人 / 備註) |
| F2 | HR 經辦網頁手寫簽名(canvas) |
| F3 | 直屬主管網頁手寫簽名 |
| F4 | 離職員工本人網頁手寫簽名(已離職場景設計) |
| F5 | PDF 內嵌 3 角色簽名圖檔(最終版) |
| F6 | 「全部完成」鎖定機制(防匯出後竄改) |
| F7 | 簽名版本控制(留 history、不覆寫) |
| F8 | 完成度自動通知(HR 簽完 → 通知主管簽 / 全簽完 → 通知員工) |
| F9 | 離職員工網頁版(員工自己登入看自己檢核表) |
| F10 | L4 電子簽章法等級(CA 認證 + 時間戳記、需第三方服務) |

詳見 `docs/backlog.md`。

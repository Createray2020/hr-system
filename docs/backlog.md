# Backlog

## 離職檢核表 follow-up(F1-F10)

來源:2026-05-26 EMP_01251101 incident MVP 開發,本 commit 只交付 Plan A 範圍。
以下 10 項明確留 backlog、未來分階段補強。

| ID | 項目 | 說明 |
|---|---|---|
| **F1** | 離職檢核表 PDF 匯出 | 含勾選狀態 / 完成日期 / 經手人 / 備註,給 HR 歸檔用 |
| **F2** | HR 經辦網頁手寫簽名 | canvas pad → base64 PNG,寫入 `resignation_checklist_signatures`(signer_role='hr')|
| **F3** | 直屬主管網頁手寫簽名 | 同上(signer_role='manager')|
| **F4** | 離職員工本人網頁手寫簽名 | 員工已離職場景設計:HR 代替印出實體簽 / 員工最後一天現場簽(signer_role='employee')|
| **F5** | PDF 內嵌簽名圖檔 | F1 PDF 在 3 角色簽完才生最終 PDF 版本(替代手簽紙本)|
| **F6** | 「全部完成」鎖定機制 | `resignation_checklists.status='locked'` + `locked_at` / `locked_by` 寫入,防匯出後竄改 |
| **F7** | 簽名版本控制 | 每次簽名留 history、不覆寫(F2-F4 重簽時保留舊版)|
| **F8** | 完成度自動通知 | HR 簽完 → 通知主管簽;全部簽完 → 通知員工(若仍可登入)|
| **F9** | 離職員工網頁版 | 員工自己登入看自己檢核表、可備註(配合 B7 LoginCheck.shouldBlockResignedLogin 設計:resign_date 未到時仍可登入)|
| **F10** | L4 電子簽章法等級 | CA 認證 + 時間戳記、需第三方服務(數位簽章中心 / TWCA 等),取代手寫簽名 |

## 其他 incident-2026-05-26 follow-up(B16-B31)

階段 4 + 任務 5 累積:

🔴 **高優(影響薪資 / 法規)**
- **B22** annual leave 結算 cascade(applyResignation 應自動 settle current period record)
- **B26** salary pro-rata(離職月薪資按工作日比例、calculator.js 應偵測 resigned_at)
- **B27** insurance termination 通知 / 機制(法定勞健保退保 5 日 / 3 日內)

🟡 **中優(資料一致性 / 安全性)**
- **B16** 跨 period 假單扣抵分段(B14 follow-up)
- **B17** `getAnnualBalance` 邊界 race(B14 B 案 follow-up)
- **B18** `refundAnnualLeave` 無 production caller、cancel-after-approve 路徑缺
- **B19** `api/approvals.js?type=pending` 改 supabase server-side filter(效能)
- **B21** Supabase Auth user disable(離職員工 token 仍有效)
- **B23** comp_time_balance settle cascade(加班費未發)
- **B24** auto-cancel pending leave_requests on resignation
- **B25** auto-cancel pending approval_requests on resignation
- **B29** push_subscriptions 清除(本 commit 已在 cascade 加、待驗)
- **B31** HR post-resignation checklist 通知(本 commit 已在 cascade 加、待驗)

🟢 **低優(便利性 / nice-to-have)**
- **B28** 服務證明書 PDF 模板
- **B30** `departments.manager_id` / `employees.manager_id` 孤兒化檢測

# HR System v2 — 部署指南

## 專案架構

```
hr-system-v2/
├── api/
│   ├── stats.js                  GET  /api/stats
│   ├── leaves.js                 GET  /api/leaves   POST /api/leaves
│   ├── leave.js                  GET  /api/leave?id=  PUT /api/leave?id=
│   ├── employees/
│   │   ├── index.js              GET  /api/employees  POST /api/employees
│   │   └── [id].js               GET  /api/employees/:id  PUT  DELETE
│   ├── attendance/
│   │   ├── index.js              GET  /api/attendance
│   │   ├── punch.js              POST /api/attendance/punch
│   │   └── manual.js             POST /api/attendance/manual
│   └── salary/
│       ├── index.js              GET  /api/salary
│       ├── batch.js              POST /api/salary/batch
│       └── [id].js               PUT  /api/salary/:id  (confirm / pay)
├── lib/
│   └── supabase.js               共用 DB client
├── public/
│   ├── login.html                登入頁
│   ├── dashboard.html            總覽
│   ├── leave.html                請假審批
│   ├── attendance.html           出勤管理
│   ├── employees.html            員工資料
│   ├── salary.html               薪資管理
│   ├── css/style.css             共用樣式
│   └── js/
│       ├── app.js                共用工具（備用）
│       └── layout.js             Sidebar 注入 + Auth guard
├── supabase_setup.sql            資料庫建表 SQL
├── vercel.json                   路由設定
├── package.json
└── .env.example
```

---

## 步驟一：Supabase 設定（約 10 分鐘）

1. 到 https://supabase.com → New Project
2. 專案名稱：`hr-system`，選擇最近的地區（Asia Northeast 1 — Tokyo）
3. 建立完成後，進入 **SQL Editor**
4. 貼上 `supabase_setup.sql` 全部內容 → Run
5. 到 **Authentication → Users** → 點「Add user」，建立測試帳號：
   - `li@hr.com` / `hr123456`（主管）
   - `chen@hr.com` / `hr123456`（員工）
6. 到 **Project Settings → API**，複製：
   - Project URL：`https://xxx.supabase.co`
   - anon public key：`eyJ...`

---

## 步驟二：修改前端設定

在 `public/login.html` 和 `public/js/layout.js` 中，
將這兩個 placeholder 替換成你的實際值：

```
__SUPABASE_URL__      → https://xxx.supabase.co
__SUPABASE_ANON_KEY__ → eyJ...（你的 anon key）
```

用編輯器全域取代（Ctrl+H）即可一次換完。

---

## 步驟三：推上 GitHub

```bash
cd hr-system-v2
git init
git add .
git commit -m "feat: HR System v2 — full modules"
git branch -M main
git remote add origin https://github.com/你的帳號/hr-system.git
git push -u origin main
```

---

## 步驟四：Vercel 部署

1. 到 https://vercel.com → Add New Project
2. Import 你的 GitHub repo
3. Framework Preset → **Other**
4. Root Directory → 保持空白（根目錄）
5. 展開 **Environment Variables**，新增：
   ```
   SUPABASE_URL       = https://xxx.supabase.co
   SUPABASE_ANON_KEY  = eyJ...
   ```
6. Deploy → 等待 1~2 分鐘
7. 完成！開啟 `https://hr-system-xxx.vercel.app/login.html`

---

## 本機開發

```bash
npm install
cp .env.example .env.local
# 編輯 .env.local 填入 Supabase 資訊

npx vercel dev
# 開啟 http://localhost:3000/login.html
```

---

## 功能總覽

| 模組 | 功能 |
|------|------|
| 登入驗證 | Supabase Auth、JWT、自動跳轉 |
| 總覽 Dashboard | 待審假單、出勤狀況、薪資概況、近期壽星 |
| 請假審批 | 申請、審核、退回、PDF 匯出（單筆/清單） |
| 出勤管理 | 即時打卡、人工補登、月份篩選、PDF 報表 |
| 員工資料 | 卡片/列表切換、新增/編輯、全欄位管理 |
| 薪資管理 | 批次產生草稿、自動計算加班/勞健保/稅、確認/發放流程、PDF 薪資單 |

---

## 常見問題

**Q：登入頁顯示空白/錯誤**
→ 確認已替換 `__SUPABASE_URL__` 和 `__SUPABASE_ANON_KEY__`

**Q：API 回傳 500**
→ 確認 Vercel 環境變數已正確設定，且 Supabase SQL 已執行

**Q：PDF 中文顯示方塊**
→ jsPDF 預設不支援中文字型；資料欄位以英文呈現是正常行為，
  reason/note 等自由文字欄位如需支援中文，可嵌入 Noto Sans CJK 字型（檔案較大）

**Q：打卡沒有反應**
→ 確認 Supabase Auth 已建立對應 email 的使用者帳號，
  且 employees 資料表中的 email 欄位與登入帳號相符

# GPS Phase A — 完整收尾紀錄

## 範圍

員工打卡時記錄 GPS 座標 + 距公司據點距離 + flag。Soft mode(不擋打卡、純記錄)。HR 後台 CRUD 據點清單。

---

## 7 個 commit

| # | hash | 標題 |
|---|---|---|
| 1 | `44f6d9f` | feat(attendance): GPS Phase A schema — office_locations + attendance GPS 欄位 |
| 2 | `4840fae` | feat(attendance): GPS Phase A — lib/geo.js 純函式 + 24 case 單測 |
| 3 | `6008439` | feat(attendance): GPS Phase A — api/office-locations CRUD endpoint(26 case) |
| 4 | `1db8b3d` | feat(attendance): GPS Phase A — public/attendance-locations-admin.html(HR 據點管理 UI)|
| 5 | `89b45a4` | feat(attendance): GPS Phase A — lib/clock.js 接 geo 寫 attendance GPS 欄位(11 case)|
| 6 | `033889f` | feat(attendance): GPS Phase A — handleNewPunch 接 body.geo + repo.findActiveOfficeLocations(16 case)|
| 7 | `1f02f37` | feat(attendance): GPS Phase A — frontend 拿 GPS 送出打卡(最後一步)|

vitest 累積:0 → **999 passing / 63 files**(本期 +77 case、無 regression)

---

## 整條 flow

```
frontend navigator.geolocation
  → POST body.geo
  → handler validateGeoBody (範圍檢查 + normalize)
  → lib clockIn / clockOut buildGpsPatch
  → validateGeofence (soft mode、不擋打卡)
  → repo.findActiveOfficeLocations
  → attendance row 11 個 GPS 欄位
```

---

## Schema 改動清單

### `office_locations` 新表(9 columns + 1 partial index)

| column | type | nullable | default |
|---|---|---|---|
| id | TEXT PK | NO | — |
| name | TEXT | NO | — |
| lat | NUMERIC(10,7) | NO | — |
| lng | NUMERIC(10,7) | NO | — |
| radius_m | INT | NO | 150 |
| is_active | BOOLEAN | NO | true |
| note | TEXT | YES | NULL |
| created_at | TIMESTAMPTZ | NO | NOW() |
| updated_at | TIMESTAMPTZ | NO | NOW() |

partial index:`idx_office_locations_active ON (is_active) WHERE is_active = true`

### `attendance` ALTER(11 GPS columns + gps_flag CHECK)

```
clock_in_lat            NUMERIC(10,7)
clock_in_lng            NUMERIC(10,7)
clock_in_accuracy       NUMERIC(6,1)
clock_in_distance_m     NUMERIC(8,1)
clock_in_location_id    TEXT FK → office_locations(id)
clock_out_lat           NUMERIC(10,7)
clock_out_lng           NUMERIC(10,7)
clock_out_accuracy      NUMERIC(6,1)
clock_out_distance_m    NUMERIC(8,1)
clock_out_location_id   TEXT FK → office_locations(id)
gps_flag                TEXT CHECK ∈ {NULL, 'denied', 'outside', 'low_accuracy', 'mock_suspected'}
```

詳見 `migrations/2026_05_07_attendance_gps_phase_a.sql`、verify 在 `migrations-verify/verify_attendance_gps_phase_a.sql`。

---

## 設計決策(Phase A 拍板)

- **`LOW_ACCURACY_THRESHOLD_M = 100`** 內建在 `lib/attendance/geo.js`(一般戶外 GPS < 100m)
- **`gps_flag` 單欄、clockOut 覆寫**(最後寫贏、語意 = 最近一次打卡狀況、不分 in / out)
- **DELETE 軟刪 `office_locations`**(set is_active=false、保 `attendance.location_id` FK history)
- **frontend GPS 失敗仍送 punch**(soft mode、`gps_flag='denied'` 寫 row、不打擾 user)
- **`attendance` 11 個 GPS columns 直接塞同表**(不拆 `attendance_geo` 子表、避免 JOIN、薪資結算層查詢更省)
- **`LOC_*` id prefix 對齊 `EMP_*` pattern**(建議不強制、validation 只擋空白 / 超 50 字)
- **CHECK 含 `mock_suspected`**(Phase A 不用、Phase C 評估 mock GPS 偵測時不需 ALTER)

### 三態 `geo` 行為(lib clockIn / clockOut + handleNewPunch validate)

| body.geo | lib geo | 行為 |
|---|---|---|
| 不傳(undefined)| undefined | 完全不動 GPS 欄位(向後相容、既有 caller 不需改)|
| `null` | null | `gps_flag='denied'`、座標欄位寫 NULL |
| `{ lat, lng, accuracy }` | object | 走 validateGeofence、寫 lat/lng/distance_m/location_id/flag |
| 其他 shape(string / array / boolean / number)| — | handler 回 400 `INVALID_GEO` |

---

## Phase B 評估 checklist(累積 1-2 週數據後)

### 跑分析 query 看真實分布

```sql
-- distance_m 分布(在 radius 內 / outside 各多少)
SELECT gps_flag, COUNT(*),
  AVG(clock_in_distance_m) AS avg_in,
  AVG(clock_out_distance_m) AS avg_out,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY clock_in_distance_m) AS median_in
FROM attendance
WHERE clock_in_lat IS NOT NULL
  AND work_date >= CURRENT_DATE - INTERVAL '2 weeks'
GROUP BY gps_flag;

-- accuracy 分布
SELECT
  COUNT(*) FILTER (WHERE clock_in_accuracy <= 20)                         AS excellent,
  COUNT(*) FILTER (WHERE clock_in_accuracy > 20 AND clock_in_accuracy <= 50) AS good,
  COUNT(*) FILTER (WHERE clock_in_accuracy > 50 AND clock_in_accuracy <= 100) AS ok,
  COUNT(*) FILTER (WHERE clock_in_accuracy > 100)                          AS bad
FROM attendance
WHERE clock_in_lat IS NOT NULL
  AND work_date >= CURRENT_DATE - INTERVAL '2 weeks';

-- 連 5 天 denied 的員工(教育 / 管理介入)
SELECT employee_id, COUNT(*) AS denied_days
FROM attendance
WHERE gps_flag = 'denied'
  AND work_date >= CURRENT_DATE - INTERVAL '2 weeks'
GROUP BY employee_id
HAVING COUNT(*) >= 5;
```

### 評估面向

- **distance_m 分布**:員工在公司打卡時實際距 `office_location` 多少?→ 決定 `radius_m` 該調多少(目前預設 150m、可能太緊或太鬆)
- **accuracy 分布**:GPS 信號品質、室內 / 高樓 / 地下室是否常 > 100m
- **gps_flag 分布**:null / denied / outside / low_accuracy 各多少 row、是否需要先教育員工開定位
- **連續 N 天 'denied' 員工**:教育 / 管理介入(可能是設備 issue 或員工故意)

---

## Phase B 動作(拍板後)

- **`lib/clock.js` mode='soft' → 'hard'**(一行改、buildGpsPatch 內 mode 參數)
- **前端 GPS 失敗 UX**:alert + 是否仍允許 punch(目前 soft 是不擋、hard 要擋並提示)
- **加「主管核准例外打卡」流程**(外勤 / 出差豁免、需新 schema + endpoint)
- **`radius_m` 依數據調整**(後台 attendance-locations-admin 直接改、不需 deploy)

---

## Smoke test status

- **vitest**:999 passing / 63 files、全綠
- **Browser smoke test**:_____(待 user 跑完自己填、或下次 commit update)
  1. attendance.html 點打卡 → 允許 GPS → 打卡成功 + row 有 lat/lng/accuracy/location_id
  2. 拒絕 GPS → console warn、打卡仍成功(`gps_flag='denied'`)
  3. employee-app.html 同樣兩條
  4. 在 office_locations radius 外打卡 → `gps_flag='outside'`(soft 仍 ok)
  5. HR 後台 attendance-locations-admin.html 列表 / 新增 / 地圖選點 / 編輯 / 軟刪

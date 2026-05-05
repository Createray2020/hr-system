-- migrations/2026_05_05_attendance_absent_offday_cleanup.sql
--
-- Cron-absence-detection 修補前(commit ab69be7)、findLockedSchedulesByDate
-- 沒過濾 shift_type.is_off=true、把例假 / 休假 / 國假 schedule 的員工誤寫 absent。
-- 這些 row 本來就不該存在、cleanup 全清。
--
-- 預期 affected:52 筆
--   2026-04-26: 18 筆 ST003 休假
--   2026-04-27:  2 筆 ST003 休假
--   2026-04-28:  3 筆 ST003 休假
--   2026-04-29:  4 筆 ST003 休假
--   2026-04-30:  6 筆 ST003 休假
--   2026-05-03: 19 筆 ST004 例假
--
-- 不刪:62 筆 ST001 真曠職(on-duty 但沒打卡、保留)
--
-- 執行步驟:user 在 Supabase SQL Editor 操作
--   ① 先跑 VERIFY SELECT 確認 count 仍 = 52(每天分組數字也對得上)
--   ② count 確認後再跑 DELETE
--
-- 不要直接整檔複製貼上!分兩步、避免誤刪。

-- ═══ ① VERIFY:跑這條確認 affected 範圍 ═══
SELECT a.work_date, st.id AS shift_type, st.name AS shift_name, COUNT(*) AS rows_to_delete
FROM attendance a
JOIN schedules s ON a.schedule_id = s.id
JOIN shift_types st ON s.shift_type_id = st.id
WHERE a.status = 'absent'
  AND st.is_off = true
GROUP BY a.work_date, st.id, st.name
ORDER BY a.work_date;
-- 期望輸出:
--   2026-04-26 | ST003 | 休假 | 18
--   2026-04-27 | ST003 | 休假 |  2
--   2026-04-28 | ST003 | 休假 |  3
--   2026-04-29 | ST003 | 休假 |  4
--   2026-04-30 | ST003 | 休假 |  6
--   2026-05-03 | ST004 | 例假 | 19
-- 加總 = 52


-- ═══ ② DELETE:VERIFY 對得上才跑 ═══
-- 用 IN(SELECT ...) 寫法、避免 PG 的 DELETE USING 多 JOIN row 重複刪除歧義
DELETE FROM attendance
WHERE id IN (
  SELECT a.id
  FROM attendance a
  JOIN schedules s ON a.schedule_id = s.id
  JOIN shift_types st ON s.shift_type_id = st.id
  WHERE a.status = 'absent'
    AND st.is_off = true
);
-- 期望:DELETE 52 rows

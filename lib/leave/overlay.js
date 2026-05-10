// lib/leave/overlay.js — 請假覆蓋排班 / 出勤 query view 純函式
//
// 用途:讓 schedule / attendance API 顯示「該日有 approved leave」的覆蓋資訊、
//       不動 source data (schedules / attendance)、回退請假時自動還原。
//
// 對應設計:階段 B1 / commit 後續。
// cron-absence-detection (lib/attendance/absence-sweep.js) 已正確處理曠職判定;
// 此 lib 只負責「顯示層」的 leave_overlay 欄位附加。
//
// Filter 規則 (B1 選項 A):
//   - leave.status = 'approved' (跟 absence-sweep 一致;archived 視為 approved 後的歸檔狀態、本 lib 不認)
//   - 時間 cover 規則:leave.start_at <= day_end AND leave.end_at >= day_start
//     (跟 absence-sweep findApprovedLeaveCovering 同邏輯)
//   - 一視同仁、不分 leave_type (長假員工本來就應該排「休」、若還排班顯示「假」是凸顯 process 問題)
//
// is_full_day 判定:
//   - leave.hours >= 8 視為全日(預設 8h 工時)
//   - 否則 is_full_day = false (Phase 1.3 backlog: UI 區分上午/下午、本 lib 只標旗標)

const FULL_DAY_HOURS = 8;

/**
 * 判斷一筆 leave 是否 cover 某個 work_date。
 * @param {{start_at: string, end_at: string, status: string}} leave
 * @param {string} workDate - 'YYYY-MM-DD'
 * @returns {boolean}
 */
export function leaveCoversDate(leave, workDate) {
  if (!leave || !workDate) return false;
  if (leave.status !== 'approved') return false;
  if (!leave.start_at || !leave.end_at) return false;
  // 用字串比較 ISO timestamp 即可(timezone 一致時 lexicographic 等同 chronological)
  const dayStart = `${workDate}T00:00:00+08:00`;
  const dayEnd   = `${workDate}T23:59:59+08:00`;
  return leave.start_at <= dayEnd && leave.end_at >= dayStart;
}

/**
 * 為單一 schedule / attendance row 找到對應的 covering leave、回 overlay 物件 or null。
 *
 * @param {{employee_id, work_date}} row - 含 employee_id + work_date 的 row
 * @param {Array} leaves - approved leave_requests array
 * @param {Object} leaveTypeNameMap - { leave_type_code: name_zh } map(可選、沒給就用 code 當 name)
 * @returns {Object | null} leave_overlay 物件
 */
export function findOverlayForRow(row, leaves, leaveTypeNameMap = {}) {
  if (!row?.employee_id || !row?.work_date) return null;
  const matched = (leaves || []).find(l =>
    l.employee_id === row.employee_id && leaveCoversDate(l, row.work_date)
  );
  if (!matched) return null;
  const hours = Number(matched.finalized_hours ?? matched.hours ?? 0);
  return {
    leave_request_id: matched.id,
    leave_type:       matched.leave_type,
    leave_name:       leaveTypeNameMap[matched.leave_type] || matched.leave_type,
    hours,
    is_full_day:      hours >= FULL_DAY_HOURS,
  };
}

/**
 * 主入口:為 schedules / attendance array 加 leave_overlay 欄位。
 * 不修改原 row、回新 array。沒 covering leave 的 row 也加 leave_overlay = null
 * (前端 render 統一檢查、不用判斷 undefined vs null)。
 *
 * @param {Array} rows - schedules 或 attendance rows、需含 employee_id + work_date
 * @param {Array} leaves - approved leave_requests
 * @param {Object} leaveTypeNameMap - 可選
 * @returns {Array}
 */
export function applyLeaveOverlay(rows, leaves, leaveTypeNameMap = {}) {
  return (rows || []).map(row => ({
    ...row,
    leave_overlay: findOverlayForRow(row, leaves, leaveTypeNameMap),
  }));
}

/**
 * 找該員工該日「沒 schedule / attendance row 但有 leave」的情況、生 virtual row。
 *
 * 用於 attendance API:當天 cron 還沒跑時,attendance 沒 row、schedule 有早班、leave 也 approved。
 * 需要補一個 virtual row 給前端顯示「請假中」、不用等 cron(00:15 隔天才跑)。
 *
 * @param {Array} attendanceRows - 已有的 attendance rows
 * @param {Array} schedules - 該期間的排班(用來知道哪天該員工有排班)
 * @param {Array} leaves - approved leave_requests
 * @param {Object} leaveTypeNameMap - 可選
 * @returns {Array} virtual rows (id 用 'V_' 前綴 + employee_id + date 識別)
 */
export function buildVirtualLeaveAttendance(attendanceRows, schedules, leaves, leaveTypeNameMap = {}) {
  const attKey = (r) => `${r.employee_id}_${r.work_date}_${r.segment_no || 1}`;
  const existing = new Set((attendanceRows || []).map(attKey));
  const out = [];
  for (const sch of (schedules || [])) {
    const overlay = findOverlayForRow(sch, leaves, leaveTypeNameMap);
    if (!overlay) continue;
    const k = `${sch.employee_id}_${sch.work_date}_${sch.segment_no || 1}`;
    if (existing.has(k)) continue;
    out.push({
      id:           `V_${sch.employee_id}_${String(sch.work_date).replace(/-/g, '')}_${sch.segment_no || 1}`,
      employee_id:  sch.employee_id,
      work_date:    sch.work_date,
      schedule_id:  sch.id,
      segment_no:   sch.segment_no || 1,
      clock_in:     null,
      clock_out:    null,
      work_hours:   null,
      late_minutes: 0,
      early_leave_minutes: 0,
      status:       'leave',
      is_anomaly:   false,
      is_virtual:   true,        // 給前端 hint:這 row 不在 DB(尚未被 cron 寫入)
      leave_overlay: overlay,
    });
  }
  return out;
}

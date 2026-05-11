// public/js/leave/reason.js — leave 申請「該日無法請假」原因分流
//
// 階段 D1:替換 employee-leave.html 原本單一 toast「沒有可請假的工時」、
// 改成 3 種 reason code、UI 顯示對應具體訊息、user 知道該找誰處理。
//
// ESM 純函式、layout 一致用 dynamic import / vitest 直接 import。
// 對齊 public/js/sidebar/builder.js pattern。

/**
 * 判斷該日 schedule row 為什麼不能請假;能請假回 null。
 *
 * 排查順序(由「最缺資料」到「資料齊但 is_off」):
 *   1. !sched → 'no_schedule'   (該日沒被排班)
 *   2. shift_types.is_off=true → 'off_day' (休/例假/國假班別)
 *   3. start_time 缺(schedule 跟 shift_type 都沒值) → 'no_time'
 *   4. 其他 → null (可請假)
 *
 * 注意 fallback:schedules.start_time 為 null 但 shift_types.start_time 有值
 * → 視為「可請假」、前端 / 後端 calculateLeaveHours 都該 fallback 用 shift_types 的預設時間。
 *
 * @param {Object|null} sched - schedule row(含 nested shift_types 或 flattened)
 * @returns {'no_schedule'|'off_day'|'no_time'|null}
 */
export function getDayBlockReason(sched) {
  if (!sched) return 'no_schedule';
  if (sched.shift_types?.is_off === true) return 'off_day';
  const start = sched.start_time || sched.shift_types?.start_time;
  if (!start) return 'no_time';
  return null;
}

/**
 * 取得有效 start_time(schedule overrides → shift_type default)
 * @returns {string|null}
 */
export function getEffectiveStartTime(sched) {
  return sched?.start_time || sched?.shift_types?.start_time || null;
}

/**
 * 取得有效 end_time。
 * @returns {string|null}
 */
export function getEffectiveEndTime(sched) {
  return sched?.end_time || sched?.shift_types?.end_time || null;
}

/**
 * 把 reason code 轉成顯示給 user 的具體訊息。
 * @param {string} reason - 'no_schedule' / 'off_day' / 'no_time'
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @returns {string}
 */
export function reasonMessage(reason, dateStr) {
  switch (reason) {
    case 'no_schedule': return `${dateStr}:還沒被排班、請聯絡主管確認班表`;
    case 'off_day':     return `${dateStr}:是您的休假日 / 例假日 / 國定假日、不需請假`;
    case 'no_time':     return `${dateStr}:排班時間未設定、請主管補填上下班時間`;
    default:            return `${dateStr}:其他原因`;
  }
}

/**
 * 一站式:把日期 array + cachedSchedules 轉成「可請的日子」+「擋下原因 array」。
 * 給 employee-leave.html renderSchedPreview / submitLeave 用、避免每處重複寫 filter loop。
 *
 * @param {Array<string>} dates - 日期 array、'YYYY-MM-DD'
 * @param {Array} cachedSchedules - 已撈的 schedules、含 work_date + shift_types
 * @returns {{ workable: string[], blocked: Array<{date, reason, message}> }}
 */
export function diagnoseRange(dates, cachedSchedules) {
  const workable = [];
  const blocked = [];
  for (const d of (dates || [])) {
    const sched = (cachedSchedules || []).find(s => String(s?.work_date).slice(0, 10) === d);
    const reason = getDayBlockReason(sched);
    if (reason === null) workable.push(d);
    else blocked.push({ date: d, reason, message: reasonMessage(reason, d) });
  }
  return { workable, blocked };
}

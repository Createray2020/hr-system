// lib/schedule/work-hours.js — 工時計算（純函式）
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.2 / §10.1（彈性休息扣除）
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.4
//
// 三個純函式：
//   calculateScheduleWorkMinutes(start, end, breakMin, crossesMidnight) — 單段工時
//   calculateDailyTotalMinutes(segments)                                 — 多段加總
//   detectSegmentOverlap(segments)                                       — 多段重疊偵測

/**
 * 計算單段班次工時（分鐘）。
 *
 * @param {string} startTime   'HH:MM' 或 'HH:MM:SS'
 * @param {string} endTime     'HH:MM' 或 'HH:MM:SS'
 * @param {number} breakMinutes  休息扣除分鐘數
 * @param {boolean} crossesMidnight 是否跨日（end < start 時也視為跨日）
 * @returns {number} 分鐘數，無效時間或結果為負時回 0
 */
export function calculateScheduleWorkMinutes(startTime, endTime, breakMinutes, crossesMidnight) {
  const start = parseTimeToMinutes(startTime);
  const end   = parseTimeToMinutes(endTime);
  if (start == null || end == null) return 0;

  const brk = Math.max(0, parseInt(breakMinutes) || 0);

  let span;
  if (crossesMidnight || end < start) {
    span = (24 * 60 - start) + end;
  } else {
    span = end - start;
  }
  return Math.max(0, span - brk);
}

/**
 * 同一員工同一天多段班的工時總和。
 *
 * @param {Array<{ start_time: string, end_time: string, break_minutes?: number, crosses_midnight?: boolean }>} segments
 * @returns {number} 分鐘數
 */
export function calculateDailyTotalMinutes(segments) {
  if (!Array.isArray(segments)) return 0;
  let total = 0;
  for (const s of segments) {
    total += calculateScheduleWorkMinutes(
      s.start_time, s.end_time, s.break_minutes, s.crosses_midnight,
    );
  }
  return total;
}

/**
 * 偵測多段班次間時間重疊。每對重疊回一筆 { segmentA, segmentB }。
 * 跨日段以 +1440 平移後比較絕對區間。
 *
 * @param {Array<Object>} segments
 * @returns {Array<{ segmentA: Object, segmentB: Object }>}
 */
export function detectSegmentOverlap(segments) {
  if (!Array.isArray(segments) || segments.length < 2) return [];

  const ranges = segments.map(s => {
    const start = parseTimeToMinutes(s.start_time);
    let end = parseTimeToMinutes(s.end_time);
    if (start == null || end == null) return null;
    if (s.crosses_midnight || end < start) end += 24 * 60;
    if (end === start) return null;
    return { start, end, seg: s };
  });

  const out = [];
  for (let i = 0; i < ranges.length; i++) {
    const a = ranges[i];
    if (!a) continue;
    for (let j = i + 1; j < ranges.length; j++) {
      const b = ranges[j];
      if (!b) continue;
      if (a.start < b.end && b.start < a.end) {
        out.push({ segmentA: a.seg, segmentB: b.seg });
      }
    }
  }
  return out;
}

function parseTimeToMinutes(t) {
  if (t == null || t === '') return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = parseInt(m[1]);
  const min = parseInt(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

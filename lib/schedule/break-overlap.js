// lib/schedule/break-overlap.js — 三類 shift break 演算 SOT(前後端共用)
//
// 對應問題:原本只有 break_minutes 整數、無「午休實際時段」概念,
// 導致:
//   1) 員工請假頁半天切點只能 (start+end)/2 中點 (Bug A)
//   2) 時數演算只能 ratio=work/span 均攤 break (Bug B)
//
// 三類分流(依 shift 欄位狀態判斷):
//   fixed    break_start/break_end 有值 → 扣請假區間與 break 區間的 overlap
//   flexible break_start/break_end 為 NULL + break_minutes>0 → 沿用 ratio=work/span 攤算
//   none     break_minutes=0(含 is_off shift)               → 純 overlap、不扣
//
// ⚠ public/employee-leave.html 內嵌一份精簡 mirror、改這邊請同步那邊。

/** 三類分流判斷。回 'fixed' | 'flexible' | 'none'。 */
export function classifyShiftBreak(shift) {
  if (!shift) return 'none';
  if (shift.break_start && shift.break_end) return 'fixed';
  if (Number(shift.break_minutes) > 0) return 'flexible';
  return 'none';
}

/** 把 'HH:MM' / 'HH:MM:SS' 結合 baseDateStr ('YYYY-MM-DD') 轉成 ms (台灣時區 +08:00)。 */
export function timeStringToMs(timeStr, baseDateStr) {
  if (!timeStr) return null;
  const m = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const t = Date.parse(`${baseDateStr}T${m[1].padStart(2,'0')}:${m[2]}:00+08:00`);
  return Number.isFinite(t) ? t : null;
}

/** 計算請假區間 [reqStartMs, reqEndMs] 與 shift.break_start..break_end 的重疊毫秒。
 *  shift 沒 break_start/break_end 回 0、區間無效回 0。
 */
export function calculateBreakOverlapMs(reqStartMs, reqEndMs, baseDateStr, shift) {
  if (!shift?.break_start || !shift?.break_end) return 0;
  const bStart = timeStringToMs(shift.break_start, baseDateStr);
  const bEnd   = timeStringToMs(shift.break_end,   baseDateStr);
  if (bStart == null || bEnd == null || bEnd <= bStart) return 0;
  return Math.max(0, Math.min(reqEndMs, bEnd) - Math.max(reqStartMs, bStart));
}

/** 給單一 segment(一筆 schedule + shift 資料)算請假時數(分鐘)。
 *  三類分流。回傳 number、允許小數、不做 round(由 caller 決定粒度)。
 *
 *  注意 fixed 模式:扣的是「請假 ∩ 排班 ∩ 午休」、不是「請假 ∩ 午休」。
 *  否則多段班(早班 9-12 + 晚班 14-18)都會被重複扣午休 60 分鐘。
 */
export function calculateSegmentLeaveMinutes({
  reqStartMs, reqEndMs,
  segStartMs, segEndMs,
  shift, baseDateStr,
}) {
  const overlapStart = Math.max(reqStartMs, segStartMs);
  const overlapEnd   = Math.min(reqEndMs,   segEndMs);
  const overlap = Math.max(0, overlapEnd - overlapStart);
  if (overlap <= 0) return 0;

  const mode = classifyShiftBreak(shift);
  if (mode === 'none') return overlap / 60000;

  if (mode === 'fixed') {
    // 扣「請假 ∩ 排班 ∩ 午休」、傳 overlap range 進去而不是 request range
    const breakOverlap = calculateBreakOverlapMs(overlapStart, overlapEnd, baseDateStr, shift);
    return Math.max(0, overlap - breakOverlap) / 60000;
  }

  // flexible:沿用 ratio=work/span 攤算
  const span = Math.max(1, segEndMs - segStartMs);
  const breakMs = Number(shift.break_minutes || 0) * 60000;
  const work = Math.max(0, span - breakMs);
  const ratio = work / span;
  return overlap * ratio / 60000;
}

/** 給前端用:算半天切點。
 *  fixed   → { morning: {start, end:break_start}, afternoon: {start:break_end, end} }
 *  flexible/none → 中點對切(沿用現邏輯)
 *  is_off / 沒 start_time/end_time → null
 */
export function calculateHalfDayBoundaries(shift) {
  if (!shift?.start_time || !shift?.end_time) return null;
  if (shift.shift_types?.is_off || shift.is_off) return null;
  const startStr = String(shift.start_time).slice(0, 5);
  const endStr   = String(shift.end_time).slice(0, 5);

  if (classifyShiftBreak(shift) === 'fixed') {
    return {
      morning:   { start: startStr, end: String(shift.break_start).slice(0, 5) },
      afternoon: { start: String(shift.break_end).slice(0, 5), end: endStr },
    };
  }

  // flexible / none → 中點
  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  const startMin = sh*60 + sm;
  const endMin   = eh*60 + em + (shift.crosses_midnight ? 1440 : 0);
  const midMin = (startMin + endMin) / 2;
  const midH = Math.floor(midMin / 60) % 24;
  const midM = Math.round(midMin % 60);
  const midStr = `${String(midH).padStart(2,'0')}:${String(midM).padStart(2,'0')}`;
  return {
    morning:   { start: startStr, end: midStr },
    afternoon: { start: midStr,   end: endStr },
  };
}

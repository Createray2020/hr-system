// lib/schedule/excel-builder.js
//
// 純 function：建立排班月表 AOA（2D array）+ metadata。
// 不依賴 XLSX 庫；caller 用 XLSX.utils.aoa_to_sheet(result.aoa) 轉為 sheet。
//
// Sheet layout：
//   Row 1：標題「YYYY 年 MM 月 班表」
//   Row 2：員工編號 / 姓名 / 班型 / 5/1 / 5/2 / ...（header）
//   Row 3：空 / 空 / 空 / 一 / 二 / ...（星期）
//   Row 4：空 / 空 / 空 / GCal events titles（逗號合併）
//   Row 5：空 / 空 / 空 / 規則 emoji（含「連線」→ 🟢、「客服禁」→ 🚫）
//   Row 6+：員工資料

// Excel 文字 → DB shift_types.name 的 alias 對照
export const ALIAS_MAP = Object.freeze({
  '休':       '休假',
  '休假日':   '休假',
  '休息日':   '休假',
  '例':       '例假',
  '例假日':   '例假',
  '一般日班': '一般日班',
  '日班':     '一般日班',
  'D':        '一般日班',
  '中班':     '中班',
  '晚班':     '晚班',
  '夜班':     '夜班',
  '國定假日': '國定假日',
  '國定':     '國定假日',
});

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

export const HEADER_ROW_INDEX = 1;     // Row 2（0-indexed）= 員工編號 / 姓名 / 班型 / 5/1 ...
export const FIRST_DATE_COL_INDEX = 3; // D 欄起為日期
export const FIRST_DATA_ROW_INDEX = 5; // Row 6（0-indexed）起為員工資料

export function pad2(n) { return String(n).padStart(2, '0'); }

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function fmtDate(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// 判斷 GCal event 是否落在某日（含 all-day exclusive end 處理）
function eventOnDate(ev, dateStr) {
  if (!ev?.start) return false;
  const startStr = String(ev.start).slice(0, 10);
  if (ev.allDay && ev.end) {
    const endStr = String(ev.end).slice(0, 10);
    if (endStr > startStr) {
      // exclusive end → 推回一天
      const inclEnd = new Date(new Date(endStr + 'T00:00:00Z').getTime() - 86400000)
        .toISOString().slice(0, 10);
      return dateStr >= startStr && dateStr <= inclEnd;
    }
  }
  return startStr === dateStr;
}

function eventsOnDate(gcalEvents, dateStr) {
  return (gcalEvents || []).filter(ev => eventOnDate(ev, dateStr));
}

function ruleEmojiFor(events) {
  const tags = new Set();
  for (const e of events || []) {
    const t = e?.title || '';
    if (t.includes('連線')) tags.add('🟢');
    if (t.includes('客服禁')) tags.add('🚫');
  }
  return [...tags].join('');
}

/**
 * 建立排班月表 AOA。
 *
 * @param {Object} opts
 * @param {number} opts.year - 例 2026
 * @param {number} opts.month - 1-12
 * @param {Array<{id:string, name?:string}>} opts.employees - 員工清單（已過濾 visibleEmps、依顯示順序）
 * @param {Array} opts.schedules - schedule rows（含 employee_id / work_date / shift_type_id / segment_no / shift_types?）
 * @param {Array<{id:string, name:string, is_active?:boolean}>} opts.shiftTypes - 班別清單
 * @param {Array} [opts.gcalEvents] - GCal events
 * @returns {{ sheetName:string, aoa:Array<Array<any>>, columnWidths:Array<number> }}
 */
export function buildScheduleAOA({ year, month, employees, schedules, shiftTypes, gcalEvents }) {
  const days = daysInMonth(year, month);
  const sheetName = `${year}-${pad2(month)} 班表`;

  // shift_type_id → row（fallback 用）
  const stMap = Object.fromEntries((shiftTypes || []).map(t => [t.id, t]));

  const aoa = [];

  // Row 1: 標題
  const totalCols = FIRST_DATE_COL_INDEX + days;
  const titleRow = new Array(totalCols).fill('');
  titleRow[0] = `${year} 年 ${month} 月 班表`;
  aoa.push(titleRow);

  // Row 2: header（員工編號 / 姓名 / 班型 / 日期）
  const headerRow = ['員工編號', '姓名', '班型'];
  for (let d = 1; d <= days; d++) headerRow.push(`${month}/${d}`);
  aoa.push(headerRow);

  // Row 3: 星期
  const weekdayRow = ['', '', ''];
  for (let d = 1; d <= days; d++) {
    const dt = new Date(Date.UTC(year, month - 1, d));
    weekdayRow.push(WEEKDAY_LABELS[dt.getUTCDay()]);
  }
  aoa.push(weekdayRow);

  // Row 4: GCal events titles
  const eventRow = ['', '', ''];
  for (let d = 1; d <= days; d++) {
    const dateStr = fmtDate(year, month, d);
    const events = eventsOnDate(gcalEvents, dateStr);
    eventRow.push(events.map(e => e.title || '').filter(Boolean).join('、'));
  }
  aoa.push(eventRow);

  // Row 5: 規則 emoji
  const ruleRow = ['', '', ''];
  for (let d = 1; d <= days; d++) {
    const dateStr = fmtDate(year, month, d);
    const events = eventsOnDate(gcalEvents, dateStr);
    ruleRow.push(ruleEmojiFor(events));
  }
  aoa.push(ruleRow);

  // Row 6+: 員工資料
  // index schedules by employee_id|work_date
  const scheduleMap = {};
  for (const s of schedules || []) {
    if (!s.employee_id || !s.work_date) continue;
    const key = `${s.employee_id}|${s.work_date}`;
    if (!scheduleMap[key]) scheduleMap[key] = [];
    scheduleMap[key].push(s);
  }

  for (const emp of employees || []) {
    const row = [emp.id || '', emp.name || '', '']; // 班型欄位：spec 留空、人工填
    for (let d = 1; d <= days; d++) {
      const dateStr = fmtDate(year, month, d);
      const segs = scheduleMap[`${emp.id}|${dateStr}`] || [];
      if (segs.length === 0) {
        row.push('');
      } else if (segs.length === 1) {
        const s = segs[0];
        const name = s.shift_types?.name || stMap[s.shift_type_id]?.name || s.shift_type_id || '';
        row.push(name);
      } else {
        // 多段：name 用 + 串接（匯入時不 round-trip、會 raise 錯誤）
        const sorted = [...segs].sort((a, b) => (a.segment_no || 1) - (b.segment_no || 1));
        const names = sorted.map(s =>
          s.shift_types?.name || stMap[s.shift_type_id]?.name || s.shift_type_id || '?'
        );
        row.push(names.join('+'));
      }
    }
    aoa.push(row);
  }

  // 欄寬：員工編號 12、姓名 10、班型 10、日期 6
  const columnWidths = [12, 10, 10, ...new Array(days).fill(6)];

  return { sheetName, aoa, columnWidths };
}

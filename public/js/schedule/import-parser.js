// public/js/schedule/import-parser.js
//
// 純 function：解析排班月表 AOA → schedule rows + errors。
// 不依賴 XLSX 庫；caller 預先 XLSX.read + sheet_to_json with header:1 → AOA。
//
// 規則：
//   - Row 6（index 5）起為員工資料
//   - col A (index 0) = 員工編號（必填、空 = 跳過該 row）
//   - col D (index 3) 起為日期 cell
//   - 多段 cell（含 +）→ 列入錯誤、不 round-trip
//   - alias 比對 → DB shift_types.name（filter is_active=true）
//   - 找不到 → 列入錯誤

import {
  ALIAS_MAP, daysInMonth, fmtDate,
  HEADER_ROW_INDEX, FIRST_DATE_COL_INDEX, FIRST_DATA_ROW_INDEX,
} from './excel-builder.js';

/**
 * 解析 AOA → schedule rows + errors。
 *
 * @param {Object} opts
 * @param {Array<Array<any>>} opts.aoa - sheet_to_json with header:1 的輸出
 * @param {number} opts.year
 * @param {number} opts.month - 1-12
 * @param {Array<{id:string, name?:string}>} opts.employees - 用來驗證 employee_id 存在
 * @param {Array<{id:string, name:string, is_active?:boolean, is_off?:boolean}>} opts.shiftTypes
 * @returns {{ rows: Array, errors: Array<{row:number, col:number, message:string}>, total:number }}
 *   rows: { employee_id, work_date, shift_type_id, status:'confirmed', segment_no:1, is_off, note? }
 *   row/col 1-indexed（給人看的、非 array index）
 *   total: 處理的非空員工 row 數
 */
export function parseScheduleAOA({ aoa, year, month, employees, shiftTypes }) {
  const errors = [];
  const rows = [];
  let total = 0;

  if (!Array.isArray(aoa) || aoa.length <= FIRST_DATA_ROW_INDEX) {
    errors.push({ row: 0, col: 0, message: 'Excel 結構錯誤：員工資料 row 不足（應從 Row 6 起）' });
    return { rows, errors, total };
  }

  const days = daysInMonth(year, month);
  const headerRow = aoa[HEADER_ROW_INDEX] || [];
  if (headerRow.length < FIRST_DATE_COL_INDEX + days) {
    errors.push({
      row: HEADER_ROW_INDEX + 1, col: 0,
      message: `Excel header 缺欄位：${year}/${month} 應有 ${days} 天、實際 header ${Math.max(0, headerRow.length - FIRST_DATE_COL_INDEX)} 天`,
    });
    return { rows, errors, total };
  }

  // employees set + active shift_types name → row map
  const empIds = new Set((employees || []).map(e => e.id));
  const activeTypes = (shiftTypes || []).filter(t => t.is_active !== false);
  const nameToType = {};
  for (const t of activeTypes) {
    if (t.name) nameToType[t.name] = t;
  }

  for (let r = FIRST_DATA_ROW_INDEX; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const empId = String(row[0] ?? '').trim();
    // 空 row 直接跳過、不報錯
    // 注意：「上班人數 / 休假人數」統計 row 也是 col A 為空、會在這裡自動跳過
    if (!empId) continue;

    total++;

    if (!empIds.has(empId)) {
      errors.push({ row: r + 1, col: 1, message: `員工不存在：${empId}` });
      continue;
    }

    for (let d = 1; d <= days; d++) {
      const c = FIRST_DATE_COL_INDEX + d - 1;
      const cell = row[c];
      if (cell === null || cell === undefined) continue;
      const text = String(cell).trim();
      if (!text) continue;

      // 多段 cell（含 +）→ 拒絕、提示 HR 手動編輯
      if (text.includes('+')) {
        errors.push({
          row: r + 1, col: c + 1,
          message: `${empId} ${month}/${d}：多段排班「${text}」匯入不支援、請手動編輯`,
        });
        continue;
      }

      const aliased = ALIAS_MAP[text] || text;
      const type = nameToType[aliased];
      if (!type) {
        errors.push({
          row: r + 1, col: c + 1,
          message: `${empId} ${month}/${d}：不認得班別「${text}」（解析後「${aliased}」、不在 active shift_types）`,
        });
        continue;
      }

      const out = {
        employee_id: empId,
        work_date: fmtDate(year, month, d),
        shift_type_id: type.id,
        status: 'confirmed',
        segment_no: 1,
        is_off: !!type.is_off,
      };
      if (type.is_off) out.note = '__OFF__';
      rows.push(out);
    }
  }

  return { rows, errors, total };
}

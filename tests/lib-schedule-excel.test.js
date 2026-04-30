// Unit tests for lib/schedule/excel-builder.js + import-parser.js
//
// 兩 lib 都是純 function（不依賴 XLSX 庫）→ 直接餵 AOA 進、檢查 AOA 出。

import { describe, it, expect } from 'vitest';
import {
  buildScheduleAOA,
  ALIAS_MAP,
  daysInMonth,
  fmtDate,
  pad2,
  HEADER_ROW_INDEX,
  FIRST_DATE_COL_INDEX,
  FIRST_DATA_ROW_INDEX,
} from '../lib/schedule/excel-builder.js';
import { parseScheduleAOA } from '../lib/schedule/import-parser.js';

// 標準 shift_types fixture（與 prod DB 對齊）
const SHIFT_TYPES = [
  { id: 'ST001', name: '一般日班', is_active: true,  is_off: false },
  { id: 'ST002', name: '晚班',     is_active: false, is_off: false }, // legacy、已停用
  { id: 'ST003', name: '休假',     is_active: true,  is_off: true  },
  { id: 'ST004', name: '例假',     is_active: true,  is_off: true  },
  { id: 'ST005', name: '中班',     is_active: true,  is_off: false },
  { id: 'ST006', name: '晚班',     is_active: true,  is_off: false }, // 取代 ST002
  { id: 'ST007', name: '夜班',     is_active: true,  is_off: false },
  { id: 'ST008', name: '國定假日', is_active: true,  is_off: true  },
];

// 測試用：建一個有效的「空班表」AOA（給 parser 用）
function emptyAoaForMonth(year, month) {
  const days = daysInMonth(year, month);
  const blank = new Array(FIRST_DATE_COL_INDEX + days).fill('');
  const header = ['員工編號', '姓名', '班型'];
  for (let d = 1; d <= days; d++) header.push(`${month}/${d}`);
  return [
    [`${year} 年 ${month} 月 班表`, ...new Array(2 + days).fill('')],
    header,
    blank.slice(), // 星期
    blank.slice(), // GCal
    blank.slice(), // 規則
  ];
}

// 給定員工 row 內容（陣列、長度應為 3 + days）→ append 到 base AOA
function aoaWithEmpRows(year, month, ...empRows) {
  return [...emptyAoaForMonth(year, month), ...empRows];
}

// helper：建立員工資料 row
function empRow(empId, name, dateValuesByDay) {
  // dateValuesByDay = { 1: '一般日班', 5: '休', ... }
  const days = 31; // 預設 31、實際多餘的 col 不影響
  const row = [empId, name, ''];
  for (let d = 1; d <= days; d++) row.push(dateValuesByDay[d] ?? '');
  return row;
}

// ─────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────

describe('helpers', () => {
  it('pad2: 1 → "01"', () => expect(pad2(1)).toBe('01'));
  it('pad2: 12 → "12"', () => expect(pad2(12)).toBe('12'));

  it('daysInMonth 31-day months', () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 5)).toBe(31);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
  it('daysInMonth 30-day months', () => {
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 6)).toBe(30);
  });
  it('daysInMonth Feb non-leap = 28', () => expect(daysInMonth(2026, 2)).toBe(28));
  it('daysInMonth Feb leap = 29', () => expect(daysInMonth(2024, 2)).toBe(29));

  it('fmtDate pads month + day', () => {
    expect(fmtDate(2026, 5, 1)).toBe('2026-05-01');
    expect(fmtDate(2026, 12, 31)).toBe('2026-12-31');
  });

  it('ALIAS_MAP 覆蓋 Ray 議定的所有別名', () => {
    expect(ALIAS_MAP['休']).toBe('休假');
    expect(ALIAS_MAP['休假日']).toBe('休假');
    expect(ALIAS_MAP['休息日']).toBe('休假');
    expect(ALIAS_MAP['例']).toBe('例假');
    expect(ALIAS_MAP['例假日']).toBe('例假');
    expect(ALIAS_MAP['一般日班']).toBe('一般日班');
    expect(ALIAS_MAP['日班']).toBe('一般日班');
    expect(ALIAS_MAP['D']).toBe('一般日班');
    expect(ALIAS_MAP['中班']).toBe('中班');
    expect(ALIAS_MAP['晚班']).toBe('晚班');
    expect(ALIAS_MAP['夜班']).toBe('夜班');
    expect(ALIAS_MAP['國定假日']).toBe('國定假日');
    expect(ALIAS_MAP['國定']).toBe('國定假日');
  });
});

// ─────────────────────────────────────────────────
// buildScheduleAOA
// ─────────────────────────────────────────────────

describe('buildScheduleAOA', () => {
  it('員工 0 個 → 只有 5 個 header rows、無資料 row', () => {
    const r = buildScheduleAOA({
      year: 2026, month: 5,
      employees: [], schedules: [], shiftTypes: SHIFT_TYPES,
    });
    expect(r.aoa.length).toBe(FIRST_DATA_ROW_INDEX); // 5
    expect(r.sheetName).toBe('2026-05 班表');
  });

  it('row 1 是 title、row 2 是 header、row 3 是 weekday', () => {
    const r = buildScheduleAOA({
      year: 2026, month: 5,
      employees: [{ id: 'E001', name: '小明' }],
      schedules: [], shiftTypes: SHIFT_TYPES,
    });
    expect(r.aoa[0][0]).toBe('2026 年 5 月 班表');
    expect(r.aoa[1][0]).toBe('員工編號');
    expect(r.aoa[1][1]).toBe('姓名');
    expect(r.aoa[1][2]).toBe('班型');
    expect(r.aoa[1][3]).toBe('5/1');
    expect(r.aoa[1][3 + 30]).toBe('5/31');
    // 5/1/2026 = Friday → '五'
    expect(r.aoa[2][3]).toBe('五');
    expect(r.aoa[2][4]).toBe('六');
    expect(r.aoa[2][5]).toBe('日');
  });

  it('員工資料 row 起於 index 5、班型欄留空', () => {
    const r = buildScheduleAOA({
      year: 2026, month: 5,
      employees: [{ id: 'E001', name: '小明' }, { id: 'E002', name: '小美' }],
      schedules: [], shiftTypes: SHIFT_TYPES,
    });
    expect(r.aoa.length).toBe(FIRST_DATA_ROW_INDEX + 2);
    expect(r.aoa[5][0]).toBe('E001');
    expect(r.aoa[5][1]).toBe('小明');
    expect(r.aoa[5][2]).toBe(''); // 班型空、人工填
    expect(r.aoa[5][3]).toBe(''); // 5/1 沒排班
    expect(r.aoa[6][0]).toBe('E002');
  });

  it('員工順序保留呼叫端傳入的順序', () => {
    const r = buildScheduleAOA({
      year: 2026, month: 5,
      employees: [{ id: 'Z' }, { id: 'A' }, { id: 'M' }],
      schedules: [], shiftTypes: SHIFT_TYPES,
    });
    expect(r.aoa[5][0]).toBe('Z');
    expect(r.aoa[6][0]).toBe('A');
    expect(r.aoa[7][0]).toBe('M');
  });

  it('schedule 資料：用 JOIN 的 shift_types.name 填入 cell', () => {
    const r = buildScheduleAOA({
      year: 2026, month: 5,
      employees: [{ id: 'E001' }],
      schedules: [
        { employee_id: 'E001', work_date: '2026-05-01', shift_type_id: 'ST001',
          shift_types: { name: '一般日班' } },
        { employee_id: 'E001', work_date: '2026-05-03', shift_type_id: 'ST003',
          shift_types: { name: '休假' } },
      ],
      shiftTypes: SHIFT_TYPES,
    });
    expect(r.aoa[5][3]).toBe('一般日班'); // 5/1
    expect(r.aoa[5][4]).toBe('');         // 5/2 空
    expect(r.aoa[5][5]).toBe('休假');     // 5/3
  });

  it('schedule 沒帶 JOIN.shift_types → fallback 用 shiftTypes 參數查 name', () => {
    const r = buildScheduleAOA({
      year: 2026, month: 5,
      employees: [{ id: 'E001' }],
      schedules: [
        { employee_id: 'E001', work_date: '2026-05-01', shift_type_id: 'ST001' },
      ],
      shiftTypes: SHIFT_TYPES,
    });
    expect(r.aoa[5][3]).toBe('一般日班');
  });

  it('多段 cell：sort by segment_no、用 + 串接', () => {
    const r = buildScheduleAOA({
      year: 2026, month: 5,
      employees: [{ id: 'E001' }],
      schedules: [
        { employee_id: 'E001', work_date: '2026-05-01', segment_no: 2,
          shift_type_id: 'ST006', shift_types: { name: '晚班' } },
        { employee_id: 'E001', work_date: '2026-05-01', segment_no: 1,
          shift_type_id: 'ST001', shift_types: { name: '一般日班' } },
      ],
      shiftTypes: SHIFT_TYPES,
    });
    expect(r.aoa[5][3]).toBe('一般日班+晚班');
  });

  it('GCal events title → row 4（用「、」合併）', () => {
    const r = buildScheduleAOA({
      year: 2026, month: 5,
      employees: [{ id: 'E001' }],
      schedules: [], shiftTypes: SHIFT_TYPES,
      gcalEvents: [
        { title: '客戶會議',     start: '2026-05-01', allDay: true },
        { title: '系統維護',     start: '2026-05-01', allDay: true },
        { title: '單獨活動',     start: '2026-05-03', allDay: true },
      ],
    });
    expect(r.aoa[3][3]).toBe('客戶會議、系統維護');
    expect(r.aoa[3][4]).toBe('');
    expect(r.aoa[3][5]).toBe('單獨活動');
  });

  it('GCal 規則 emoji：含「連線」→ 🟢、含「客服禁」→ 🚫', () => {
    const r = buildScheduleAOA({
      year: 2026, month: 5,
      employees: [{ id: 'E001' }],
      schedules: [], shiftTypes: SHIFT_TYPES,
      gcalEvents: [
        { title: '客服禁出餐 (連線)', start: '2026-05-01', allDay: true },
        { title: '一般活動',          start: '2026-05-02', allDay: true },
      ],
    });
    expect(r.aoa[4][3]).toContain('🚫');
    expect(r.aoa[4][3]).toContain('🟢');
    expect(r.aoa[4][4]).toBe(''); // 一般活動不觸發
  });

  it('GCal all-day 跨多日 (exclusive end) → 範圍內每日都標', () => {
    const r = buildScheduleAOA({
      year: 2026, month: 5,
      employees: [{ id: 'E001' }],
      schedules: [], shiftTypes: SHIFT_TYPES,
      gcalEvents: [
        // GCal all-day end 是 exclusive、'2026-05-04' 表示 5/3 為最後一天
        { title: '長假', start: '2026-05-01', end: '2026-05-04', allDay: true },
      ],
    });
    expect(r.aoa[3][3]).toBe('長假'); // 5/1
    expect(r.aoa[3][4]).toBe('長假'); // 5/2
    expect(r.aoa[3][5]).toBe('長假'); // 5/3
    expect(r.aoa[3][6]).toBe('');     // 5/4 已是 exclusive
  });

  it('columnWidths 長度 = 3 + days', () => {
    const r = buildScheduleAOA({
      year: 2026, month: 4,  // April = 30 days
      employees: [], schedules: [], shiftTypes: SHIFT_TYPES,
    });
    expect(r.columnWidths.length).toBe(3 + 30);
    expect(r.aoa[1].length).toBe(3 + 30);
  });

  it('Feb 非閏年 → 28 天 cell', () => {
    const r = buildScheduleAOA({
      year: 2026, month: 2,
      employees: [{ id: 'E001' }],
      schedules: [], shiftTypes: SHIFT_TYPES,
    });
    expect(r.aoa[1][3 + 27]).toBe('2/28');
    expect(r.aoa[1].length).toBe(3 + 28);
  });
});

// ─────────────────────────────────────────────────
// parseScheduleAOA
// ─────────────────────────────────────────────────

describe('parseScheduleAOA', () => {
  const BASE_OPTS = {
    year: 2026, month: 5,
    employees: [{ id: 'E001' }, { id: 'E002' }],
    shiftTypes: SHIFT_TYPES,
  };

  it('AOA 太短 → errors', () => {
    const r = parseScheduleAOA({
      ...BASE_OPTS,
      aoa: [['title']],
    });
    expect(r.rows.length).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0].message).toMatch(/結構錯誤/);
  });

  it('header 缺日期欄位 → errors', () => {
    const aoa = [
      ['title'],
      ['員工編號', '姓名', '班型', '5/1', '5/2'], // 只有 2 天、不夠 5 月 31 天
      [], [], [],
      ['E001', '小明', '', '一般日班'], // 一筆員工資料、讓 length check 過、留 header check 觸發
    ];
    const r = parseScheduleAOA({ ...BASE_OPTS, aoa });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].message).toMatch(/header 缺欄位/);
  });

  it('員工編號為空 → 整列跳過、不報錯不算 total', () => {
    const aoa = aoaWithEmpRows(2026, 5,
      empRow('', '', { 1: '一般日班' }),  // 空 emp id
      empRow('E001', '小明', { 1: '一般日班' }),
    );
    const r = parseScheduleAOA({ ...BASE_OPTS, aoa });
    expect(r.errors.length).toBe(0);
    expect(r.total).toBe(1);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].employee_id).toBe('E001');
  });

  it('員工編號不存在 → error、不寫入 row', () => {
    const aoa = aoaWithEmpRows(2026, 5,
      empRow('E999', '不存在', { 1: '一般日班' }),
    );
    const r = parseScheduleAOA({ ...BASE_OPTS, aoa });
    expect(r.rows.length).toBe(0);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].message).toMatch(/員工不存在.*E999/);
  });

  it('alias 識別正確：休 / 例 / D / 中班 / 夜班 / 國定', () => {
    const aoa = aoaWithEmpRows(2026, 5,
      empRow('E001', '小明', {
        1: '休', 2: '休假日', 3: '例', 4: '例假日',
        5: '一般日班', 6: '日班', 7: 'D',
        8: '中班', 9: '夜班', 10: '國定假日', 11: '國定',
      }),
    );
    const r = parseScheduleAOA({ ...BASE_OPTS, aoa });
    expect(r.errors).toEqual([]);
    expect(r.rows.length).toBe(11);
    const idByDate = Object.fromEntries(r.rows.map(x => [x.work_date, x.shift_type_id]));
    expect(idByDate['2026-05-01']).toBe('ST003'); // 休 → 休假
    expect(idByDate['2026-05-02']).toBe('ST003');
    expect(idByDate['2026-05-03']).toBe('ST004'); // 例 → 例假
    expect(idByDate['2026-05-05']).toBe('ST001'); // 一般日班
    expect(idByDate['2026-05-07']).toBe('ST001'); // D → 一般日班
    expect(idByDate['2026-05-08']).toBe('ST005'); // 中班
    expect(idByDate['2026-05-09']).toBe('ST007'); // 夜班
    expect(idByDate['2026-05-10']).toBe('ST008'); // 國定假日
  });

  it('「晚班」alias → ST006（過濾 is_active=false 的 ST002）', () => {
    const aoa = aoaWithEmpRows(2026, 5,
      empRow('E001', '小明', { 1: '晚班' }),
    );
    const r = parseScheduleAOA({ ...BASE_OPTS, aoa });
    expect(r.errors).toEqual([]);
    expect(r.rows[0].shift_type_id).toBe('ST006'); // 不是 ST002
  });

  it('未知 name → error、不寫入', () => {
    const aoa = aoaWithEmpRows(2026, 5,
      empRow('E001', '小明', { 1: '不存在的班別 XYZ' }),
    );
    const r = parseScheduleAOA({ ...BASE_OPTS, aoa });
    expect(r.rows.length).toBe(0);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].message).toMatch(/不認得班別/);
  });

  it('多段 cell（含 +）→ error、不寫入', () => {
    const aoa = aoaWithEmpRows(2026, 5,
      empRow('E001', '小明', { 1: '一般日班+晚班' }),
    );
    const r = parseScheduleAOA({ ...BASE_OPTS, aoa });
    expect(r.rows.length).toBe(0);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].message).toMatch(/多段排班/);
  });

  it('空白 cell → 不寫入、不報錯', () => {
    const aoa = aoaWithEmpRows(2026, 5,
      empRow('E001', '小明', { 1: '休', 5: '', 10: '   ', 15: null }),
    );
    const r = parseScheduleAOA({ ...BASE_OPTS, aoa });
    expect(r.errors).toEqual([]);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].work_date).toBe('2026-05-01');
  });

  it('is_off 班別 → 寫入 note=__OFF__ + status=confirmed', () => {
    const aoa = aoaWithEmpRows(2026, 5,
      empRow('E001', '小明', { 1: '休', 2: '一般日班' }),
    );
    const r = parseScheduleAOA({ ...BASE_OPTS, aoa });
    expect(r.rows[0].is_off).toBe(true);
    expect(r.rows[0].note).toBe('__OFF__');
    expect(r.rows[0].status).toBe('confirmed');
    expect(r.rows[0].segment_no).toBe(1);
    expect(r.rows[1].is_off).toBe(false);
    expect(r.rows[1].note).toBeUndefined();
  });

  it('多員工 + 多 cell：rows 完整、total 算 row 數', () => {
    const aoa = aoaWithEmpRows(2026, 5,
      empRow('E001', '小明', { 1: '休', 2: '休', 3: '一般日班' }),
      empRow('E002', '小美', { 1: '一般日班', 2: '中班' }),
    );
    const r = parseScheduleAOA({ ...BASE_OPTS, aoa });
    expect(r.errors).toEqual([]);
    expect(r.rows.length).toBe(5);
    expect(r.total).toBe(2);
  });

  it('row/col 1-indexed（給人看）', () => {
    const aoa = aoaWithEmpRows(2026, 5,
      empRow('E001', '小明', { 1: 'XYZ' }),
    );
    const r = parseScheduleAOA({ ...BASE_OPTS, aoa });
    expect(r.errors[0].row).toBe(6); // 員工 row 起於 index 5、人類看是 row 6
    expect(r.errors[0].col).toBe(4); // 5/1 在 index 3、人類看是 col 4
  });
});

// ─────────────────────────────────────────────────
// Round-trip：build → parse 應回到同樣的 schedules（單段）
// ─────────────────────────────────────────────────

describe('round-trip：build 後 parse 回來', () => {
  it('單段班別：build → parse 結果與輸入一致（員工 / 日期 / shift_type_id）', () => {
    const employees = [{ id: 'E001' }, { id: 'E002' }];
    const inputSchedules = [
      { employee_id: 'E001', work_date: '2026-05-01', shift_type_id: 'ST001',
        shift_types: { name: '一般日班' } },
      { employee_id: 'E001', work_date: '2026-05-03', shift_type_id: 'ST003',
        shift_types: { name: '休假' }, is_off: true },
      { employee_id: 'E002', work_date: '2026-05-05', shift_type_id: 'ST005',
        shift_types: { name: '中班' } },
    ];
    const built = buildScheduleAOA({
      year: 2026, month: 5, employees,
      schedules: inputSchedules,
      shiftTypes: SHIFT_TYPES,
    });

    const parsed = parseScheduleAOA({
      year: 2026, month: 5, employees,
      shiftTypes: SHIFT_TYPES,
      aoa: built.aoa,
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.length).toBe(3);

    const sig = (r) => `${r.employee_id}|${r.work_date}|${r.shift_type_id}`;
    const inSigs = inputSchedules.map(sig).sort();
    const outSigs = parsed.rows.map(sig).sort();
    expect(outSigs).toEqual(inSigs);
  });
});

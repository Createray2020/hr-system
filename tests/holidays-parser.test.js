import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseGovHolidays } from '../lib/holidays/parser.js';

describe('parseGovHolidays', () => {
  let warnSpy;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('回傳空陣列當輸入不是 array', () => {
    expect(parseGovHolidays(null, 2026)).toEqual([]);
    expect(parseGovHolidays({}, 2026)).toEqual([]);
    expect(parseGovHolidays(undefined, 2026)).toEqual([]);
  });

  it('正確 parse 標準年度資料（中文欄位）', () => {
    const raw = [
      { '西元日期': '20260101', '名稱': '中華民國開國紀念日', '是否放假': '是', '備註': '' },
      { '西元日期': '20260102', '名稱': '', '是否放假': '否', '備註': '' },
    ];
    const out = parseGovHolidays(raw, 2026);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      date: '2026-01-01',
      holiday_type: 'national',
      name: '中華民國開國紀念日',
      pay_multiplier: 2.00,
      source: 'imported',
      imported_from: 'data.gov.tw',
    });
  });

  it('正確 parse 英文欄位 schema', () => {
    const raw = [
      { date: '2026/02/28', description: '和平紀念日', isHoliday: true, note: null },
    ];
    const out = parseGovHolidays(raw, 2026);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2026-02-28');
    expect(out[0].holiday_type).toBe('national');
  });

  it('補行上班日正確識別（isHoliday=否 + 備註含「補上班」）', () => {
    const raw = [
      { '西元日期': '20260207', '名稱': '補行上班日', '是否放假': '否', '備註': '春節補行上班' },
    ];
    const out = parseGovHolidays(raw, 2026);
    expect(out).toHaveLength(1);
    expect(out[0].holiday_type).toBe('makeup_workday');
    expect(out[0].pay_multiplier).toBe(1.00);
  });

  it('彈性放假正確識別', () => {
    const raw = [
      { '西元日期': '20260216', '名稱': '春節彈性放假', '是否放假': '是', '備註': '彈性放假' },
    ];
    const out = parseGovHolidays(raw, 2026);
    expect(out).toHaveLength(1);
    expect(out[0].holiday_type).toBe('flexible');
    expect(out[0].pay_multiplier).toBe(1.00);
  });

  it('過濾掉非目標年度', () => {
    const raw = [
      { '西元日期': '20251231', '名稱': '前年元旦', '是否放假': '是' },
      { '西元日期': '20260101', '名稱': '當年元旦', '是否放假': '是' },
      { '西元日期': '20270101', '名稱': '隔年元旦', '是否放假': '是' },
    ];
    const out = parseGovHolidays(raw, 2026);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2026-01-01');
  });

  it('未知類型跳過（一般工作日 isHoliday=否 無備註）', () => {
    const raw = [
      { '西元日期': '20260105', '名稱': '', '是否放假': '否', '備註': '' },
    ];
    const out = parseGovHolidays(raw, 2026);
    expect(out).toHaveLength(0);
    // 工作日沒 description，不該 warn
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('有 description 但無法分類 → 跳過 + warn', () => {
    const raw = [
      // isHoliday 未提供，且 description / 備註都不含關鍵字 → warn
      { '西元日期': '20260601', '名稱': '某種特殊日子' },
    ];
    const out = parseGovHolidays(raw, 2026);
    expect(out).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('同日重複資料只回一筆（dedupe）', () => {
    const raw = [
      { '西元日期': '20260101', '名稱': '元旦', '是否放假': '是' },
      { '西元日期': '2026-01-01', '名稱': '元旦', '是否放假': '是' },
      { '西元日期': '2026/01/01', '名稱': '元旦重複', '是否放假': '是' },
    ];
    const out = parseGovHolidays(raw, 2026);
    expect(out).toHaveLength(1);
  });

  it('日期格式容忍：8 碼數字、斜線、連字號都接受', () => {
    const raw = [
      { '西元日期': '20260101', '名稱': '元旦', '是否放假': '是' },
      { '西元日期': '2026/02/28', '名稱': '和平紀念日', '是否放假': '是' },
      { '西元日期': '2026-04-04', '名稱': '兒童節', '是否放假': '是' },
    ];
    const out = parseGovHolidays(raw, 2026);
    expect(out.map(r => r.date).sort()).toEqual([
      '2026-01-01', '2026-02-28', '2026-04-04',
    ]);
  });

  it('無效日期格式 → 跳過', () => {
    const raw = [
      { '西元日期': '2026', '名稱': '無效日期', '是否放假': '是' },
      { '西元日期': null, '名稱': 'null 日期', '是否放假': '是' },
      { '西元日期': '20260101', '名稱': '元旦', '是否放假': '是' },
    ];
    const out = parseGovHolidays(raw, 2026);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2026-01-01');
  });

  it('回傳 row 含完整欄位（給 supabase INSERT 用）', () => {
    const raw = [
      { '西元日期': '20261010', '名稱': '國慶日', '是否放假': '是', '備註': '中華民國國慶日' },
    ];
    const out = parseGovHolidays(raw, 2026);
    expect(out[0]).toEqual({
      date: '2026-10-10',
      holiday_type: 'national',
      name: '國慶日',
      description: '中華民國國慶日',
      pay_multiplier: 2.00,
      source: 'imported',
      imported_from: 'data.gov.tw',
    });
  });

  // ── Google Calendar CSV 格式（data.gov.tw 14718 _Google行事曆專用）─────
  // 欄位：Subject, Start Date, Start Time, End Date, End Time, All Day Event, Description, Location

  it('Google Calendar 格式：Subject + Start Date 2026/1/1 + All Day Event True → national', () => {
    const raw = [
      { 'Subject': '開國紀念日', 'Start Date': '2026/1/1', 'All Day Event': 'True', 'Description': '' },
    ];
    const out = parseGovHolidays(raw, 2026);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      date: '2026-01-01',
      holiday_type: 'national',
      name: '開國紀念日',
      pay_multiplier: 2.00,
    });
  });

  it('Google Calendar Subject="補假" → national（不是 makeup_workday）', () => {
    const raw = [
      { 'Subject': '補假', 'Start Date': '2026/2/16', 'All Day Event': 'True' },
    ];
    const out = parseGovHolidays(raw, 2026);
    expect(out).toHaveLength(1);
    expect(out[0].holiday_type).toBe('national');
    expect(out[0].name).toBe('補假');
  });

  it('Google Calendar Subject="例假日" → 跳過 + 不 warn（每個週六日不是國定假日）', () => {
    const raw = [
      { 'Subject': '例假日', 'Start Date': '2026/1/3', 'All Day Event': 'True' },
      { 'Subject': '例假日', 'Start Date': '2026/1/4', 'All Day Event': 'True' },
    ];
    const out = parseGovHolidays(raw, 2026);
    expect(out).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('Google Calendar 空 row（Subject="" Start Date=""）→ 跳過、不 throw', () => {
    const raw = [
      { 'Subject': '', 'Start Date': '', 'All Day Event': '' },
      { 'Subject': '開國紀念日', 'Start Date': '2026/1/1', 'All Day Event': 'True' },
    ];
    const out = parseGovHolidays(raw, 2026);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('開國紀念日');
  });

  it('日期格式 normalize：2026/1/1 / 2026-01-01 / 20260101 三種都 → 2026-01-01', () => {
    expect(parseGovHolidays(
      [{ 'Subject': '甲', 'Start Date': '2026/1/1', 'All Day Event': 'True' }], 2026
    )[0].date).toBe('2026-01-01');
    expect(parseGovHolidays(
      [{ 'Subject': '乙', 'Start Date': '2026-01-01', 'All Day Event': 'True' }], 2026
    )[0].date).toBe('2026-01-01');
    expect(parseGovHolidays(
      [{ '西元日期': '20260101', '名稱': '丙', '是否放假': '是' }], 2026
    )[0].date).toBe('2026-01-01');
  });
});

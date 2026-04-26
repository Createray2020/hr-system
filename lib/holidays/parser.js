// lib/holidays/parser.js — data.gov.tw 政府開放資料 parser
//
// 純函式：輸入 raw JSON，輸出 holidays 表的 row 陣列。
// 不做 I/O、不依賴 supabase；可單元測試。
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.1.1
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §4.2
//
// 政府公告類型映射：
//   國定假日 / 紀念日 / 節日   → national       (pay_multiplier 2.00)
//   補行上班                    → makeup_workday (pay_multiplier 1.00)
//   彈性放假                    → flexible       (pay_multiplier 1.00)
//   不認識的類型                → 跳過 + console.warn

/**
 * Parse raw data.gov.tw 行政機關辦公日曆表 records.
 * Tolerates two common shapes: 中文欄位（西元日期 / 名稱 / 是否放假 / 備註）
 * 與英文欄位（date / description / isHoliday / note）。
 *
 * @param {Array<Object>} rawData  data.gov.tw 回傳的原始陣列
 * @param {number|string} year     只保留此年度的資料
 * @returns {Array<Object>}        holidays 表 row 陣列（已 dedupe）
 */
export function parseGovHolidays(rawData, year) {
  if (!Array.isArray(rawData)) return [];
  const targetYear = String(year);

  const seen = new Map();
  for (const raw of rawData) {
    const date = normalizeDate(raw);
    if (!date || date.slice(0, 4) !== targetYear) continue;

    const type = mapHolidayType(raw);
    if (!type) {
      // 跳過不認識的類型（例如普通工作日 isHoliday=否 且非補班）
      const desc = pickDescription(raw);
      if (isExplicitlyUnknown(raw)) {
        // 只有 raw 看起來「應該被識別但無法分類」才 warn，避免每筆工作日都 warn
        // eslint-disable-next-line no-console
        console.warn('[parseGovHolidays] unknown type, skipped:', date, desc);
      }
      continue;
    }

    if (seen.has(date)) continue; // dedupe by date

    const name = pickDescription(raw) || '未命名假日';
    const note = pickNote(raw);

    seen.set(date, {
      date,
      holiday_type: type,
      name,
      description: note || null,
      pay_multiplier: type === 'national' ? 2.00 : 1.00,
      source: 'imported',
      imported_from: 'data.gov.tw',
    });
  }

  return [...seen.values()];
}

// ── 內部 helpers ─────────────────────────────────────────────

function normalizeDate(row) {
  const raw = row.date ?? row['西元日期'] ?? row.Date ?? null;
  if (raw == null) return null;
  const s = String(raw).trim();
  // Accept "2026/01/01"、"2026-01-01"、"20260101"
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function pickDescription(row) {
  return row.description ?? row['名稱'] ?? row.name ?? '';
}

function pickNote(row) {
  return row['備註'] ?? row.note ?? row.holidayCategory ?? null;
}

function pickIsHoliday(row) {
  return row.isHoliday ?? row['是否放假'] ?? row.is_holiday ?? null;
}

function isHolidayValue(v) {
  if (v === true) return true;
  if (v == null) return null; // 未提供
  const s = String(v).trim();
  if (s === '是' || s === 'true' || s === '1') return true;
  if (s === '否' || s === 'false' || s === '0') return false;
  return null;
}

function mapHolidayType(row) {
  const isHoliday = isHolidayValue(pickIsHoliday(row));
  const desc = pickDescription(row);
  const note = pickNote(row) || '';
  const all = `${desc} ${note}`;

  // 補行上班日：原 dataset 標 isHoliday=否 但備註含「補行上班」
  if (isHoliday === false) {
    if (/補.{0,3}上班|補班/.test(all)) return 'makeup_workday';
    return null; // 一般工作日，不收
  }

  // 放假日：再分 national vs flexible
  if (isHoliday === true) {
    if (/彈性放假|調整放假|彈性休假/.test(all)) return 'flexible';
    return 'national';
  }

  // isHoliday 未提供 → 看備註關鍵字推斷
  if (/紀念日|節日|國定假日/.test(all)) return 'national';
  if (/彈性放假|彈性休假/.test(all)) return 'flexible';
  if (/補.{0,3}上班|補班/.test(all)) return 'makeup_workday';

  return null;
}

// 「看起來該被識別但失敗」：有 description 但無法分類 → 值得 warn
function isExplicitlyUnknown(row) {
  const desc = pickDescription(row);
  return !!desc && desc !== '';
}

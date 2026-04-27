// api/holidays/import.js
// POST /api/holidays/import { year, rows } → HR/admin 上傳 CSV-parsed 列匯入該年度國定假日
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.1.1
//
// 流程：
//   1. body 拿 year + rows（前端解析 CSV 後的 raw row 陣列）
//   2. lib/holidays/parser.js 過濾、辨別類型、dedupe
//   3. 0 筆直接 return warning，未動 DB
//   4. upsert 新資料，imported_at = batchAt，onConflict (date, holiday_type)
//   5. DELETE source='imported' AND year=y AND imported_at < batchAt（清舊 stale）
//   6. 回 { imported, deleted, errors }
//
// 為何 upsert 後 DELETE：supabase-js v2 沒 cross-call transaction，先 upsert
// 後 DELETE 最差留 stale row，不會空狀態。
//
// 從 data.gov.tw fetch 改成 CSV upload 的原因：
// 原本 fetch endpoint URL（data.gov.tw/api/v1/rest/datastore/14718）為 placeholder、
// 從未驗證過、prod 上一直回 fetch_failed。改成 HR 自己從 data.gov.tw dataset 14718
// 下載 CSV、上傳到本系統，後端用同一支 parser 處理。

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { parseGovHolidays } from '../../lib/holidays/parser.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const { year, rows } = req.body || {};
  const y = parseInt(year);
  if (!Number.isInteger(y) || y < 1900 || y > 2999) {
    return res.status(400).json({ error: 'year required (integer 1900-2999)' });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows must be a non-empty array' });
  }

  // ── 1. parse ────────────────────────────────────────────────
  const parsed = parseGovHolidays(rows, y);
  if (parsed.length === 0) {
    return res.status(200).json({
      imported: 0,
      deleted: 0,
      warning: `parser 解析後 0 筆。可能 CSV 欄位不認得、或都不屬於 ${y} 年度`,
    });
  }

  // ── 2. upsert（保持 parser 的 imported_from='data.gov.tw'）─────
  const batchAt = new Date().toISOString();
  const toInsert = parsed.map(r => ({
    ...r,
    imported_at: batchAt,
    created_by: caller.id || null,
  }));
  const { data, error: insErr } = await supabaseAdmin
    .from('holidays')
    .upsert(toInsert, { onConflict: 'date,holiday_type' })
    .select();
  if (insErr) return res.status(500).json({ error: 'insert_failed', detail: insErr.message });

  // ── 3. 清舊 imported（imported_at < batchAt）─────────────────
  const { count: deletedCount, error: delErr } = await supabaseAdmin
    .from('holidays')
    .delete({ count: 'exact' })
    .eq('source', 'imported')
    .gte('date', `${y}-01-01`)
    .lte('date', `${y}-12-31`)
    .lt('imported_at', batchAt);
  if (delErr) {
    return res.status(200).json({
      imported: data?.length || 0,
      deleted: 0,
      warning: '新資料已寫入，但清理舊 imported 失敗（可能殘留 stale row，重匯即可清掉）',
      detail: delErr.message,
    });
  }

  return res.status(200).json({
    imported: data?.length || 0,
    deleted: deletedCount || 0,
    errors: [],
  });
}

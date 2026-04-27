// api/holidays/import.js
// POST /api/holidays/import { year } → HR/admin 從 data.gov.tw 匯入該年度國定假日
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.1.1
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §4.4
//
// 流程：
//   1. fetch data.gov.tw 該年度行政機關辦公日曆表（fail 直接 return，未動 DB）
//   2. parser.js 解析（0 筆直接 return，未動 DB）
//   3. upsert 新資料，imported_at = batchAt，onConflict (date, holiday_type)
//   4. DELETE source='imported' AND year=y AND imported_at < batchAt（清舊 stale）
//   5. 回 { imported, deleted, errors }
//
// 為何 upsert 後 DELETE（非直觀的 DELETE→INSERT）：
//   supabase-js v2 沒有 cross-call transaction。若先 DELETE 後 INSERT 而 INSERT
//   失敗，會留下「該年 imported 空狀態」。改成先 upsert 後 DELETE，最差情況
//   只是多殘留幾筆 stale row（用戶重 import 即可清掉），不會空狀態。
//
// 已知未處理邊界（不在此檔 scope，須上層另議）：
//   - 新 imported 跟既有 source='manual' 撞同 (date, holiday_type)：
//     upsert 預設 update 會覆寫 manual。原版 INSERT 在此 case 會 fail；
//     兩者都需 manual-protection 邏輯，本次不擴大 scope。
//   - 舊 imported row 的 imported_at 若為 NULL，step 4 過濾不到會殘留 stale。
//
// TODO（Batch 10 上 prod 前確認）：data.gov.tw dataset 14718「行政機關辦公日曆表」
// 的 API endpoint 與年度切換方式可能改版。目前以下 URL 為佔位／猜測值，
// 需 Ray 上 prod 前手動驗證一次（用瀏覽器打開 URL、確認回的是該年度 JSON）：
//
//   https://www.dgpa.gov.tw/uploadFile/dgpa/{year}/{filename}.json
//   https://data.ntpc.gov.tw/api/datasets/308DCD75-6434-45BC-A95F-584DA4FED251/json
//
// 若上 prod 時 fetch 失敗或格式變更，HR 可改走「手動新增」與 Excel 匯入（未來可加）。
import { supabase } from '../../lib/supabase.js';
import { requireRole } from '../../lib/auth.js';
import { parseGovHolidays } from '../../lib/holidays/parser.js';

const DATA_GOV_TW_URL_TEMPLATE =
  process.env.HOLIDAYS_DATA_GOV_URL ||
  'https://data.gov.tw/api/v1/rest/datastore/14718?year={year}'; // TODO: 實際 endpoint 待確認

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, ['hr', 'admin', 'ceo']);
  if (!caller) return;

  const { year } = req.body || {};
  const y = parseInt(year);
  if (!Number.isInteger(y) || y < 1900 || y > 2999) {
    return res.status(400).json({ error: 'year required (integer 1900-2999)' });
  }

  // ── 1. fetch ────────────────────────────────────────────────
  const url = DATA_GOV_TW_URL_TEMPLATE.replace('{year}', String(y));
  let raw;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) {
      return res.status(502).json({
        error: 'fetch_failed',
        detail: `data.gov.tw returned ${r.status}`,
        url,
      });
    }
    raw = await r.json();
    // 部分 data.gov.tw API 回 { result: { records: [...] } } 之類結構，先嘗試展開
    if (raw && !Array.isArray(raw)) {
      raw = raw.result?.records || raw.records || raw.data || raw;
    }
  } catch (e) {
    return res.status(502).json({ error: 'fetch_failed', detail: e.message, url });
  }

  // ── 2. parse ────────────────────────────────────────────────
  const rows = parseGovHolidays(raw, y);
  if (rows.length === 0) {
    return res.status(200).json({
      imported: 0,
      deleted: 0,
      warning: 'parser 解析後 0 筆。可能 data.gov.tw 格式變更或該年度尚未公布',
      url,
    });
  }

  // ── 3. upsert new rows first (safer than DELETE→INSERT, see header) ─
  const batchAt = new Date().toISOString();
  const toInsert = rows.map(r => ({
    ...r,
    imported_at: batchAt,
    created_by: caller.id || null,
  }));
  const { data, error: insErr } = await supabase
    .from('holidays')
    .upsert(toInsert, { onConflict: 'date,holiday_type' })
    .select();
  if (insErr) return res.status(500).json({ error: 'insert_failed', detail: insErr.message });

  // ── 4. delete stale imported rows for this year ─────────────
  // imported_at < batchAt 排除「剛剛這批 upsert 的」（剛 upsert 的 imported_at = batchAt）。
  // 此步驟失敗不影響新資料正確性（資料已寫入），回 200 + warning 即可。
  const { count: deletedCount, error: delErr } = await supabase
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
      warning: '新資料已寫入，但清理舊 imported 失敗（可能殘留 stale row，重新匯入即可）',
      detail: delErr.message,
      url,
    });
  }

  return res.status(200).json({
    imported: data?.length || 0,
    deleted: deletedCount || 0,
    errors: [],
    url,
  });
}

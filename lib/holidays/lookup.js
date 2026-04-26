// lib/holidays/lookup.js — 國定假日查詢
//
// 純函式（接收 repo 介面，不直接依賴 supabase），可單元測試。
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.1.1
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §4.3

/**
 * Repo 介面契約（呼叫方需提供）：
 *   findHolidayByDate(date: string): Promise<{
 *     id: number,
 *     holiday_type: string,
 *     pay_multiplier: number,
 *   } | null>
 *
 * date 格式：'YYYY-MM-DD'
 */

/**
 * 查某天是否為國定假日。
 *
 * @param {Object} repo  需提供 findHolidayByDate(date)
 * @param {string} date  'YYYY-MM-DD'
 * @returns {Promise<{
 *   isHoliday: boolean,
 *   holiday_type?: string,
 *   pay_multiplier?: number,
 *   holiday_id?: number,
 * }>}
 */
export async function getHolidayInfo(repo, date) {
  if (!repo || typeof repo.findHolidayByDate !== 'function') {
    throw new Error('repo.findHolidayByDate is required');
  }
  if (!date) return { isHoliday: false };

  const row = await repo.findHolidayByDate(date);
  if (!row) return { isHoliday: false };

  return {
    isHoliday: true,
    holiday_type: row.holiday_type,
    pay_multiplier: Number(row.pay_multiplier),
    holiday_id: row.id,
  };
}

/**
 * 建立一個基於 supabase 的 repo（在 API handler 用）。
 * 純 helper，不必走測試覆蓋（測試 lookup 時自己 mock repo）。
 */
export function createSupabaseHolidayRepo(supabase) {
  return {
    async findHolidayByDate(date) {
      const { data, error } = await supabase
        .from('holidays')
        .select('id, holiday_type, pay_multiplier')
        .eq('date', date)
        .order('holiday_type', { ascending: true })  // 同日多筆時取第一筆（依設計 UNIQUE(date, holiday_type) 多筆罕見）
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },
  };
}

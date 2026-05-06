// GPS Phase A:geofence 驗證純函式(pure functions、無 I/O、可隔離測)
// 用於 lib/attendance/clock.js 在 clockIn / clockOut 寫入 attendance row 的 GPS 欄位前
// 驗證打卡座標是否在公司據點 radius 內、並標記 gps_flag。
//
// Phase A:所有 caller 都用 mode='soft'(純記錄、不擋打卡)
// Phase B:切 mode='hard'(超出 radius 擋打卡)

const EARTH_RADIUS_M = 6371000;
const LOW_ACCURACY_THRESHOLD_M = 100;

/**
 * Haversine 球面三角:兩點 lat/lng 距離(meters、float)。
 * 任一輸入為 null / undefined / NaN → 回 NaN(caller 自己檢)。
 *
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} meters
 */
export function haversineMeters(lat1, lng1, lat2, lng2) {
  if (!Number.isFinite(lat1) || !Number.isFinite(lng1) ||
      !Number.isFinite(lat2) || !Number.isFinite(lng2)) {
    return NaN;
  }
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * 在 locations 清單中找最近的據點。
 *
 * @param {number} lat
 * @param {number} lng
 * @param {Array<{ id, lat, lng, radius_m, ... }>} locations
 * @returns {{ location, distance_m } | null}
 */
export function findNearestLocation(lat, lng, locations) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (!Array.isArray(locations) || locations.length === 0) return null;

  let best = null;
  for (const loc of locations) {
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) continue;
    const d = haversineMeters(lat, lng, loc.lat, loc.lng);
    if (!Number.isFinite(d)) continue;
    if (best === null || d < best.distance_m) {
      best = { location: loc, distance_m: d };
    }
  }
  return best;
}

/**
 * 整合驗證:lat/lng 缺、accuracy 低、findNearest、radius 比對。
 *
 * flag 優先級(第一個命中為準):
 *   a. lat 或 lng 缺 → 'denied'   (location_id=null, distance_m=null)
 *   b. accuracy > 100 → 'low_accuracy' (仍 findNearest 填 location_id / distance_m)
 *   c. distance_m > location.radius_m → 'outside'
 *   d. 在 radius 內 → null
 *   特殊:locations 空 → 'outside'(沒據點可比、視為 outside)
 *
 * mode='soft' → ok 永遠 true(Phase A 不擋打卡、純記錄)
 * mode='hard' → flag === null 才 ok=true(Phase B 才切)
 *
 * @param {{ lat, lng, accuracy?, locations, mode? }} args
 * @returns {{ ok: boolean, location_id: string|null, distance_m: number|null, flag: string|null }}
 */
export function validateGeofence({ lat, lng, accuracy, locations, mode = 'soft' }) {
  // 先算 flag + location_id + distance_m,再依 mode 算 ok
  let flag = null;
  let location_id = null;
  let distance_m = null;

  // a. denied:座標缺
  if (lat == null || lng == null) {
    flag = 'denied';
  } else {
    // 嘗試找最近據點(low_accuracy 也仍嘗試填、給 audit 用)
    const nearest = findNearestLocation(lat, lng, locations);
    if (nearest) {
      location_id = nearest.location.id ?? null;
      distance_m  = nearest.distance_m;
    }

    // b. low_accuracy(優先於 outside、accuracy 不準時 outside 判斷可能誤判)
    if (accuracy != null && Number.isFinite(accuracy) && accuracy > LOW_ACCURACY_THRESHOLD_M) {
      flag = 'low_accuracy';
    } else if (!nearest) {
      // c'. 沒據點(空 array / 全 invalid)→ 視為 outside
      flag = 'outside';
    } else if (distance_m > (nearest.location.radius_m ?? 0)) {
      // c. outside
      flag = 'outside';
    }
    // d. 在 radius 內 → flag 維持 null
  }

  // mode 決定 ok
  const ok = mode === 'hard' ? (flag === null) : true;

  return { ok, location_id, distance_m, flag };
}

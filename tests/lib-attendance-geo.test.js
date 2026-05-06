// tests/lib-attendance-geo.test.js — GPS Phase A geo helper 單測
//
// 對齊 lib/attendance/clock.js 風格(純函式、無 I/O)。

import { describe, it, expect } from 'vitest';
import {
  haversineMeters,
  findNearestLocation,
  validateGeofence,
} from '../lib/attendance/geo.js';

// 真實座標 fixture
const TAIPEI_101    = { lat: 25.0339, lng: 121.5645 };
const TAICHUNG_STA  = { lat: 24.1369, lng: 120.6852 };

// 公司據點 fixture
const HQ        = { id: 'LOC_HQ',    name: '總公司',   lat: 25.0339, lng: 121.5645, radius_m: 150 };
const BRANCH_TC = { id: 'LOC_TC',    name: '台中分部', lat: 24.1369, lng: 120.6852, radius_m: 200 };
const FACTORY   = { id: 'LOC_FAC',   name: '工廠',     lat: 24.0500, lng: 120.7000, radius_m: 100 };

// ════════════════════════════════════════════════════════════
// haversineMeters
// ════════════════════════════════════════════════════════════
describe('haversineMeters', () => {
  it('同點 → 0(精度 < 0.01m)', () => {
    expect(haversineMeters(25.033, 121.565, 25.033, 121.565)).toBeLessThan(0.01);
  });

  it('台北 101 ↔ 台中車站 ≈ 134 km 直線(容差 ±3 km、車程 150 但直線短)', () => {
    const d = haversineMeters(
      TAIPEI_101.lat, TAIPEI_101.lng,
      TAICHUNG_STA.lat, TAICHUNG_STA.lng
    );
    expect(d).toBeGreaterThan(131000);
    expect(d).toBeLessThan(137000);
  });

  it('反向參數對稱(A→B = B→A)', () => {
    const ab = haversineMeters(TAIPEI_101.lat, TAIPEI_101.lng, TAICHUNG_STA.lat, TAICHUNG_STA.lng);
    const ba = haversineMeters(TAICHUNG_STA.lat, TAICHUNG_STA.lng, TAIPEI_101.lat, TAIPEI_101.lng);
    expect(ab).toBeCloseTo(ba, 6);
  });

  it('lat=null → NaN', () => {
    expect(haversineMeters(null, 121.5, 25, 121.5)).toBeNaN();
  });

  it('任一輸入 undefined / NaN → NaN', () => {
    expect(haversineMeters(undefined, 121.5, 25, 121.5)).toBeNaN();
    expect(haversineMeters(25, NaN, 25, 121.5)).toBeNaN();
    expect(haversineMeters(25, 121.5, NaN, 121.5)).toBeNaN();
  });
});

// ════════════════════════════════════════════════════════════
// findNearestLocation
// ════════════════════════════════════════════════════════════
describe('findNearestLocation', () => {
  it('3 個據點、最近的回傳對(站在 HQ 旁、最近=HQ)', () => {
    // 站在 HQ 50m 外
    const r = findNearestLocation(25.0344, 121.5645, [HQ, BRANCH_TC, FACTORY]);
    expect(r).not.toBeNull();
    expect(r.location.id).toBe('LOC_HQ');
    expect(r.distance_m).toBeLessThan(100);
  });

  it('站在台中、最近 = BRANCH_TC', () => {
    const r = findNearestLocation(24.1370, 120.6850, [HQ, BRANCH_TC, FACTORY]);
    expect(r.location.id).toBe('LOC_TC');
  });

  it('空陣列 → null', () => {
    expect(findNearestLocation(25, 121.5, [])).toBeNull();
  });

  it('null locations → null', () => {
    expect(findNearestLocation(25, 121.5, null)).toBeNull();
  });

  it('null lat → null', () => {
    expect(findNearestLocation(null, 121.5, [HQ])).toBeNull();
  });

  it('distance_m 等於 haversineMeters 結果', () => {
    const target = { lat: 25.0344, lng: 121.5650 };
    const r = findNearestLocation(target.lat, target.lng, [HQ]);
    const expected = haversineMeters(target.lat, target.lng, HQ.lat, HQ.lng);
    expect(r.distance_m).toBe(expected);
  });

  it('locations 內含 invalid lat/lng 的 → 跳過、不影響其他', () => {
    const broken = { id: 'BROKEN', lat: null, lng: null, radius_m: 100 };
    const r = findNearestLocation(25.0344, 121.5645, [broken, HQ]);
    expect(r.location.id).toBe('LOC_HQ');
  });
});

// ════════════════════════════════════════════════════════════
// validateGeofence — soft mode(Phase A、ok 永遠 true)
// ════════════════════════════════════════════════════════════
describe('validateGeofence (mode=soft)', () => {
  const locations = [HQ, BRANCH_TC];

  it('lat=null → flag=denied、ok=true、location_id/distance 都 null', () => {
    const r = validateGeofence({ lat: null, lng: 121.5, accuracy: 20, locations });
    expect(r).toEqual({
      ok: true,
      location_id: null,
      distance_m: null,
      flag: 'denied',
    });
  });

  it('lng=null → flag=denied', () => {
    const r = validateGeofence({ lat: 25, lng: null, accuracy: 20, locations });
    expect(r.flag).toBe('denied');
    expect(r.ok).toBe(true);
  });

  it('accuracy=200 + 在 HQ radius 內 → flag=low_accuracy(優先於 null)、location_id 仍填', () => {
    // 站在 HQ 位置、accuracy 太差
    const r = validateGeofence({ lat: HQ.lat, lng: HQ.lng, accuracy: 200, locations });
    expect(r.flag).toBe('low_accuracy');
    expect(r.location_id).toBe('LOC_HQ');
    expect(r.distance_m).toBeGreaterThanOrEqual(0);
    expect(r.ok).toBe(true);
  });

  it('距 HQ 200m、HQ.radius_m=150 → flag=outside', () => {
    // HQ 是 25.0339, 121.5645;往北約 200m ≈ lat 加 0.0018
    const r = validateGeofence({
      lat: HQ.lat + 0.0018, lng: HQ.lng, accuracy: 20, locations,
    });
    expect(r.flag).toBe('outside');
    expect(r.location_id).toBe('LOC_HQ');
    expect(r.distance_m).toBeGreaterThan(150);
    expect(r.distance_m).toBeLessThan(250);
    expect(r.ok).toBe(true);
  });

  it('在 HQ radius 內 (50m) → flag=null、ok=true', () => {
    // HQ 北約 50m ≈ lat 加 0.00045
    const r = validateGeofence({
      lat: HQ.lat + 0.00045, lng: HQ.lng, accuracy: 15, locations,
    });
    expect(r.flag).toBeNull();
    expect(r.location_id).toBe('LOC_HQ');
    expect(r.distance_m).toBeLessThan(150);
    expect(r.ok).toBe(true);
  });

  it('locations 空 → flag=outside、location_id/distance 都 null、ok=true', () => {
    const r = validateGeofence({ lat: 25, lng: 121.5, accuracy: 20, locations: [] });
    expect(r).toEqual({
      ok: true,
      location_id: null,
      distance_m: null,
      flag: 'outside',
    });
  });

  it('accuracy 缺(undefined)→ 不觸發 low_accuracy、走 outside / null 判定', () => {
    const r = validateGeofence({ lat: HQ.lat, lng: HQ.lng, locations });
    expect(r.flag).toBeNull();   // 在 radius 內
  });
});

// ════════════════════════════════════════════════════════════
// validateGeofence — hard mode(Phase B、flag 才能 ok)
// ════════════════════════════════════════════════════════════
describe('validateGeofence (mode=hard)', () => {
  const locations = [HQ];

  it('在 radius 內 → ok=true', () => {
    const r = validateGeofence({
      lat: HQ.lat + 0.00045, lng: HQ.lng, accuracy: 15,
      locations, mode: 'hard',
    });
    expect(r.flag).toBeNull();
    expect(r.ok).toBe(true);
  });

  it('flag=denied → ok=false', () => {
    const r = validateGeofence({
      lat: null, lng: 121.5, accuracy: 20,
      locations, mode: 'hard',
    });
    expect(r.flag).toBe('denied');
    expect(r.ok).toBe(false);
  });

  it('flag=low_accuracy → ok=false', () => {
    const r = validateGeofence({
      lat: HQ.lat, lng: HQ.lng, accuracy: 200,
      locations, mode: 'hard',
    });
    expect(r.flag).toBe('low_accuracy');
    expect(r.ok).toBe(false);
  });

  it('flag=outside → ok=false', () => {
    const r = validateGeofence({
      lat: HQ.lat + 0.0018, lng: HQ.lng, accuracy: 20,
      locations, mode: 'hard',
    });
    expect(r.flag).toBe('outside');
    expect(r.ok).toBe(false);
  });

  it('locations 空 → flag=outside → ok=false', () => {
    const r = validateGeofence({
      lat: 25, lng: 121.5, accuracy: 20,
      locations: [], mode: 'hard',
    });
    expect(r.flag).toBe('outside');
    expect(r.ok).toBe(false);
  });
});

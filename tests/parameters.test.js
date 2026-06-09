// tests/parameters.test.js
// 抓 lib/salary/parameters.js getParam 純函式行為(Phase 3A)

import { describe, it, expect } from 'vitest';
import { getParam, PARAM_KEY_SEP } from '../lib/salary/parameters.js';

describe('getParam', () => {
  it('paramMap 命中對應 key → 回該值', () => {
    const m = new Map([
      ['labor_insurance:employee_rate', 0.025],
      ['pension:employer_mandatory_rate', 0.06],
    ]);
    expect(getParam(m, 'labor_insurance', 'employee_rate', 0.023)).toBe(0.025);
    expect(getParam(m, 'pension', 'employer_mandatory_rate', 0.06)).toBe(0.06);
  });

  it('paramMap miss → 回 fallback', () => {
    const m = new Map([['labor_insurance:employee_rate', 0.023]]);
    expect(getParam(m, 'health_insurance', 'employee_rate', 0.01551)).toBe(0.01551);
  });

  it('paramMap=null / undefined → 回 fallback(防 DB 失聯)', () => {
    expect(getParam(null,      'pension', 'employer_mandatory_rate', 0.06)).toBe(0.06);
    expect(getParam(undefined, 'pension', 'employer_mandatory_rate', 0.06)).toBe(0.06);
  });

  it('paramMap 不是 Map(沒 .get)→ 回 fallback', () => {
    expect(getParam({},                            'pension', 'employer_mandatory_rate', 0.06)).toBe(0.06);
    expect(getParam({ get: 'not-a-function' },     'pension', 'employer_mandatory_rate', 0.06)).toBe(0.06);
    expect(getParam([['pension:employer_mandatory_rate', 0.07]], 'pension', 'employer_mandatory_rate', 0.06)).toBe(0.06);
  });

  it('值非有限數(NaN / Infinity / 字串無法轉換)→ 回 fallback', () => {
    const m = new Map([
      ['a:b', NaN],
      ['c:d', Infinity],
      ['e:f', 'abc'],
      ['g:h', null],
      ['i:j', undefined],
    ]);
    expect(getParam(m, 'a', 'b', 99)).toBe(99);
    expect(getParam(m, 'c', 'd', 99)).toBe(99);
    expect(getParam(m, 'e', 'f', 99)).toBe(99);
    expect(getParam(m, 'g', 'h', 99)).toBe(99);
    expect(getParam(m, 'i', 'j', 99)).toBe(99);
  });

  it('值是「可轉成數字」的字串 → 回 Number(該值)', () => {
    // supabase-js 通常 NUMERIC 回 number、但 NUMERIC TEXT 偶有字串
    const m = new Map([['a:b', '0.025']]);
    expect(getParam(m, 'a', 'b', 0.023)).toBe(0.025);
  });

  it('值是 0 → 回 0(合法的零、不視為 miss)', () => {
    const m = new Map([['a:b', 0]]);
    expect(getParam(m, 'a', 'b', 0.99)).toBe(0);
  });

  it('值是大數字 NTD → 原樣回(例:cap_per_payment 10000000)', () => {
    const m = new Map([['supplementary_health:cap_per_payment', 10000000]]);
    expect(getParam(m, 'supplementary_health', 'cap_per_payment', 1000000)).toBe(10000000);
  });

  it('PARAM_KEY_SEP exports ":"', () => {
    expect(PARAM_KEY_SEP).toBe(':');
  });
});

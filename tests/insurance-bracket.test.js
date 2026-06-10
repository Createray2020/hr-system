// tests/insurance-bracket.test.js
// 2026 法規勞健保純函式:級距 snap + 員工/雇主保費計算
// 對應 lib/salary/insurance-bracket.js

import { describe, it, expect, vi } from 'vitest';
import {
  loadInsuranceRates,
  computeLaborEmployee,
  computeHealthEmployee,
  computeLaborEmployer,
  computeHealthEmployer,
  snapFullTimeLaborBracket,
  snapFullTimeHealthBracket,
} from '../lib/salary/insurance-bracket.js';

const RATES_2026 = {
  laborOrdinaryEmp:  0.023,
  employmentInsEmp:  0.002,
  laborOrdinaryEr:   0.0805,
  employmentInsEr:   0.007,
  healthEmp:         0.01551,
  healthEr:          0.03102,
  healthAvgDep:      0.56,
  oaEr:              0,
};

// ─── computeLaborEmployee ─────────────────────────────────────────
describe('computeLaborEmployee — 勞保 + 就保 員工自付', () => {
  it('45800 + 就保適格 → 1145 (1053+92)', () => {
    // 45800*0.023=1053.4 round→1053;45800*0.002=91.6 round→92;sum=1145
    expect(computeLaborEmployee(45800, { employmentInsEligible: true }, RATES_2026)).toBe(1145);
  });

  it('45800 + 就保不適格 → 1053 (純勞保)', () => {
    expect(computeLaborEmployee(45800, { employmentInsEligible: false }, RATES_2026)).toBe(1053);
  });

  it('11100 + 適格 → 277 (255+22)', () => {
    // 11100*0.023=255.3→255; 11100*0.002=22.2→22; sum=277
    expect(computeLaborEmployee(11100, { employmentInsEligible: true }, RATES_2026)).toBe(277);
  });

  it('36300 + 適格 → 908 (835+73)', () => {
    // 36300*0.023=834.9→835; 36300*0.002=72.6→73; sum=908
    expect(computeLaborEmployee(36300, { employmentInsEligible: true }, RATES_2026)).toBe(908);
  });

  it('分項各自四捨五入再相加(不合併乘率)— 11100 案例驗算', () => {
    // 反例:若合併 0.025 × 11100 = 277.5 → round 278;與分項 277 差 1
    // 必須分項才能對齊勞保局
    const combined = Math.round(11100 * 0.025);
    expect(combined).toBe(278);
    expect(computeLaborEmployee(11100, { employmentInsEligible: true }, RATES_2026)).toBe(277);
  });

  it('insuredSalary=0 → 0', () => {
    expect(computeLaborEmployee(0, { employmentInsEligible: true }, RATES_2026)).toBe(0);
  });
});

// ─── computeHealthEmployee ────────────────────────────────────────
describe('computeHealthEmployee — 健保員工 + 眷屬乘數', () => {
  it('29500 + 0 眷屬 → 458', () => {
    // 29500*0.01551=457.545 → round 458;458*(0+1)=458
    expect(computeHealthEmployee(29500, 0, RATES_2026)).toBe(458);
  });

  it('29500 + 1 眷屬 → 916', () => {
    expect(computeHealthEmployee(29500, 1, RATES_2026)).toBe(916);
  });

  it('29500 + 5 眷屬 → 1832(上限 clamp 到 3)', () => {
    // 458 * (3+1) = 1832
    expect(computeHealthEmployee(29500, 5, RATES_2026)).toBe(1832);
  });

  it('36300 + 0 眷屬 → 563', () => {
    // 36300*0.01551=562.953 → round 563
    expect(computeHealthEmployee(36300, 0, RATES_2026)).toBe(563);
  });

  it('dependents=null → 視為 0', () => {
    expect(computeHealthEmployee(29500, null, RATES_2026)).toBe(458);
  });

  it('dependents 為負數 → clamp 為 0', () => {
    expect(computeHealthEmployee(29500, -1, RATES_2026)).toBe(458);
  });

  it('insuredSalary=0 → 0', () => {
    expect(computeHealthEmployee(0, 2, RATES_2026)).toBe(0);
  });
});

// ─── computeLaborEmployer ─────────────────────────────────────────
describe('computeLaborEmployer — 雇主端勞工三項合計(勞保+就保+職災)', () => {
  it('45800 + 適格 → 4008 (3687+321+0)', () => {
    // 45800*0.0805=3686.9→3687; 45800*0.007=320.6→321; 45800*0=0; sum=4008
    expect(computeLaborEmployer(45800, { employmentInsEligible: true }, RATES_2026)).toBe(4008);
  });

  it('45800 + 不適格 → 3687(就保 0)', () => {
    expect(computeLaborEmployer(45800, { employmentInsEligible: false }, RATES_2026)).toBe(3687);
  });

  it('職災率 > 0 也加總:oaEr=0.0021、45800 → 4008 + round(45800*0.0021=96.18)=96 = 4104', () => {
    const rates = { ...RATES_2026, oaEr: 0.0021 };
    expect(computeLaborEmployer(45800, { employmentInsEligible: true }, rates)).toBe(4104);
  });

  it('insuredSalary=0 → 0', () => {
    expect(computeLaborEmployer(0, { employmentInsEligible: true }, RATES_2026)).toBe(0);
  });
});

// ─── computeHealthEmployer ────────────────────────────────────────
describe('computeHealthEmployer — 雇主健保(含平均眷屬乘數)', () => {
  it('45800 → 2216(45800*0.03102*1.56)', () => {
    // 45800*0.03102=1420.716; *1.56=2216.31696; round 2216
    expect(computeHealthEmployer(45800, RATES_2026)).toBe(2216);
  });

  it('29500 → 1428(整體單次 round、非分項)', () => {
    // 29500*0.03102*1.56 = 1427.50... round 1428(實際 29500*0.03102=915.09;×1.56=1427.5404→1428)
    expect(computeHealthEmployer(29500, RATES_2026)).toBe(1428);
  });

  it('insuredSalary=0 → 0', () => {
    expect(computeHealthEmployer(0, RATES_2026)).toBe(0);
  });
});

// ─── loadInsuranceRates ───────────────────────────────────────────
describe('loadInsuranceRates — 從 salary_parameter_definitions 載入 8 個 key', () => {
  it('repo.getEffectiveParameters 提供完整 Map → 全部用 DB 值', async () => {
    const repo = {
      getEffectiveParameters: vi.fn(async () => new Map([
        ['labor_insurance:employee_rate',     0.023],
        ['employment_insurance:employee_rate', 0.002],
        ['labor_insurance:employer_rate',     0.0805],
        ['employment_insurance:employer_rate', 0.007],
        ['health_insurance:employee_rate',    0.01551],
        ['health_insurance:employer_rate',    0.03102],
        ['health_insurance:avg_dependents',   0.56],
        ['occupational_accident:employer_rate', 0.0021],
      ])),
    };
    const rates = await loadInsuranceRates(repo, { year: 2026, month: 5 });
    expect(rates).toEqual({
      laborOrdinaryEmp:  0.023,
      employmentInsEmp:  0.002,
      laborOrdinaryEr:   0.0805,
      employmentInsEr:   0.007,
      healthEmp:         0.01551,
      healthEr:          0.03102,
      healthAvgDep:      0.56,
      oaEr:              0.0021,
    });
  });

  it('repo 沒 getEffectiveParameters → fallback documented defaults + warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rates = await loadInsuranceRates({}, { year: 2026, month: 5 });
    expect(rates.laborOrdinaryEmp).toBe(0.023);
    expect(rates.employmentInsEmp).toBe(0.002);
    expect(rates.laborOrdinaryEr).toBe(0.0805);
    expect(rates.employmentInsEr).toBe(0.007);
    expect(rates.healthEmp).toBe(0.01551);
    expect(rates.healthEr).toBe(0.03102);
    expect(rates.healthAvgDep).toBe(0.56);
    expect(rates.oaEr).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('部分 key 缺漏 → 缺漏的走 fallback、有的用 DB', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repo = {
      getEffectiveParameters: vi.fn(async () => new Map([
        ['labor_insurance:employee_rate',     0.025],  // 假裝 DB 改了
        // 其他全缺
      ])),
    };
    const rates = await loadInsuranceRates(repo, { year: 2026, month: 5 });
    expect(rates.laborOrdinaryEmp).toBe(0.025);    // DB 值
    expect(rates.healthEmp).toBe(0.01551);          // fallback
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('asOfDate 是該月最後一天(對齊 calculator paramMap 慣例)', async () => {
    const repo = {
      getEffectiveParameters: vi.fn(async () => new Map()),
    };
    await loadInsuranceRates(repo, { year: 2026, month: 2 });
    expect(repo.getEffectiveParameters).toHaveBeenCalledWith('2026-02-28');

    await loadInsuranceRates(repo, { year: 2026, month: 12 });
    expect(repo.getEffectiveParameters).toHaveBeenCalledWith('2026-12-31');
  });
});

// ─── snapFullTimeLaborBracket ─────────────────────────────────────
describe('snapFullTimeLaborBracket — 全職勞保級距 snap', () => {
  // 模擬 prod 表(prod 撈到的 14 筆 0~48200)
  const mockLaborBrackets = [
    { bracket_level: 1,  monthly_wage_min:    0, monthly_wage_max: 26400, insured_salary: 26400 },
    { bracket_level: 2,  monthly_wage_min: 26401, monthly_wage_max: 27600, insured_salary: 27600 },
    { bracket_level: 3,  monthly_wage_min: 27601, monthly_wage_max: 28800, insured_salary: 28800 },
    { bracket_level: 4,  monthly_wage_min: 28801, monthly_wage_max: 30300, insured_salary: 30300 },
    { bracket_level: 5,  monthly_wage_min: 30301, monthly_wage_max: 31800, insured_salary: 31800 },
    { bracket_level: 6,  monthly_wage_min: 31801, monthly_wage_max: 33300, insured_salary: 33300 },
    { bracket_level: 7,  monthly_wage_min: 33301, monthly_wage_max: 34800, insured_salary: 34800 },
    { bracket_level: 8,  monthly_wage_min: 34801, monthly_wage_max: 36300, insured_salary: 36300 },
    { bracket_level: 13, monthly_wage_min: 43901, monthly_wage_max: 45800, insured_salary: 45800 },
  ];

  function makeRepo() {
    return {
      findLaborInsuranceBracketForWage: vi.fn(async (wage) => {
        const b = mockLaborBrackets.find(b => wage >= b.monthly_wage_min && wage <= b.monthly_wage_max);
        return b ? { insured_salary: b.insured_salary } : null;
      }),
    };
  }

  it('wage=33000 → 33300(第 6 級)', async () => {
    const repo = makeRepo();
    expect(await snapFullTimeLaborBracket(repo, 33000)).toBe(33300);
  });

  it('wage<29500 → 強制回最低投保 29500(全職 floor)', async () => {
    const repo = makeRepo();
    expect(await snapFullTimeLaborBracket(repo, 25000)).toBe(29500);
    expect(await snapFullTimeLaborBracket(repo, 0)).toBe(29500);
    expect(await snapFullTimeLaborBracket(repo, 29499)).toBe(29500);
  });

  it('wage=29500 → 走 bracket(目前表第 4 級 30300、屬合理級距)', async () => {
    const repo = makeRepo();
    expect(await snapFullTimeLaborBracket(repo, 29500)).toBe(30300);
  });

  it('找不到對應級距 → null(超出表範圍)', async () => {
    const repo = makeRepo();
    expect(await snapFullTimeLaborBracket(repo, 999999)).toBe(null);
  });
});

// ─── snapFullTimeHealthBracket ────────────────────────────────────
describe('snapFullTimeHealthBracket — 全職健保級距 snap', () => {
  const mockHealthBrackets = [
    { bracket_level: 1, monthly_wage_min:    0, monthly_wage_max: 26400, insured_salary: 26400 },
    { bracket_level: 4, monthly_wage_min: 28801, monthly_wage_max: 30300, insured_salary: 30300 },
    { bracket_level: 8, monthly_wage_min: 34801, monthly_wage_max: 36300, insured_salary: 36300 },
  ];

  function makeRepo() {
    return {
      findHealthInsuranceBracketForWage: vi.fn(async (wage) => {
        const b = mockHealthBrackets.find(b => wage >= b.monthly_wage_min && wage <= b.monthly_wage_max);
        return b ? { insured_salary: b.insured_salary } : null;
      }),
    };
  }

  it('wage=35000 → 36300(第 8 級)', async () => {
    const repo = makeRepo();
    expect(await snapFullTimeHealthBracket(repo, 35000)).toBe(36300);
  });

  it('wage<29500 → 29500(健保全職下限亦同步)', async () => {
    const repo = makeRepo();
    expect(await snapFullTimeHealthBracket(repo, 25000)).toBe(29500);
  });

  it('找不到對應級距 → null', async () => {
    const repo = makeRepo();
    expect(await snapFullTimeHealthBracket(repo, 999999)).toBe(null);
  });
});

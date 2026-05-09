-- 驗證 2.7: insurance_settings.pension_wage 全部 > 0(若 labor_ins_bracket > 0)

SELECT
  COUNT(*)                                                          AS total_rows,
  COUNT(*) FILTER (WHERE pension_wage > 0)                          AS with_pension_wage,
  COUNT(*) FILTER (WHERE pension_wage = 0 OR pension_wage IS NULL)  AS zero_or_null,
  COUNT(*) FILTER (WHERE labor_ins_bracket > 0
                   AND (pension_wage = 0 OR pension_wage IS NULL))  AS missing_should_be_filled
FROM insurance_settings;
-- expect: missing_should_be_filled = 0
-- (prod 已 hot fix 跑過、此 verify 是後續部署的安全網)

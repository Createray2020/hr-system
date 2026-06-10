// public/js/labels.js
// 前端中文顯示對應表（純 UI label，不影響任何狀態邏輯比較）
// 載入方式同 salary-breakdown.js：<script src="/js/labels.js"></script> → window.HRLabels
(function (global) {
  'use strict';

  // 薪資領域狀態：payroll_periods(6) + salary_records 列狀態(draft/confirmed/paid/locked)
  // 同屬「薪資」領域、中文一致；勿與排班/出勤(schedule_periods)同名狀態共用此表
  var SALARY_STATUS = {
    draft:          '草稿',
    calculating:    '計算中',
    pending_review: '待審核',
    approved:       '已核准',
    confirmed:      '已確認',
    paid:           '已發放',
    locked:         '已鎖定',
  };

  var EMP_TYPE = { full_time: '正職', part_time: '兼職' };

  global.HRLabels = {
    salaryStatus: SALARY_STATUS,
    empType: EMP_TYPE,
    salaryStatusText: function (code) { return SALARY_STATUS[code] || code || '—'; },
    empTypeText:      function (code) { return EMP_TYPE[code]      || code || '—'; },
  };
})(typeof window !== 'undefined' ? window : this);

// public/js/utils.js — 前端共用 helpers
//
// 目前提供：
//   loadLeaveTypeLabels()    — 從 /api/leaves?_resource=leave_types fetch、cache 在 module
//                              (idempotent、第二次呼叫不會重 fetch)
//   leaveTypeLabel(code)     — name_zh、找不到回 code(列表 / chip / dropdown 用)
//   leaveTypeLabelFull(code) — name_zh(code)、詳情 / debug 用
//
// 用法(HTML 頁面):
//   <script src="/js/utils.js"></script>
//   ...
//   await window.HR_Utils.loadLeaveTypeLabels();   // init 時 await 一次
//   element.textContent = window.HR_Utils.leaveTypeLabel('menstrual');  // → '生理假'
//
// 注意:/api/leaves?_resource=leave_types 不需 auth(api/leaves/index.js:39 已標註)、
// 故本檔 fetch 不需要帶 Authorization header。

(function () {
  let _labels = {};       // code → name_zh
  let _loadPromise = null;

  async function loadLeaveTypeLabels() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
      try {
        const res = await fetch('/api/leaves?_resource=leave_types');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const types = await res.json();
        if (Array.isArray(types)) {
          _labels = Object.fromEntries(types.map(t => [t.code, t.name_zh]));
        }
      } catch (e) {
        console.warn('[HR_Utils] loadLeaveTypeLabels 失敗:', e.message);
        _loadPromise = null; // 失敗讓下次重試
      }
      return _labels;
    })();
    return _loadPromise;
  }

  function leaveTypeLabel(code) {
    if (!code) return '';
    return _labels[code] || code;
  }

  function leaveTypeLabelFull(code) {
    if (!code) return '';
    const name = _labels[code];
    return name ? `${name}(${code})` : code;
  }

  window.HR_Utils = {
    loadLeaveTypeLabels,
    leaveTypeLabel,
    leaveTypeLabelFull,
  };
})();

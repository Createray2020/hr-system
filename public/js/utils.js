// public/js/utils.js — 前端共用 helpers
//
// Phase 1.0 提供:loadLeaveTypeLabels / leaveTypeLabel / leaveTypeLabelFull
// Phase 1.4 加:leaveType / stageLabel / stageBadgeClass / advanceHintText /
//             proofHintText / gapHoursClient / checkAdvanceClient
//
// 用法(HTML 頁面):
//   <script src="/js/utils.js"></script>
//   ...
//   await window.HR_Utils.loadLeaveTypeLabels();   // init 時 await 一次
//   const lt = window.HR_Utils.leaveType('annual');
//   element.textContent = window.HR_Utils.leaveTypeLabel('menstrual');
//   chip.className = 'badge ' + window.HR_Utils.stageBadgeClass('pending_mgr');
//
// 注意:/api/leaves?_resource=leave_types 不需 auth(api/leaves/index.js:39 已標註)、
// 故本檔 fetch 不需要帶 Authorization header。

(function () {
  let _types = [];          // 完整 row 陣列(Phase 1.4 起)
  let _byCode = {};         // code → row(完整欄位)
  let _labels = {};         // code → name_zh(legacy compat)
  let _loadPromise = null;

  async function loadLeaveTypeLabels() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
      try {
        const res = await fetch('/api/leaves?_resource=leave_types');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const types = await res.json();
        if (Array.isArray(types)) {
          _types = types;
          _byCode = Object.fromEntries(types.map(t => [t.code, t]));
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

  /** 完整 row(含 advance_hours / requires_proof 等)。找不到回 null。 */
  function leaveType(code) {
    if (!code) return null;
    return _byCode[code] || null;
  }

  /** active leave_types 完整 row 陣列(已依 display_order 排序)。空陣列代表還沒載入。 */
  function leaveTypes() {
    return _types.slice();
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

  // ─── stage label / badge class(Phase 1.4 / 1.6)──────────────
  // 'pending'(legacy)= 'pending_mgr'(向後相容)
  // 'terminated' (Phase 1.6) = HR 終止 expired row
  const STAGE_LABEL = {
    pending:      '待主管審核',
    pending_mgr:  '待主管審核',
    pending_ceo:  '待執行長審核',
    approved:     '已核准',
    archived:     '已歸檔',
    rejected:     '已退回',
    cancelled:    '已撤回',
    terminated:   '已終結',
  };
  const STAGE_BADGE = {
    pending:     'badge-pending',
    pending_mgr: 'badge-pending',
    pending_ceo: 'badge-pending',
    approved:    'badge-approved',
    archived:    'badge-archived',
    rejected:    'badge-rejected',
    cancelled:   'badge-cancelled',
    terminated:  'badge-terminated',
  };
  function stageLabel(status) { return STAGE_LABEL[status] || status || ''; }
  function stageBadgeClass(status) { return STAGE_BADGE[status] || 'badge-pending'; }

  // ─── 前置時間提示文字 ────────────────────────────────────
  // advance_hours = 0 → '當天可申請'
  // advance_hours = 24 → '需於 1 天前申請'(hard)/'建議於 1 天前申請、緊急可當天'(soft)
  // 24 整數倍轉天、不整除顯示小時
  function advanceHintText(lt) {
    if (!lt) return '';
    const h = Number(lt.advance_hours || 0);
    if (h === 0) return '當天可申請';
    const isHard = lt.advance_rule === 'hard';
    const days = h / 24;
    const text = Number.isInteger(days) ? `${days} 天前` : `${h} 小時前`;
    return isHard ? `需於 ${text}申請` : `建議於 ${text}申請(緊急狀況可當天申請)`;
  }

  // ─── 證明文件提示文字 ────────────────────────────────────
  function proofHintText(lt) {
    if (!lt || !lt.requires_proof) return '';
    const grace = Number(lt.proof_grace_days || 0);
    if (grace === 0) return '需檢附證明文件';
    return `需檢附證明文件、可於假期結束後 ${grace} 日內補繳`;
  }

  // ─── 申請時間 → 假期起點 差幾小時(client-side、跟 lib/leave/advance-time.js 同邏輯)─
  function gapHoursClient(submittedAt, leaveStartAt) {
    const subMs = toMs(submittedAt);
    const startMs = toMs(leaveStartAt);
    return (startMs - subMs) / 3600000;
  }
  function toMs(t) {
    if (t instanceof Date) return t.getTime();
    if (typeof t === 'number') return t;
    if (typeof t === 'string') {
      const ms = Date.parse(t);
      if (Number.isFinite(ms)) return ms;
    }
    return NaN;
  }

  // ─── client-side advance time 檢查(跟後端 validateAdvanceTime 對齊)──
  // 回 { ok, late, gapHours, advanceHours }
  //   advance_hours=0 → 永遠 ok=true, late=false
  //   gap >= advance_hours → ok=true, late=false
  //   gap < advance_hours, hard → ok=false, late=false
  //   gap < advance_hours, soft → ok=true, late=true
  function checkAdvanceClient(lt, leaveStartAt, submittedAt) {
    if (!lt) return { ok: true, late: false };
    const advance = Number(lt.advance_hours || 0);
    if (advance === 0) return { ok: true, late: false, gapHours: null, advanceHours: 0 };
    const gap = gapHoursClient(submittedAt || new Date(), leaveStartAt);
    if (!Number.isFinite(gap)) return { ok: true, late: false };
    if (gap >= advance) return { ok: true, late: false, gapHours: gap, advanceHours: advance };
    if (lt.advance_rule === 'hard') {
      return { ok: false, late: false, gapHours: gap, advanceHours: advance };
    }
    return { ok: true, late: true, gapHours: gap, advanceHours: advance };
  }

  // ─── 時區 helper:把 ISO timestamp 顯示成台灣 'HH:MM'(24hr)──
  // 顯式鎖 Asia/Taipei、跟 server-side lib/attendance/clock.js 的 timezone-aware path(commit c9f1600)
  // 對稱、不依賴 browser 本地 TZ(對 admin 海外 / VPN 也對)。
  // 邊界:null / undefined / 無效字串 → '—'。
  function fmtTaipeiTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Taipei',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  window.HR_Utils = {
    loadLeaveTypeLabels,
    leaveTypeLabel,
    leaveTypeLabelFull,
    leaveType,
    leaveTypes,
    stageLabel,
    stageBadgeClass,
    advanceHintText,
    proofHintText,
    gapHoursClient,
    checkAdvanceClient,
    fmtTaipeiTime,
  };
})();

// public/js/excel-tools.js — 共用匯入匯出工具
// 依賴：SheetJS (window.XLSX)

const ExcelTools = (() => {
  // ── 內部 helpers ──────────────────────────────────────────────────────────

  function s2ab(s) {
    const buf = new ArrayBuffer(s.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i) & 0xFF;
    return buf;
  }

  function downloadBlob(filename, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function toExcelDate(val) {
    if (!val) return '';
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    return String(val);
  }

  function showToast(msg, type = 'success') {
    if (window._showToast) { window._showToast(msg, type); return; }
    const c = document.getElementById('toast-container');
    if (!c) return;
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  // ── exportTemplate ────────────────────────────────────────────────────────
  // config: { sheetName, filename, columns:[{key,label,required?,note?,example?}] }
  function exportTemplate(config) {
    const XLSX = window.XLSX;
    const wb = XLSX.utils.book_new();

    const { sheetName = '資料', filename = 'template', columns } = config;

    // Row 1: headers
    // Row 2: 欄位說明 (note)
    // Row 3: 範例 (example)
    // Row 4+: 填寫區

    const headers = columns.map(c => (c.required ? '* ' : '') + c.label);
    const notes   = columns.map(c => c.note    || '');
    const examples= columns.map(c => c.example || '');

    const wsData = [headers, notes, examples];
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Style-ish: set column widths
    ws['!cols'] = columns.map(c => ({ wch: Math.max(c.label.length * 2 + 4, 14) }));

    // Freeze top 3 rows
    ws['!freeze'] = { xSplit: 0, ySplit: 3 };

    XLSX.utils.book_append_sheet(wb, ws, sheetName);

    // 欄位說明 sheet
    const descData = [
      ['欄位名稱', '必填', '說明', '範例'],
      ...columns.map(c => [c.label, c.required ? '是' : '否', c.note || '', c.example || ''])
    ];
    const wsDesc = XLSX.utils.aoa_to_sheet(descData);
    wsDesc['!cols'] = [{ wch: 16 }, { wch: 6 }, { wch: 32 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, wsDesc, '欄位說明');

    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'binary' });
    downloadBlob(`${filename}_template.xlsx`, new Blob([s2ab(wbout)], { type: 'application/octet-stream' }));
  }

  // ── exportData ────────────────────────────────────────────────────────────
  // config: { sheetName, filename, columns:[{key,label,format?}] }
  // data: array of objects
  function exportData(config, data) {
    const XLSX = window.XLSX;
    const wb = XLSX.utils.book_new();

    const { sheetName = '資料', filename = 'export', columns } = config;

    const headers = columns.map(c => c.label);
    const rows = data.map(row =>
      columns.map(c => {
        const v = row[c.key];
        if (c.format) return c.format(v, row);
        if (v === null || v === undefined) return '';
        return v;
      })
    );

    const wsData = [headers, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = columns.map(c => ({ wch: Math.max(c.label.length * 2 + 4, 14) }));

    XLSX.utils.book_append_sheet(wb, ws, sheetName);

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'binary' });
    downloadBlob(`${filename}_${today}.xlsx`, new Blob([s2ab(wbout)], { type: 'application/octet-stream' }));
    showToast(`已匯出 ${data.length} 筆資料`);
  }

  // ── importFile ────────────────────────────────────────────────────────────
  // Returns Promise<{ parsed:[], errors:[], total:number }>
  // Rows 1-3 are header/notes/examples → data starts at row 4 (index 3)
  function importFile(file, config) {
    return new Promise((resolve, reject) => {
      const XLSX = window.XLSX;
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'binary', cellDates: true });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

          // row 0 = headers, row 1 = notes, row 2 = examples, row 3+ = data
          const dataRows = rows.slice(3).filter(r => r.some(c => c !== ''));

          const { columns } = config;
          const parsed = [];
          const errors = [];

          dataRows.forEach((row, ri) => {
            const obj = {};
            const rowErrors = [];
            columns.forEach((col, ci) => {
              let val = row[ci];
              if (val instanceof Date) val = val.toISOString().slice(0, 10);
              else val = val === null || val === undefined ? '' : String(val).trim();

              if (col.required && !val) {
                rowErrors.push(`第 ${ri + 4} 行「${col.label}」為必填`);
              }
              if (col.validate && val) {
                const err = col.validate(val);
                if (err) rowErrors.push(`第 ${ri + 4} 行「${col.label}」${err}`);
              }
              if (col.transform && val) val = col.transform(val);
              obj[col.key] = val || null;
            });

            if (rowErrors.length) {
              errors.push(...rowErrors);
            } else {
              parsed.push(obj);
            }
          });

          resolve({ parsed, errors, total: dataRows.length });
        } catch (err) {
          reject(new Error('檔案解析失敗：' + err.message));
        }
      };
      reader.onerror = () => reject(new Error('檔案讀取失敗'));
      reader.readAsBinaryString(file);
    });
  }

  // ── showImportModal ───────────────────────────────────────────────────────
  // result: { parsed, errors, total }
  // config: { columns, previewCols?:[{key,label}] }
  // onConfirm: async function(parsed) — stored in _pendingConfirm to avoid toString issues
  function showImportModal(result, config, onConfirm) {
    ExcelTools._pendingConfirm = onConfirm;

    // Remove existing modal
    const old = document.getElementById('_et_import_modal');
    if (old) old.remove();

    const { parsed, errors, total } = result;
    const previewCols = config.previewCols || config.columns.slice(0, 5);
    const hasErrors = errors.length > 0;

    const errHtml = hasErrors ? `
      <div style="background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3);border-radius:8px;padding:12px 14px;margin-bottom:14px;max-height:120px;overflow-y:auto">
        <div style="font-size:11px;color:#F87171;font-family:'DM Mono',monospace;letter-spacing:.5px;margin-bottom:6px">錯誤明細 (${errors.length})</div>
        ${errors.map(e => `<div style="font-size:12px;color:var(--red);margin-bottom:3px">• ${e}</div>`).join('')}
      </div>` : '';

    const previewRows = parsed.slice(0, 8);
    const previewHtml = previewRows.length ? `
      <div style="margin-bottom:14px">
        <div style="font-size:11px;color:var(--text-dim);font-family:'DM Mono',monospace;letter-spacing:.5px;margin-bottom:8px">預覽（前 ${previewRows.length} 筆）</div>
        <div style="overflow:auto;max-height:200px;border:1px solid var(--border);border-radius:8px">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead>
              <tr style="background:var(--surface2)">
                ${previewCols.map(c => `<th style="padding:7px 10px;text-align:left;font-size:10px;color:var(--text-dim);white-space:nowrap;border-bottom:1px solid var(--border)">${c.label}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${previewRows.map(r => `<tr>${previewCols.map(c => `<td style="padding:6px 10px;border-bottom:1px solid rgba(42,48,72,.4);white-space:nowrap">${r[c.key] ?? ''}</td>`).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${parsed.length > 8 ? `<div style="font-size:11px;color:var(--text-dim);margin-top:6px;text-align:right">… 還有 ${parsed.length - 8} 筆</div>` : ''}
      </div>` : '';

    const modalHtml = `
      <div id="_et_import_modal" class="modal-bg open" onclick="if(event.target===this)this.remove()">
        <div class="modal" style="width:640px">
          <div class="modal-title">匯入預覽</div>

          <div style="display:flex;gap:12px;margin-bottom:16px">
            <div style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center">
              <div style="font-size:24px;font-weight:700;font-family:'DM Mono',monospace;color:var(--accent2)">${total}</div>
              <div style="font-size:11px;color:var(--text-dim);margin-top:2px">讀取筆數</div>
            </div>
            <div style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center">
              <div style="font-size:24px;font-weight:700;font-family:'DM Mono',monospace;color:var(--green)">${parsed.length}</div>
              <div style="font-size:11px;color:var(--text-dim);margin-top:2px">可匯入筆數</div>
            </div>
            <div style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center">
              <div style="font-size:24px;font-weight:700;font-family:'DM Mono',monospace;color:${hasErrors ? 'var(--red)' : 'var(--text-dim)'}">${errors.length}</div>
              <div style="font-size:11px;color:var(--text-dim);margin-top:2px">錯誤筆數</div>
            </div>
          </div>

          ${errHtml}
          ${previewHtml}

          ${parsed.length === 0 ? `<div style="text-align:center;padding:20px;color:var(--text-dim)">沒有可匯入的有效資料</div>` : ''}

          <div class="modal-actions">
            <button class="btn btn-ghost" onclick="document.getElementById('_et_import_modal').remove()">取消</button>
            ${parsed.length > 0 ? `<button class="btn btn-primary" id="_et_confirm_btn" onclick="ExcelTools._runConfirm()">確認匯入 ${parsed.length} 筆</button>` : ''}
          </div>
        </div>
      </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
  }

  // Called by the confirm button inside showImportModal
  async function _runConfirm() {
    const fn = ExcelTools._pendingConfirm;
    if (!fn) return;
    ExcelTools._pendingConfirm = null;
    const btn = document.getElementById('_et_confirm_btn');
    if (btn) { btn.disabled = true; btn.textContent = '匯入中…'; }
    try {
      await fn();
      const modal = document.getElementById('_et_import_modal');
      if (modal) modal.remove();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = '確認匯入'; }
      showToast('匯入失敗：' + err.message, 'error');
    }
  }

  return { exportTemplate, exportData, importFile, showImportModal, _runConfirm, _pendingConfirm: null };
})();

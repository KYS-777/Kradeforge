/* ============================================================
   ui.js — UI Helpers: Formatting, Rendering, Components

   RESPONSIBILITIES:
   - Format numbers: currency, percentages, dates, times, R-multiples
   - Render trade rows as HTML table cells
   - Show/hide toast notification messages
   - Open/close the trade detail modal
   - Render trade detail view (read-only)
   - Render trade edit form
   - Manage import log messages
   ============================================================ */

const UI = (() => {

  // ── FORMATTING ──────────────────────────────────────────
  function fmtCurrency(val, showPlus = false) {
    if (val === undefined || val === null || isNaN(val)) return '—';
    const abs = Math.abs(val);
    let str;
    if (abs >= 1000000) str = `$${(abs / 1000000).toFixed(2)}M`;
    else if (abs >= 10000) str = `$${(abs / 1000).toFixed(2)}K`;
    else str = `$${abs.toFixed(2)}`;
    return val < 0 ? `-${str}` : (showPlus && val > 0 ? `+${str}` : str);
  }

  function fmtPct(val) {
    if (val === undefined || val === null || isNaN(val)) return '—';
    const s = val >= 0 ? '+' : '';
    return `${s}${val.toFixed(2)}%`;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function fmtDuration(min) {
    if (!min && min !== 0) return '—';
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  function fmtR(r) {
    if (r === undefined || r === null || isNaN(r)) return '—';
    return (r >= 0 ? '+' : '') + r.toFixed(2) + 'R';
  }

  function colorPnl(val) {
    if (val > 0.001) return 'pnl-positive';
    if (val < -0.001) return 'pnl-negative';
    return '';
  }

  function sideBadge(side) {
    return `<span class="badge badge-${side.toLowerCase()}">${side}</span>`;
  }

  function resultBadge(result) {
    const map = { WIN: 'win', LOSS: 'loss', EVEN: 'even', OPEN: 'even' };
    const cls = map[result] || 'even';
    return `<span class="badge badge-${cls}">${result || '—'}</span>`;
  }

  // ── TRADE ROW HTML ───────────────────────────────────────
  function tradeRow(t, actions = true) {
    const pnlClass = colorPnl(t.pnl);
    return `
      <tr data-id="${t.id}">
        <td style="white-space:nowrap">
          <div style="font-size:12px">${fmtDate(t.entryDate)}</div>
          <div style="font-size:11px;color:var(--text3)">${fmtTime(t.entryDate)}</div>
        </td>
        <td><strong>${t.symbol}</strong></td>
        <td>${sideBadge(t.side)}</td>
        <td>${t.qty}</td>
        <td style="font-family:var(--font-mono)">${t.entry ? parseFloat(t.entry).toFixed(3) : '—'}</td>
        <td style="font-family:var(--font-mono)">${t.exit ? parseFloat(t.exit).toFixed(3) : '—'}</td>
        <td class="${pnlClass}">${fmtCurrency(t.pnl, true)}</td>
        <td class="${pnlClass}">${fmtR(t.r)}</td>
        ${actions ? `
        <td>${fmtDuration(t.duration)}</td>
        <td title="${t.notes || ''}" style="max-width:120px;overflow:hidden;text-overflow:ellipsis;color:var(--text2)">${t.notes ? t.notes.slice(0, 24) + (t.notes.length > 24 ? '…' : '') : '—'}</td>
        <td><div class="td-actions">
          <button class="btn-icon" onclick="App.viewTrade('${t.id}')">👁</button>
          <button class="btn-icon" onclick="App.editTrade('${t.id}')">✎</button>
          <button class="btn-icon danger" onclick="App.deleteTrade('${t.id}')">✕</button>
        </div></td>` : `
        <td>${resultBadge(t.result)}</td>`}
      </tr>`;
  }

  function tradeRowSimple(t) {
    const pnlClass = colorPnl(t.pnl);
    return `
      <tr data-id="${t.id}" style="cursor:pointer" onclick="App.viewTrade('${t.id}')">
        <td style="white-space:nowrap">
          <div style="font-size:12px">${fmtDate(t.entryDate)}</div>
          <div style="font-size:11px;color:var(--text3)">${fmtTime(t.entryDate)}</div>
        </td>
        <td><strong>${t.symbol}</strong></td>
        <td>${sideBadge(t.side)}</td>
        <td>${t.qty}</td>
        <td>${t.entry ? '$' + parseFloat(t.entry).toFixed(2) : '—'}</td>
        <td>${t.exit ? '$' + parseFloat(t.exit).toFixed(2) : '—'}</td>
        <td class="${pnlClass}">${fmtCurrency(t.pnl, true)}</td>
        <td class="${pnlClass}">${fmtR(t.r)}</td>
        <td>${resultBadge(t.result)}</td>
      </tr>`;
  }

  // ── TOAST ────────────────────────────────────────────────
  let toastTimer;
  function toast(msg, type = '') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  // ── MODAL ────────────────────────────────────────────────
  function openModal(title, bodyHtml) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHtml;
    document.getElementById('tradeModal').style.display = 'flex';
  }

  function closeModal() {
    document.getElementById('tradeModal').style.display = 'none';
  }

  // ── IMPORT LOG ───────────────────────────────────────────
  function appendImportLog(logMessages) {
    const body = document.getElementById('importLogBody');
    if (!body) return;
    body.innerHTML = logMessages.map(l =>
      `<div class="log-line ${l.type}">▸ ${l.msg}</div>`
    ).join('');
    body.scrollTop = body.scrollHeight;
  }

  function clearImportLog() {
    const body = document.getElementById('importLogBody');
    if (body) body.innerHTML = '<p class="log-hint">Import activity will appear here…</p>';
  }

  // ── EMPTY STATE ──────────────────────────────────────────
  function emptyState(msg = 'No trades yet. Import a file or add a trade manually.') {
    return `<tr><td colspan="12">
      <div class="empty-state">
        <div class="empty-icon">◈</div>
        <p>${msg}</p>
      </div>
    </td></tr>`;
  }

  // ── TRADE DETAIL MODAL ───────────────────────────────────
  function tradeDetailHtml(t) {
    const pnlClass = colorPnl(t.pnl);
    return `
      <div class="modal-detail-grid">
        <div class="modal-detail-item">
          <div class="mdi-label">Symbol</div>
          <div class="mdi-value"><strong>${t.symbol}</strong></div>
        </div>
        <div class="modal-detail-item">
          <div class="mdi-label">Side</div>
          <div class="mdi-value">${sideBadge(t.side)}</div>
        </div>
        <div class="modal-detail-item">
          <div class="mdi-label">Result</div>
          <div class="mdi-value">${resultBadge(t.result)}</div>
        </div>
        <div class="modal-detail-item">
          <div class="mdi-label">Quantity</div>
          <div class="mdi-value">${t.qty}</div>
        </div>
        <div class="modal-detail-item">
          <div class="mdi-label">Entry</div>
          <div class="mdi-value">$${parseFloat(t.entry || 0).toFixed(2)}</div>
        </div>
        <div class="modal-detail-item">
          <div class="mdi-label">Exit</div>
          <div class="mdi-value">$${parseFloat(t.exit || 0).toFixed(2)}</div>
        </div>
        <div class="modal-detail-item">
          <div class="mdi-label">P&L</div>
          <div class="mdi-value ${pnlClass}">${fmtCurrency(t.pnl, true)}</div>
        </div>
        <div class="modal-detail-item">
          <div class="mdi-label">R-Multiple</div>
          <div class="mdi-value ${pnlClass}">${fmtR(t.r)}</div>
        </div>
        <div class="modal-detail-item">
          <div class="mdi-label">Commission</div>
          <div class="mdi-value">${t.commission ? fmtCurrency(t.commission) : '—'}</div>
        </div>
        <div class="modal-detail-item">
          <div class="mdi-label">Entry Time</div>
          <div class="mdi-value">${fmtDateTime(t.entryDate)}</div>
        </div>
        <div class="modal-detail-item">
          <div class="mdi-label">Exit Time</div>
          <div class="mdi-value">${fmtDateTime(t.exitDate)}</div>
        </div>
        <div class="modal-detail-item">
          <div class="mdi-label">Duration</div>
          <div class="mdi-value">${fmtDuration(t.duration)}</div>
        </div>
      </div>
      ${t.stop ? `<div style="margin-bottom:10px">
        <span class="mdi-label" style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em">Stop Loss: </span>
        <span style="font-family:var(--font-mono);font-size:13px">$${parseFloat(t.stop).toFixed(2)}</span>
      </div>` : ''}
      ${t.tags && t.tags.length ? `<div style="margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap">
        ${t.tags.map(tag => `<span style="background:var(--bg4);border:1px solid var(--border);padding:2px 8px;border-radius:10px;font-size:11px;color:var(--text2)">${tag}</span>`).join('')}
      </div>` : ''}
      ${t.notes ? `<div class="modal-notes">
        <div class="modal-notes-label">Notes</div>
        <div class="modal-notes-text">${t.notes}</div>
      </div>` : ''}`;
  }

  // ── EDIT TRADE FORM ──────────────────────────────────────
  function editTradeHtml(t) {
    return `
      <div class="modal-edit-form">
        <div class="form-row" style="grid-template-columns:repeat(3,1fr)">
          <div class="form-group">
            <label>Symbol</label>
            <input type="text" id="edit-symbol" value="${t.symbol}" />
          </div>
          <div class="form-group">
            <label>Side</label>
            <select id="edit-side">
              <option value="LONG" ${t.side === 'LONG' ? 'selected' : ''}>Long</option>
              <option value="SHORT" ${t.side === 'SHORT' ? 'selected' : ''}>Short</option>
            </select>
          </div>
          <div class="form-group">
            <label>Qty</label>
            <input type="number" id="edit-qty" value="${t.qty}" step="any" />
          </div>
        </div>
        <div class="form-row" style="grid-template-columns:repeat(3,1fr)">
          <div class="form-group">
            <label>Entry Price</label>
            <input type="number" id="edit-entry" value="${t.entry}" step="any" />
          </div>
          <div class="form-group">
            <label>Exit Price</label>
            <input type="number" id="edit-exit" value="${t.exit || ''}" step="any" />
          </div>
          <div class="form-group">
            <label>Stop Loss</label>
            <input type="number" id="edit-stop" value="${t.stop || ''}" step="any" />
          </div>
        </div>
        <div class="form-row" style="grid-template-columns:repeat(2,1fr)">
          <div class="form-group">
            <label>Entry Date</label>
            <input type="datetime-local" id="edit-entryDate" value="${t.entryDate ? t.entryDate.slice(0,16) : ''}" />
          </div>
          <div class="form-group">
            <label>Exit Date</label>
            <input type="datetime-local" id="edit-exitDate" value="${t.exitDate ? t.exitDate.slice(0,16) : ''}" />
          </div>
        </div>
        <div class="form-group">
          <label>Commission</label>
          <input type="number" id="edit-commission" value="${t.commission || 0}" step="any" />
        </div>
        <div class="form-group">
          <label>Notes</label>
          <textarea id="edit-notes" rows="3">${t.notes || ''}</textarea>
        </div>
        <div class="form-group">
          <label>Tags (comma-separated)</label>
          <input type="text" id="edit-tags" value="${(t.tags || []).join(', ')}" />
        </div>
        <div style="display:flex;gap:10px;margin-top:6px">
          <button class="btn-primary" onclick="App.saveEditTrade('${t.id}')">Save Changes</button>
          <button class="btn-secondary" onclick="UI.closeModal()">Cancel</button>
        </div>
      </div>`;
  }

  return {
    fmtCurrency, fmtPct, fmtDate, fmtDateTime, fmtDuration, fmtR,
    colorPnl, sideBadge, resultBadge,
    tradeRow, tradeRowSimple, emptyState,
    toast, openModal, closeModal,
    appendImportLog, clearImportLog,
    tradeDetailHtml, editTradeHtml
  };
})();

/* ============================================================
   app.js — Main Application Controller (CLOUD SYNC VERSION)
   
   FIXED: "Clear ALL trade data" now permanently deletes
          from Supabase cloud, not just local DataStore.
   ============================================================ */

const App = (() => {
  let currentPage = 'dashboard';
  let currentFilter = 'all';
  let currentSort = { col: 'date', dir: 'desc' };
  let currentPage2 = 1;
  const PAGE_SIZE = 30;
  let filteredTrades = [];
  let pendingImport = [];
  let calendarDate = new Date();
  let activeNoteId = null;

  // ── INIT ─────────────────────────────────────────────────
  async function init() {
    const session = await SupabaseClient.restoreSession();
    if (!session) {
      window.location.href = 'login.html';
      return;
    }

    localStorage.setItem('kf_session', JSON.stringify(session));
    SupabaseClient.setSession(session);
    CloudStore.setOnline(true);

    await loadCloudData();

    bindNav();
    bindTopbar();
    bindImport();
    bindManualForm();
    bindTradeLog();
    bindCalendar();
    bindNotes();
    bindModal();
    bindUserMenu();

    refreshDashboard();
    renderNotesList();
    updateBalancePill();
    updateUserMenu();
  }

  // ── LOAD CLOUD DATA ───────────────────────────────────────
  async function loadCloudData() {
    try {
      const cloudTrades = await CloudStore.loadTrades();
      if (cloudTrades !== null) DataStore.replaceAllTrades(cloudTrades);
      const cloudNotes = await CloudStore.loadNotes();
      if (cloudNotes !== null) DataStore.replaceAllNotes(cloudNotes);
      const cloudSettings = await CloudStore.loadSettings();
      if (cloudSettings !== null) DataStore.saveSettings(cloudSettings);
    } catch (e) {
      console.warn('Cloud load failed, using local data:', e.message);
    }
  }

  // ── USER MENU ─────────────────────────────────────────────
  function bindUserMenu() {
    const btn      = document.getElementById('userAvatarBtn');
    const dropdown = document.getElementById('userDropdown');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display !== 'none' ? 'none' : 'block';
    });
    document.addEventListener('click', () => {
      if (dropdown) dropdown.style.display = 'none';
    });
  }

  function updateUserMenu() {
    const email   = SupabaseClient.getUserEmail() || '';
    const session = JSON.parse(localStorage.getItem('kf_session') || '{}');
    const name    = session?.user?.user_metadata?.full_name || email.split('@')[0] || 'User';
    const initial = name.charAt(0).toUpperCase();
    const el = document.getElementById('userInitial');
    if (el) el.textContent = initial;
    const nameEl = document.getElementById('dropdownName');
    if (nameEl) nameEl.textContent = name;
    const emailEl = document.getElementById('dropdownEmail');
    if (emailEl) emailEl.textContent = email;
  }

  async function signOut() {
    await SupabaseClient.signOut();
    localStorage.removeItem('kf_session');
    DataStore.clearAll();
    window.location.href = 'login.html';
  }

  // ── NAVIGATION ───────────────────────────────────────────
  function bindNav() {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', e => {
        e.preventDefault();
        navigateTo(item.dataset.page);
      });
    });
    document.querySelectorAll('.view-all-link').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        navigateTo(link.dataset.page);
      });
    });

    const sidebar        = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    function openSidebar() {
      sidebar.classList.add('open');
      sidebarOverlay.classList.add('show');
      document.body.style.overflow = 'hidden';
    }
    function closeSidebar() {
      sidebar.classList.remove('open');
      sidebarOverlay.classList.remove('show');
      document.body.style.overflow = '';
    }
    document.getElementById('menuToggle').addEventListener('click', () => {
      sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
    });
    sidebarOverlay.addEventListener('click', closeSidebar);
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        if (window.innerWidth <= 900) closeSidebar();
      });
    });
  }

  function navigateTo(page) {
    if (currentPage === page) return;
    currentPage = page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.page === page);
    });
    const titles = {
      dashboard: 'Dashboard', trades: 'Trade Log', analytics: 'Analytics',
      calendar: 'Calendar', import: 'Import', notes: 'Notes'
    };
    document.getElementById('topbarTitle').textContent = titles[page] || page;
    document.getElementById('sidebar').classList.remove('open');
    if (page === 'trades') renderTradeLog();
    if (page === 'analytics') renderAnalytics();
    if (page === 'calendar') renderCalendar();
    if (page === 'notes') renderNotesList();
  }

  // ── TOPBAR ───────────────────────────────────────────────
  function bindTopbar() {
    document.getElementById('addTradeBtn').addEventListener('click', () => {
      navigateTo('import');
      document.getElementById('mSymbol').focus();
    });
    document.querySelectorAll('.dfilter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.dfilter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.range;
        refreshDashboard();
      });
    });
    document.getElementById('exportAllBtn').addEventListener('click', exportAll);
    document.getElementById('balancePill').addEventListener('click', openBalanceModal);
    document.getElementById('balanceModalClose').addEventListener('click', closeBalanceModal);
    document.getElementById('saveBalanceBtn').addEventListener('click', saveStartingBalance);
    document.getElementById('balanceModal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeBalanceModal();
    });
    document.getElementById('startingBalanceInput').addEventListener('input', updateBalancePreview);

    // ============================================================
    // FIXED: Clear ALL trade data — now permanently deletes from Supabase cloud
    // ============================================================
    const clearBtn = document.getElementById('clearDataBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        // First confirmation
        const confirmed = confirm(
          '⚠️ PERMANENT DELETE ⚠️\n\n' +
          'This will delete ALL your trades from the CLOUD.\n' +
          'This means you will lose them on ALL devices.\n\n' +
          'This CANNOT be undone.\n\n' +
          'Are you ABSOLUTELY sure?'
        );
        if (!confirmed) return;

        // Second confirmation (extra safe)
        const reallySure = confirm(
          'LAST WARNING!\n\n' +
          'All your trades will be permanently deleted from the cloud.\n' +
          'Click OK to delete everything, Cancel to abort.'
        );
        if (!reallySure) return;

        try {
          UI.toast('Deleting from cloud...', '');

          // Get current logged-in user
          const { data: { user }, error: userError } = await supabase.auth.getUser();
          if (userError) throw userError;
          if (!user) {
            UI.toast('You must be logged in', 'error');
            return;
          }

          // Delete ALL trades belonging to this user from Supabase
          const { error: deleteError } = await supabase
            .from('trades')
            .delete()
            .eq('user_id', user.id);

          if (deleteError) throw deleteError;

          // Also clear local DataStore
          DataStore.clearAll();

          // Refresh all UI components
          refreshDashboard();
          renderTradeLog();
          if (typeof renderAnalytics === 'function') renderAnalytics();
          if (typeof renderCalendar === 'function') renderCalendar();
          updateBalancePill();

          UI.toast('✅ All your trades have been permanently deleted from the cloud!', 'success');
        } catch (err) {
          console.error('Delete error:', err);
          UI.toast('Error deleting: ' + err.message, 'error');
        }
      });
    }
  }

  function getFilteredByRange() {
    if (currentFilter === 'all') return DataStore.getTrades();
    if (currentFilter === 'ytd') return DataStore.getTrades({ ytd: true });
    return DataStore.getTrades({ days: parseInt(currentFilter) });
  }

  function updateBalancePill() {
    const trades   = DataStore.getTrades();
    const settings = DataStore.getSettings();
    const start    = settings.accountBalance || 10000;
    const netPnl   = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const balance  = start + netPnl;
    const balEl = document.getElementById('topbarBalance');
    if (balEl) balEl.textContent = '$' + balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const dayEl = document.getElementById('topbarDayPnl');
    if (dayEl) {
      const sign = netPnl >= 0 ? '+' : '';
      dayEl.textContent = sign + '$' + Math.abs(netPnl).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
      dayEl.className = 'pill-pnl ' + (netPnl > 0 ? 'positive' : netPnl < 0 ? 'negative' : '');
    }
  }

  // ── BALANCE MODAL ─────────────────────────────────────
  function openBalanceModal() {
    const settings = DataStore.getSettings();
    document.getElementById('startingBalanceInput').value = settings.accountBalance || 10000;
    updateBalancePreview();
    document.getElementById('balanceModal').style.display = 'flex';
  }
  function closeBalanceModal() {
    document.getElementById('balanceModal').style.display = 'none';
  }
  function updateBalancePreview() {
    const val = parseFloat(document.getElementById('startingBalanceInput').value) || 0;
    const trades = DataStore.getTrades();
    const netPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const curr   = val + netPnl;
    const fmtAbs = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
    document.getElementById('bm_starting').textContent = fmtAbs(val);
    const pnlEl = document.getElementById('bm_pnl');
    pnlEl.textContent = (netPnl >= 0 ? '+$' : '-$') + Math.abs(netPnl).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
    pnlEl.style.color = netPnl >= 0 ? 'var(--green)' : 'var(--red)';
    document.getElementById('bm_current').textContent = fmtAbs(curr);
  }
  function saveStartingBalance() {
    const val = parseFloat(document.getElementById('startingBalanceInput').value);
    if (isNaN(val) || val < 0) { UI.toast('Enter a valid amount', 'error'); return; }
    DataStore.saveSettings({ accountBalance: val });
    if (CloudStore.isOnline()) CloudStore.saveSettings(DataStore.getSettings());
    updateBalancePill();
    closeBalanceModal();
    UI.toast('Balance updated ✓', 'success');
  }

  // ── DASHBOARD ────────────────────────────────────────────
  function refreshDashboard() {
    const trades = getFilteredByRange();
    const stats = Stats.compute(trades);
    const pnlEl = document.getElementById('statNetPnl');
    pnlEl.textContent = UI.fmtCurrency(stats.netPnl, true);
    pnlEl.className = `stat-value ${stats.netPnl >= 0 ? 'green' : 'red'}`;
    document.getElementById('statNetPnlPct').textContent = stats.total > 0 ? `${stats.wins}W / ${stats.losses}L / ${stats.even}B` : '—';
    document.getElementById('statWinRate').textContent = stats.total ? stats.winRate.toFixed(1) + '%' : '0%';
    document.getElementById('statWinsLosses').textContent = `${stats.wins}W / ${stats.losses}L`;
    document.getElementById('statProfitFactor').textContent = stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2);
    document.getElementById('statAvgWin').textContent = UI.fmtCurrency(stats.avgWin);
    document.getElementById('statAvgWinR').textContent = stats.avgWinR ? UI.fmtR(stats.avgWinR) : '—';
    document.getElementById('statAvgLoss').textContent = UI.fmtCurrency(stats.avgLoss);
    document.getElementById('statAvgLossR').textContent = stats.avgLossR ? UI.fmtR(stats.avgLossR) : '—';
    document.getElementById('statTotalTrades').textContent = stats.total;
    document.getElementById('statAvgDuration').textContent = stats.avgDuration ? `Avg: ${UI.fmtDuration(stats.avgDuration)}` : 'Avg: —';
    document.getElementById('statBestTrade').textContent = stats.bestTrade ? UI.fmtCurrency(stats.bestTrade.pnl, true) : '—';
    document.getElementById('statBestSym').textContent = stats.bestTrade ? stats.bestTrade.symbol : '—';
    document.getElementById('statWorstTrade').textContent = stats.worstTrade ? UI.fmtCurrency(stats.worstTrade.pnl, true) : '—';
    document.getElementById('statWorstSym').textContent = stats.worstTrade ? stats.worstTrade.symbol : '—';
    const tbody = document.getElementById('recentTradesTbody');
    const recent = trades.slice(0, 8);
    tbody.innerHTML = recent.length ? recent.map(t => UI.tradeRowSimple(t)).join('') : UI.emptyState('No trades in this period');
    updateBalancePill();
    Charts.renderCumulativePnl(stats.cumPnl);
    Charts.renderWinLoss(stats.wins, stats.losses, stats.even);
    Charts.renderSymbolPnl(stats.bySymbol);
    Charts.renderDayDist(stats.byDay);
    Charts.renderHourPnl(stats.byHour);
  }

  // ── TRADE LOG ────────────────────────────────────────────
  function bindTradeLog() {
    document.getElementById('tradeSearch').addEventListener('input', () => { currentPage2 = 1; renderTradeLog(); });
    document.getElementById('sideFilter').addEventListener('change', () => { currentPage2 = 1; renderTradeLog(); });
    document.getElementById('resultFilter').addEventListener('change', () => { currentPage2 = 1; renderTradeLog(); });
    document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
    document.querySelectorAll('#fullTradesTable th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (currentSort.col === col) currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
        else currentSort = { col, dir: 'desc' };
        renderTradeLog();
      });
    });
  }

  function renderTradeLog() {
    let trades = DataStore.getTrades();
    const search = document.getElementById('tradeSearch').value.toLowerCase();
    const side = document.getElementById('sideFilter').value;
    const result = document.getElementById('resultFilter').value;
    if (search) trades = trades.filter(t => t.symbol.toLowerCase().includes(search) || (t.notes || '').toLowerCase().includes(search) || (t.tags || []).some(tag => tag.toLowerCase().includes(search)));
    if (side) trades = trades.filter(t => t.side === side);
    if (result) trades = trades.filter(t => t.result === result);
    trades.sort((a, b) => {
      let va, vb;
      switch (currentSort.col) {
        case 'date': va = new Date(a.entryDate); vb = new Date(b.entryDate); break;
        case 'symbol': va = a.symbol; vb = b.symbol; break;
        case 'qty': va = a.qty; vb = b.qty; break;
        case 'entry': va = a.entry; vb = b.entry; break;
        case 'exit': va = a.exit || 0; vb = b.exit || 0; break;
        case 'pnl': va = a.pnl || 0; vb = b.pnl || 0; break;
        case 'r': va = a.r || -999; vb = b.r || -999; break;
        default: va = new Date(a.entryDate); vb = new Date(b.entryDate);
      }
      if (va < vb) return currentSort.dir === 'asc' ? -1 : 1;
      if (va > vb) return currentSort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    filteredTrades = trades;
    const total = trades.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    currentPage2 = Math.min(currentPage2, totalPages);
    const start = (currentPage2 - 1) * PAGE_SIZE;
    const page = trades.slice(start, start + PAGE_SIZE);
    const tbody = document.getElementById('fullTradesTbody');
    tbody.innerHTML = page.length ? page.map(t => UI.tradeRow(t, true)).join('') : UI.emptyState('No trades match your filters');
    renderPagination(totalPages);
  }

  function renderPagination(total) {
    const el = document.getElementById('pagination');
    if (total <= 1) { el.innerHTML = ''; return; }
    let html = '';
    if (currentPage2 > 1) html += `<button class="page-btn" onclick="App.goToPage(${currentPage2 - 1})">‹</button>`;
    const start = Math.max(1, currentPage2 - 2);
    const end = Math.min(total, currentPage2 + 2);
    if (start > 1) html += `<button class="page-btn" onclick="App.goToPage(1)">1</button>${start > 2 ? '<span>…</span>' : ''}`;
    for (let i = start; i <= end; i++) html += `<button class="page-btn ${i === currentPage2 ? 'active' : ''}" onclick="App.goToPage(${i})">${i}</button>`;
    if (end < total) html += `${end < total - 1 ? '<span>…</span>' : ''}<button class="page-btn" onclick="App.goToPage(${total})">${total}</button>`;
    if (currentPage2 < total) html += `<button class="page-btn" onclick="App.goToPage(${currentPage2 + 1})">›</button>`;
    el.innerHTML = html;
  }

  function goToPage(p) { currentPage2 = p; renderTradeLog(); document.getElementById('page-trades').scrollTop = 0; }

  function viewTrade(id) {
    const trade = DataStore.getTrades().find(t => t.id === id);
    if (!trade) return;
    UI.openModal(`${trade.symbol} — ${UI.fmtDate(trade.entryDate)}`, UI.tradeDetailHtml(trade));
  }

  function editTrade(id) {
    const trade = DataStore.getTrades().find(t => t.id === id);
    if (!trade) return;
    UI.openModal(`Edit Trade — ${trade.symbol}`, UI.editTradeHtml(trade));
  }

  function saveEditTrade(id) {
    const changes = {
      symbol: (document.getElementById('edit-symbol').value || '').toUpperCase().trim(),
      side: document.getElementById('edit-side').value,
      qty: parseFloat(document.getElementById('edit-qty').value) || 0,
      entry: parseFloat(document.getElementById('edit-entry').value) || 0,
      exit: parseFloat(document.getElementById('edit-exit').value) || 0,
      stop: parseFloat(document.getElementById('edit-stop').value) || undefined,
      commission: parseFloat(document.getElementById('edit-commission').value) || 0,
      entryDate: document.getElementById('edit-entryDate').value ? new Date(document.getElementById('edit-entryDate').value).toISOString() : undefined,
      exitDate: document.getElementById('edit-exitDate').value ? new Date(document.getElementById('edit-exitDate').value).toISOString() : undefined,
      notes: document.getElementById('edit-notes').value,
      tags: document.getElementById('edit-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    };
    DataStore.updateTrade(id, changes);
    UI.closeModal();
    UI.toast('Trade updated ✓', 'success');
    refreshDashboard();
    if (currentPage === 'trades') renderTradeLog();
    if (currentPage === 'analytics') renderAnalytics();
  }

  function deleteTrade(id) {
    if (!confirm('Delete this trade?')) return;
    DataStore.deleteTrade(id);
    if (CloudStore.isOnline()) CloudStore.deleteTrade(id);
    UI.toast('Trade deleted', 'warn');
    refreshDashboard();
    if (currentPage === 'trades') renderTradeLog();
    if (currentPage === 'analytics') renderAnalytics();
    if (currentPage === 'calendar') renderCalendar();
    updateBalancePill();
  }

  // ── ANALYTICS ────────────────────────────────────────────
  function renderAnalytics() {
    const trades = DataStore.getTrades();
    const stats = Stats.compute(trades);
    Charts.renderMonthlyPnl(stats.byMonth);
    Charts.renderRMultiple(trades);
    Charts.renderDrawdown(trades);
    Charts.renderSymbolWinRate(stats.bySymbol);
    Charts.renderDurationScatter(trades);
    Charts.renderStreaks(trades);
    const metrics = [
      { name: 'Expectancy', val: UI.fmtCurrency(stats.expectancy, true) },
      { name: 'Max Drawdown', val: UI.fmtCurrency(-stats.maxDD), cls: 'red' },
      { name: 'Std Deviation', val: UI.fmtCurrency(stats.stdDev) },
      { name: 'Sharpe Ratio', val: stats.sharpe.toFixed(3) },
      { name: 'Max Win Streak', val: stats.maxWinStreak + ' trades' },
      { name: 'Max Loss Streak', val: stats.maxLossStreak + ' trades' },
      { name: 'Current Streak', val: stats.currentStreak > 0 ? `+${stats.currentStreak}W` : stats.currentStreak < 0 ? `${Math.abs(stats.currentStreak)}L` : '0' },
      { name: 'Avg R-Multiple', val: UI.fmtR(stats.avgR) },
      { name: 'Avg Win R', val: UI.fmtR(stats.avgWinR) },
      { name: 'Avg Loss R', val: UI.fmtR(stats.avgLossR) },
      { name: 'Gross Profit', val: UI.fmtCurrency(stats.grossWin) },
      { name: 'Gross Loss', val: UI.fmtCurrency(-stats.grossLoss) },
    ];
    document.getElementById('metricsGrid').innerHTML = metrics.map(m => `<div class="metric-item"><div class="metric-name">${m.name}</div><div class="metric-val" style="${m.cls ? `color:var(--${m.cls})` : ''}">${m.val}</div></div>`).join('');
  }

  // ── CALENDAR ─────────────────────────────────────────────
  function bindCalendar() {
    document.getElementById('calPrev').addEventListener('click', () => { calendarDate.setMonth(calendarDate.getMonth() - 1); renderCalendar(); });
    document.getElementById('calNext').addEventListener('click', () => { calendarDate.setMonth(calendarDate.getMonth() + 1); renderCalendar(); });
    document.getElementById('calDetailClose').addEventListener('click', () => { document.getElementById('calDayDetail').style.display = 'none'; });
  }

  function renderCalendar() {
    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth();
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    document.getElementById('calMonthLabel').textContent = `${monthNames[month]} ${year}`;
    const trades = DataStore.getTrades();
    const byDay = {};
    for (const t of trades) {
      const d = new Date(t.entryDate);
      if (d.getFullYear() === year && d.getMonth() === month) {
        const key = d.getDate();
        if (!byDay[key]) byDay[key] = { trades: [], pnl: 0 };
        byDay[key].trades.push(t);
        byDay[key].pnl += t.pnl || 0;
      }
    }
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;
    let html = '';
    const dayHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    html += dayHeaders.map(d => `<div class="cal-day-header">${d}</div>`).join('');
    for (let i = 0; i < firstDay; i++) html += '<div class="cal-day empty"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = isCurrentMonth && d === today.getDate();
      const dayData = byDay[d];
      const pnl = dayData ? dayData.pnl : null;
      const tradeCount = dayData ? dayData.trades.length : 0;
      let cls = 'cal-day';
      if (isToday) cls += ' today';
      if (dayData) { cls += ' has-trades'; cls += pnl > 0 ? ' profitable' : pnl < 0 ? ' losing' : ''; }
      html += `<div class="${cls}" ${dayData ? `onclick="App.showCalDay(${d}, ${year}, ${month})"` : ''}><div class="cal-day-num">${d}</div>${dayData ? `<div class="cal-day-pnl ${UI.colorPnl(pnl)}">${UI.fmtCurrency(pnl, true)}</div><div class="cal-day-trades">${tradeCount} trade${tradeCount !== 1 ? 's' : ''}</div>` : ''}</div>`;
    }
    document.getElementById('calendarGrid').innerHTML = html;
  }

  function showCalDay(day, year, month) {
    const trades = DataStore.getTrades().filter(t => {
      const d = new Date(t.entryDate);
      return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day;
    });
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    document.getElementById('calDetailDate').textContent = `${monthNames[month]} ${day}, ${year}`;
    const netPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    document.getElementById('calDetailContent').innerHTML = `<div style="margin-bottom:12px"><span style="font-family:var(--font-mono);font-size:15px;font-weight:700" class="${UI.colorPnl(netPnl)}">${UI.fmtCurrency(netPnl, true)}</span><span style="color:var(--text3);font-size:12px;margin-left:8px">${trades.length} trade${trades.length !== 1 ? 's' : ''}</span></div><div style="display:flex;flex-direction:column;gap:8px">${trades.map(t => `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:10px;cursor:pointer" onclick="App.viewTrade('${t.id}')"><div style="display:flex;justify-content:space-between;align-items:center"><strong style="font-size:14px">${t.symbol}</strong><span style="font-family:var(--font-mono);font-size:13px" class="${UI.colorPnl(t.pnl)}">${UI.fmtCurrency(t.pnl, true)}</span></div><div style="color:var(--text2);font-size:12px;margin-top:4px">${t.side} · ${t.qty} shares · ${UI.resultBadge(t.result)}</div></div>`).join('')}</div>`;
    document.getElementById('calDayDetail').style.display = 'block';
  }

  // ── IMPORT ───────────────────────────────────────────────
  function bindImport() {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('dragover'); const file = e.dataTransfer.files[0]; if (file) handleFileImport(file); });
    fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFileImport(e.target.files[0]); e.target.value = ''; });
    document.getElementById('confirmImportBtn').addEventListener('click', confirmImport);
    document.getElementById('cancelImportBtn').addEventListener('click', () => { document.getElementById('previewSection').style.display = 'none'; pendingImport = []; });
  }

  async function handleFileImport(file) {
    UI.clearImportLog();
    document.getElementById('previewSection').style.display = 'none';
    const logMessages = [];
    const addLog = (msg, type = '') => { logMessages.push({ msg, type }); UI.appendImportLog(logMessages); };
    addLog(`📄 Reading: ${file.name}`);
    try {
      const result = await BrokerParser.parseFile(file);
      result.logMessages.forEach(l => logMessages.push(l));
      UI.appendImportLog(logMessages);
      if (!result.trades.length) { addLog('⚠ No trades could be parsed from this file.', 'warn'); return; }
      pendingImport = result.trades;
      addLog(`✅ Ready to import ${result.trades.length} trades from ${result.broker}`, 'success');
      const preview = result.trades.slice(0, 20);
      document.getElementById('previewInfo').textContent = `${result.broker} — ${result.trades.length} trades detected${result.trades.length > 20 ? ` (showing first 20)` : ''}`;
      document.getElementById('previewThead').innerHTML = `<th>Date</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Commission</th>`;
      document.getElementById('previewTbody').innerHTML = preview.map(t => `<tr><td>${UI.fmtDate(t.entryDate)}</td><td><strong>${t.symbol}</strong></td><td>${UI.sideBadge(t.side)}</td><td>${t.qty}</td><td>${t.entry ? '$' + parseFloat(t.entry).toFixed(2) : '—'}</td><td>${t.exit ? '$' + parseFloat(t.exit).toFixed(2) : '—'}</td><td class="${UI.colorPnl(t.pnl)}">${UI.fmtCurrency(t.pnl, true)}</td><td>${t.commission ? UI.fmtCurrency(t.commission) : '—'}</td></tr>`).join('');
      document.getElementById('previewSection').style.display = 'block';
    } catch (err) { addLog(`✗ Error: ${err.message}`, 'error'); addLog('Try a different file format or use manual entry below.', 'warn'); }
  }

  async function confirmImport() {
    if (!pendingImport.length) return;
    const added = DataStore.addTrades(pendingImport);
    UI.toast(`✓ Imported ${added} new trades!`, 'success');
    if (CloudStore.isOnline()) {
      UI.toast('☁ Syncing to cloud…', '');
      const trades = DataStore.getTrades();
      await CloudStore.syncLocalTrades(trades);
      UI.toast('☁ Synced to cloud ✓', 'success');
    }
    const logMessages = [{ msg: `✅ ${added} trades imported (${pendingImport.length - added} duplicates skipped)`, type: 'success' }];
    UI.appendImportLog(logMessages);
    pendingImport = [];
    document.getElementById('previewSection').style.display = 'none';
    refreshDashboard();
    updateBalancePill();
  }

  // ── MANUAL FORM ──────────────────────────────────────────
  function bindManualForm() {
    document.getElementById('submitManualBtn').addEventListener('click', submitManualTrade);
    document.getElementById('clearManualBtn').addEventListener('click', clearManualForm);
    const inputs = ['mSymbol','mSide','mQty','mEntry','mExit','mStop','mTP','mCommission'];
    inputs.forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('input', calcManualPnl); });
  }

  function calcManualPnl() {
    const side  = document.getElementById('mSide').value;
    const qty   = parseFloat(document.getElementById('mQty').value)   || 0;
    const entry = parseFloat(document.getElementById('mEntry').value) || 0;
    const exit  = parseFloat(document.getElementById('mExit').value)  || 0;
    const sl    = parseFloat(document.getElementById('mStop').value)  || 0;
    const tp    = parseFloat(document.getElementById('mTP').value)    || 0;
    const comm  = parseFloat(document.getElementById('mCommission').value) || 0;
    const pnlEl    = document.getElementById('mPnlPreview');
    const rrPreview= document.getElementById('rrPreview');
    const rrRisk   = document.getElementById('rrRisk');
    const rrReward = document.getElementById('rrReward');
    const rrRatio  = document.getElementById('rrRatio');
    const riskHint = document.getElementById('mRiskHint');
    const rewHint  = document.getElementById('mRewardHint');
    if (entry && exit && qty) {
      const isLots = qty < 10;
      const mult   = isLots ? 100 : 1;
      const diff   = side === 'LONG' ? (exit - entry) : (entry - exit);
      const rawPnl = diff * qty * mult;
      const netPnl = rawPnl - comm;
      pnlEl.value = (netPnl >= 0 ? '+' : '') + '$' + netPnl.toFixed(2);
      pnlEl.style.color = netPnl > 0 ? 'var(--green)' : netPnl < 0 ? 'var(--red)' : 'var(--text2)';
    } else { pnlEl.value = ''; pnlEl.style.color = 'var(--text2)'; }
    if (entry && sl && qty) {
      const isLots  = qty < 10;
      const mult    = isLots ? 100 : 1;
      const riskPip = Math.abs(entry - sl);
      const riskUSD = isLots ? riskPip * qty * mult : riskPip * qty;
      riskHint.textContent = riskUSD > 0 ? 'Risk: $' + riskUSD.toFixed(2) : '';
      rrRisk.textContent   = '$' + riskUSD.toFixed(2);
      if (tp && entry) {
        const rewPip  = Math.abs(tp - entry);
        const rewUSD  = isLots ? rewPip * qty * mult : rewPip * qty;
        const ratio   = riskUSD > 0 ? rewUSD / riskUSD : 0;
        rewHint.textContent  = rewUSD > 0 ? 'Reward: $' + rewUSD.toFixed(2) : '';
        rrReward.textContent = '$' + rewUSD.toFixed(2);
        rrRatio.textContent  = ratio.toFixed(2) + ':1';
        rrRatio.style.color  = ratio >= 2 ? 'var(--green)' : ratio >= 1 ? 'var(--accent)' : 'var(--red)';
        rrPreview.style.display = 'flex';
      } else { rewHint.textContent = ''; rrReward.textContent = '—'; rrRatio.textContent = '—'; rrPreview.style.display = entry && sl ? 'flex' : 'none'; }
    } else { riskHint.textContent = ''; rewHint.textContent = ''; rrPreview.style.display = 'none'; }
  }

  function clearManualForm() {
    ['mSymbol','mQty','mEntry','mExit','mStop','mTP','mEntryDt','mExitDt','mCommission','mNotes','mTags'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('mSide').value = 'LONG';
    const pnlEl = document.getElementById('mPnlPreview'); if (pnlEl) pnlEl.value = '';
    document.getElementById('rrPreview').style.display = 'none';
    document.getElementById('mRiskHint').textContent = '';
    document.getElementById('mRewardHint').textContent = '';
  }

  function submitManualTrade() {
    const symbol = (document.getElementById('mSymbol').value || '').toUpperCase().trim();
    const side   = document.getElementById('mSide').value;
    const qty    = parseFloat(document.getElementById('mQty').value);
    const entry  = parseFloat(document.getElementById('mEntry').value);
    const exit   = parseFloat(document.getElementById('mExit').value);
    const stop   = parseFloat(document.getElementById('mStop').value)  || undefined;
    const tp     = parseFloat(document.getElementById('mTP').value)    || undefined;
    const entryDt    = document.getElementById('mEntryDt').value;
    const exitDt     = document.getElementById('mExitDt').value;
    const commission = parseFloat(document.getElementById('mCommission').value) || 0;
    const notes      = document.getElementById('mNotes').value;
    const tagsRaw    = document.getElementById('mTags').value;
    if (!symbol) { UI.toast('Symbol is required', 'error'); return; }
    if (!qty || qty <= 0) { UI.toast('Quantity is required', 'error'); return; }
    if (!entry) { UI.toast('Entry price is required', 'error'); return; }
    if (!entryDt) { UI.toast('Entry date is required', 'error'); return; }
    const trade = DataStore.enrichTrade({ symbol, side, qty, entry, exit: exit || entry, stop, tp, commission, entryDate: new Date(entryDt).toISOString(), exitDate: exitDt ? new Date(exitDt).toISOString() : new Date(entryDt).toISOString(), notes, tags: tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : ['manual'] });
    DataStore.addTrade(trade);
    UI.toast(`✓ Trade added: ${symbol}`, 'success');
    if (CloudStore.isOnline()) CloudStore.saveTrade(trade);
    clearManualForm();
    refreshDashboard();
    updateBalancePill();
  }

  // ── NOTES ────────────────────────────────────────────────
  function bindNotes() {
    document.getElementById('addNoteBtn').addEventListener('click', () => {
      activeNoteId = null;
      document.getElementById('noteTitleInput').value = '';
      document.getElementById('noteBodyInput').value = '';
      document.getElementById('noteTagsInput').value = '';
      document.getElementById('noteMeta').textContent = 'New note';
      document.getElementById('noteEditorEmpty').style.display = 'none';
      document.getElementById('noteEditorActive').style.display = 'flex';
      document.querySelectorAll('.note-item').forEach(n => n.classList.remove('active'));
      document.getElementById('noteTitleInput').focus();
    });
    document.getElementById('saveNoteBtn').addEventListener('click', saveNote);
    document.getElementById('deleteNoteBtn').addEventListener('click', deleteNote);
    document.getElementById('noteSearch').addEventListener('input', renderNotesList);
  }

  function renderNotesList() {
    const search = document.getElementById('noteSearch').value.toLowerCase();
    let notes = DataStore.getNotes();
    if (search) notes = notes.filter(n => (n.title || '').toLowerCase().includes(search) || (n.body || '').toLowerCase().includes(search) || (n.tags || []).some(t => t.toLowerCase().includes(search)));
    const list = document.getElementById('notesList');
    if (!notes.length) { list.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px">No notes yet</div>`; return; }
    list.innerHTML = notes.map(n => `<div class="note-item ${n.id === activeNoteId ? 'active' : ''}" onclick="App.openNote('${n.id}')"><div class="note-item-title">${n.title || 'Untitled'}</div><div class="note-item-preview">${(n.body || '').slice(0, 60)}${(n.body || '').length > 60 ? '…' : ''}</div><div class="note-item-date">${UI.fmtDate(n.updatedAt)}</div></div>`).join('');
  }

  function openNote(id) {
    const note = DataStore.getNotes().find(n => n.id === id);
    if (!note) return;
    activeNoteId = id;
    document.getElementById('noteTitleInput').value = note.title || '';
    document.getElementById('noteBodyInput').value = note.body || '';
    document.getElementById('noteTagsInput').value = (note.tags || []).join(', ');
    document.getElementById('noteMeta').textContent = `Created ${UI.fmtDate(note.createdAt)} · Updated ${UI.fmtDate(note.updatedAt)}`;
    document.getElementById('noteEditorEmpty').style.display = 'none';
    document.getElementById('noteEditorActive').style.display = 'flex';
    document.querySelectorAll('.note-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`.note-item[onclick*="${id}"]`)?.classList.add('active');
  }

  function saveNote() {
    const title = document.getElementById('noteTitleInput').value.trim();
    const body = document.getElementById('noteBodyInput').value;
    const tags = document.getElementById('noteTagsInput').value.split(',').map(t => t.trim()).filter(Boolean);
    if (!title && !body) { UI.toast('Note is empty', 'warn'); return; }
    if (activeNoteId) { DataStore.updateNote(activeNoteId, { title, body, tags }); UI.toast('Note saved ✓', 'success'); }
    else { const note = DataStore.addNote({ title, body, tags }); activeNoteId = note.id; UI.toast('Note created ✓', 'success'); }
    renderNotesList();
  }

  function deleteNote() {
    if (!activeNoteId) return;
    if (!confirm('Delete this note?')) return;
    DataStore.deleteNote(activeNoteId);
    activeNoteId = null;
    document.getElementById('noteEditorActive').style.display = 'none';
    document.getElementById('noteEditorEmpty').style.display = 'flex';
    renderNotesList();
    UI.toast('Note deleted', 'warn');
  }

  // ── MODAL ────────────────────────────────────────────────
  function bindModal() {
    document.getElementById('modalClose').addEventListener('click', UI.closeModal);
    document.getElementById('tradeModal').addEventListener('click', e => { if (e.target === e.currentTarget) UI.closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') UI.closeModal(); });
  }

  // ── EXPORT ───────────────────────────────────────────────
  function exportCSV() { downloadFile(DataStore.exportCSV(), 'tradeforge-trades.csv', 'text/csv'); UI.toast('CSV exported ✓', 'success'); }
  function exportAll() { downloadFile(DataStore.exportJSON(), 'tradeforge-backup.json', 'application/json'); UI.toast('Backup exported ✓', 'success'); }
  function downloadFile(content, filename, mime) { const blob = new Blob([content], { type: mime }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url); }

  // ── PUBLIC API ───────────────────────────────────────────
  return {
    init,
    navigateTo,
    viewTrade, editTrade, saveEditTrade, deleteTrade,
    showCalDay,
    openNote,
    goToPage,
    refreshDashboard,
    calcManualPnl,
    clearManualForm,
    openBalanceModal,
    signOut
  };
})();

document.addEventListener('DOMContentLoaded', App.init);

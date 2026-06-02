/* ============================================================
   data.js — Data Layer: Storage, Trade Model, Statistics
   
   RESPONSIBILITIES:
   - Persist trades/notes/settings to browser localStorage
   - Enrich raw trade data (calculate P&L, R-multiple, duration)
   - Migrate/fix existing saved data on startup
   - Compute all statistics used by Dashboard and Analytics
   ============================================================ */

// ── STORAGE KEYS ────────────────────────────────────────────
const DB_KEY       = 'tradeforge_v2';
const NOTES_KEY    = 'tradeforge_notes_v2';
const SETTINGS_KEY = 'tradeforge_settings_v1';

/* ============================================================
   DataStore — Singleton that manages all data operations.
   Exposes: addTrades, getTrades, updateTrade, deleteTrade,
            addNote, updateNote, deleteNote, getNotes,
            getSettings, saveSettings, exportJSON, exportCSV
   ============================================================ */
const DataStore = (() => {

  // ── IN-MEMORY STATE ───────────────────────────────────────
  let trades   = [];
  let notes    = [];
  let settings = { accountBalance: 10000, currency: 'USD' };

  // ── LOAD FROM LOCALSTORAGE ────────────────────────────────
  // Called once on startup. Loads saved data and runs migrations.
  function load() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      trades = raw ? JSON.parse(raw) : [];
    } catch (e) { trades = []; }

    try {
      const rn = localStorage.getItem(NOTES_KEY);
      notes = rn ? JSON.parse(rn) : [];
    } catch (e) { notes = []; }

    try {
      const rs = localStorage.getItem(SETTINGS_KEY);
      if (rs) settings = { ...settings, ...JSON.parse(rs) };
    } catch (e) {}

    // Fix any broken R values from old parser bugs
    migrateRMultiples();
  }

  // ── SAVE TO LOCALSTORAGE ──────────────────────────────────
  // Called after every data change to persist state.
  function save() {
    localStorage.setItem(DB_KEY, JSON.stringify(trades));
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  /* ----------------------------------------------------------
     migrateRMultiples
     Fixes trades saved with old wrong R formula (missing ×100).
     Old formula: risk = |entry-stop| * qty        → R = -99.99
     New formula: risk = |entry-stop| * qty * 100  → R = -1.00
     Runs silently on every page load.
  ---------------------------------------------------------- */
  function migrateRMultiples() {
    let changed = false;
    for (const t of trades) {
      // Re-enrich every trade to recalculate R with correct formula
      // Only update if R looks wrong (absolute value > 20 means bad formula)
      if (t.r !== undefined && Math.abs(t.r) > 20) {
        const fixed = enrichTrade({ ...t });
        t.r = fixed.r;
        changed = true;
      }
      // Also fix trades where R was calculated but stop/entry are now correctable
      if (t.stop && t.entry && t.r === undefined) {
        const fixed = enrichTrade({ ...t });
        t.r = fixed.r;
        if (t.r !== undefined) changed = true;
      }
    }
    if (changed) save();
  }

  // ── ADD MULTIPLE TRADES (import) ─────────────────────────
  // Deduplicates by composite key before inserting.
  // Returns count of newly added trades.
  function addTrades(newTrades) {
    const existing = new Set(trades.map(t => tradeKey(t)));
    const added = [];
    for (const t of newTrades) {
      const k = tradeKey(t);
      if (!existing.has(k)) {
        t.id = generateId();
        trades.push(t);
        existing.add(k);
        added.push(t);
      }
    }
    save();
    return added.length;
  }

  // ── ADD SINGLE TRADE (manual entry) ──────────────────────
  function addTrade(t) {
    t.id = generateId();
    trades.push(t);
    save();
    return t;
  }

  // ── UPDATE EXISTING TRADE ─────────────────────────────────
  // Re-enriches after update to recalculate P&L, R, duration.
  function updateTrade(id, changes) {
    const idx = trades.findIndex(t => t.id === id);
    if (idx !== -1) {
      trades[idx] = enrichTrade({ ...trades[idx], ...changes });
      save();
      return trades[idx];
    }
    return null;
  }

  // ── DELETE TRADE ─────────────────────────────────────────
  function deleteTrade(id) {
    trades = trades.filter(t => t.id !== id);
    save();
  }

  // ── GET TRADES WITH OPTIONAL DATE FILTER ─────────────────
  // filter.days = last N days | filter.ytd = year to date
  // Returns newest first.
  function getTrades(filter = {}) {
    let result = [...trades];
    if (filter.days) {
      const cutoff = Date.now() - filter.days * 86400000;
      result = result.filter(t => new Date(t.entryDate).getTime() >= cutoff);
    }
    if (filter.ytd) {
      const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime();
      result = result.filter(t => new Date(t.entryDate).getTime() >= jan1);
    }
    return result.sort((a, b) => new Date(b.entryDate) - new Date(a.entryDate));
  }

  // ── CLEAR ALL TRADES ─────────────────────────────────────
  function clearAll() {
    trades = [];
    save();
  }

  // ── NOTES CRUD ───────────────────────────────────────────
  function addNote(note) {
    note.id = generateId();
    note.createdAt = new Date().toISOString();
    note.updatedAt = new Date().toISOString();
    notes.unshift(note);
    save();
    return note;
  }

  function updateNote(id, changes) {
    const idx = notes.findIndex(n => n.id === id);
    if (idx !== -1) {
      notes[idx] = { ...notes[idx], ...changes, updatedAt: new Date().toISOString() };
      save();
      return notes[idx];
    }
    return null;
  }

  function deleteNote(id) {
    notes = notes.filter(n => n.id !== id);
    save();
  }

  function getNotes() { return [...notes]; }

  // ── SETTINGS ─────────────────────────────────────────────
  function getSettings()    { return { ...settings }; }
  function saveSettings(s)  { settings = { ...settings, ...s }; save(); }

  // ── EXPORT ───────────────────────────────────────────────
  function exportJSON() {
    return JSON.stringify({ trades, notes, settings, exportedAt: new Date().toISOString() }, null, 2);
  }

  function exportCSV() {
    const headers = ['date','symbol','side','qty','entry','exit','pnl','commission','r','duration','notes','tags'];
    const rows = trades.map(t => [
      t.entryDate, t.symbol, t.side, t.qty, t.entry, t.exit,
      t.pnl, t.commission || 0, t.r || '',
      t.duration || '',
      `"${(t.notes || '').replace(/"/g, '""')}"`,
      `"${(t.tags || []).join(',')}"`
    ].join(','));
    return [headers.join(','), ...rows].join('\n');
  }

  /* ----------------------------------------------------------
     enrichTrade
     Takes a raw trade object and calculates derived fields:
     - pnl:      Net profit/loss in USD
     - result:   WIN / LOSS / EVEN
     - r:        R-multiple (reward vs risk ratio)
     - duration: Trade duration in minutes

     R-multiple formula for forex/gold lots:
       risk_usd = |entry - stop| × lots × 100
       r = pnl / risk_usd
     The ×100 multiplier converts lot-distance to USD
     (1 lot of gold = 100 oz, $1 per pip per lot)

     Safety rules:
     - Requires SL at least 0.5 price units from entry
     - Caps R at ±20 to hide data errors
  ---------------------------------------------------------- */
  function enrichTrade(t) {
    const qty    = parseFloat(t.qty)   || 0;
    const entry  = parseFloat(t.entry) || 0;
    const exit   = parseFloat(t.exit)  || 0;
    const comm   = parseFloat(t.commission) || 0;
    const stop   = parseFloat(t.stop)  || 0;

    // ── P&L Calculation ──────────────────────────────────
    // If broker already provided P&L (Exness/MT), trust it.
    // Otherwise calculate from entry/exit/qty.
    if (t.pnl === undefined || t.pnl === null || isNaN(t.pnl)) {
      let rawPnl = 0;
      if (t.side === 'LONG')  rawPnl = (exit - entry) * qty;
      if (t.side === 'SHORT') rawPnl = (entry - exit) * qty;
      t.pnl = parseFloat((rawPnl - comm).toFixed(2));
    } else {
      t.pnl = parseFloat(parseFloat(t.pnl).toFixed(2));
    }

    // ── Result Classification ─────────────────────────────
    t.result = t.pnl >  0.001 ? 'WIN'
             : t.pnl < -0.001 ? 'LOSS'
             : 'EVEN';

    // ── R-Multiple Calculation ────────────────────────────
    // Only calculate when stop loss is meaningfully placed.
    // stopDist < 0.5 means the SL is basically at entry → skip.
    t.r = undefined; // reset first
    if (stop && entry) {
      const stopDist = Math.abs(entry - stop);
      if (stopDist >= 0.5) {
        // Forex/gold lots: multiply by 100 to convert to USD risk
        // Stocks/shares (qty >= 10): multiply by 1
        const isLots     = qty < 10;
        const multiplier = isLots ? 100 : 1;
        const riskUSD    = stopDist * qty * multiplier;
        if (riskUSD >= 1.0) {
          const raw = t.pnl / riskUSD;
          // Cap at ±20R — beyond this is almost certainly a data error
          if (Math.abs(raw) <= 20) {
            t.r = parseFloat(raw.toFixed(2));
          }
        }
      }
    }

    // ── Duration Calculation ──────────────────────────────
    // Duration in minutes between entry and exit time.
    if (t.entryDate && t.exitDate) {
      const ms = new Date(t.exitDate) - new Date(t.entryDate);
      if (ms > 0) t.duration = Math.round(ms / 60000);
    }

    return t;
  }

  // ── HELPER UTILITIES ─────────────────────────────────────

  // Generate a unique ID using timestamp + random string
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // Composite key for deduplication on import
  // Uses symbol + date + qty + entry + exit
  function tradeKey(t) {
    return `${t.symbol}_${t.entryDate}_${t.qty}_${t.entry}_${t.exit}`;
  }

  // ── INITIALISE ON LOAD ───────────────────────────────────
  load();

  // ── PUBLIC API ────────────────────────────────────────────
  return {
    addTrades, addTrade, updateTrade, deleteTrade, getTrades, clearAll,
    addNote, updateNote, deleteNote, getNotes,
    getSettings, saveSettings,
    exportJSON, exportCSV,
    enrichTrade
  };

})();

/* ============================================================
   Stats — Statistics Engine
   
   Computes all trading metrics from an array of trades.
   Used by Dashboard (summary cards + charts) and Analytics page.

   Returns a stats object containing:
   - Counts: total, wins, losses, even
   - P&L:    netPnl, grossWin, grossLoss, profitFactor
   - Rates:  winRate, avgWin, avgLoss, expectancy
   - R:      avgR, avgWinR, avgLossR
   - Risk:   maxDD, sharpe, stdDev
   - Streaks: maxWinStreak, maxLossStreak, currentStreak
   - Groupings: bySymbol, byHour, byDay, byMonth
   - Series: cumPnl (for equity curve chart)
   ============================================================ */
const Stats = (() => {

  /* ----------------------------------------------------------
     compute(trades)
     Main entry point. Pass an array of trade objects.
     Returns the full stats object.
  ---------------------------------------------------------- */
  function compute(trades) {
    if (!trades || !trades.length) return defaultStats();

    // Only include fully closed trades with valid P&L
    const closed = trades.filter(t => t.exit && t.pnl !== undefined && !isNaN(t.pnl));
    const wins   = closed.filter(t => t.pnl >  0.001);
    const losses = closed.filter(t => t.pnl < -0.001);
    const even   = closed.filter(t => Math.abs(t.pnl) <= 0.001);

    // ── Core P&L Metrics ─────────────────────────────────
    const netPnl       = closed.reduce((s, t) => s + t.pnl, 0);
    const grossWin     = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss    = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss
                       : grossWin > 0  ? Infinity : 0;
    const winRate      = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
    const avgWin       = wins.length   ? grossWin / wins.length   : 0;
    const avgLoss      = losses.length ? grossLoss / losses.length : 0;

    // ── Best and Worst Single Trade ───────────────────────
    const bestTrade  = closed.length ? closed.reduce((a, b) => a.pnl > b.pnl ? a : b) : null;
    const worstTrade = closed.length ? closed.reduce((a, b) => a.pnl < b.pnl ? a : b) : null;

    // ── Average Trade Duration ────────────────────────────
    const withDuration = closed.filter(t => t.duration);
    const avgDuration  = withDuration.length
      ? Math.round(withDuration.reduce((s, t) => s + t.duration, 0) / withDuration.length)
      : 0;

    // ── R-Multiple Averages ───────────────────────────────
    const withR    = closed.filter(t => t.r !== undefined && !isNaN(t.r));
    const winsR    = wins.filter(t => t.r !== undefined && !isNaN(t.r));
    const lossesR  = losses.filter(t => t.r !== undefined && !isNaN(t.r));
    const avgR     = withR.length   ? withR.reduce((s, t) => s + t.r, 0) / withR.length     : 0;
    const avgWinR  = winsR.length   ? winsR.reduce((s, t) => s + t.r, 0) / winsR.length     : 0;
    const avgLossR = lossesR.length ? lossesR.reduce((s, t) => s + t.r, 0) / lossesR.length : 0;

    // ── Expectancy ────────────────────────────────────────
    // Expected $ profit per trade on average
    const expectancy = (winRate / 100) * avgWin - ((100 - winRate) / 100) * avgLoss;

    // ── Win/Loss Streaks ──────────────────────────────────
    const { maxWinStreak, maxLossStreak, currentStreak } = calcStreaks(closed);

    // ── Max Drawdown ──────────────────────────────────────
    const maxDD = calcMaxDrawdown(closed);

    // ── Sharpe-like Ratio (simplified, per-trade) ─────────
    const pnls     = closed.map(t => t.pnl);
    const mean     = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / pnls.length;
    const stdDev   = Math.sqrt(variance);
    const sharpe   = stdDev > 0 ? mean / stdDev : 0;

    // ── Group by Symbol ───────────────────────────────────
    const bySymbol = {};
    for (const t of closed) {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { pnl: 0, count: 0, wins: 0 };
      bySymbol[t.symbol].pnl   += t.pnl;
      bySymbol[t.symbol].count += 1;
      if (t.pnl > 0) bySymbol[t.symbol].wins += 1;
    }

    // ── Group by Hour of Day ──────────────────────────────
    const byHour = {};
    for (const t of closed) {
      const h = new Date(t.entryDate).getHours();
      if (!byHour[h]) byHour[h] = { pnl: 0, count: 0 };
      byHour[h].pnl   += t.pnl;
      byHour[h].count += 1;
    }

    // ── Group by Day of Week ──────────────────────────────
    const byDay   = {};
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (const t of closed) {
      const d = dayNames[new Date(t.entryDate).getDay()];
      if (!byDay[d]) byDay[d] = { pnl: 0, count: 0 };
      byDay[d].pnl   += t.pnl;
      byDay[d].count += 1;
    }

    // ── Group by Month ────────────────────────────────────
    const byMonth = {};
    for (const t of closed) {
      const d   = new Date(t.entryDate);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!byMonth[key]) byMonth[key] = { pnl: 0, count: 0, wins: 0 };
      byMonth[key].pnl   += t.pnl;
      byMonth[key].count += 1;
      if (t.pnl > 0) byMonth[key].wins += 1;
    }

    // ── Cumulative P&L Series (for equity curve chart) ───
    const sorted = [...closed].sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));
    let cum = 0;
    const cumPnl = sorted.map(t => {
      cum += t.pnl;
      return { date: t.entryDate, pnl: parseFloat(cum.toFixed(2)), trade: t };
    });

    return {
      total: closed.length,
      wins: wins.length, losses: losses.length, even: even.length,
      netPnl, grossWin, grossLoss,
      profitFactor, winRate,
      avgWin, avgLoss,
      expectancy, avgR, avgWinR, avgLossR,
      bestTrade, worstTrade,
      avgDuration,
      maxWinStreak, maxLossStreak, currentStreak,
      maxDD, sharpe, stdDev,
      bySymbol, byHour, byDay, byMonth,
      cumPnl
    };
  }

  /* ----------------------------------------------------------
     defaultStats — Zero-value stats object.
     Returned when there are no trades to compute.
  ---------------------------------------------------------- */
  function defaultStats() {
    return {
      total: 0, wins: 0, losses: 0, even: 0,
      netPnl: 0, grossWin: 0, grossLoss: 0,
      profitFactor: 0, winRate: 0,
      avgWin: 0, avgLoss: 0,
      expectancy: 0, avgR: 0, avgWinR: 0, avgLossR: 0,
      bestTrade: null, worstTrade: null,
      avgDuration: 0,
      maxWinStreak: 0, maxLossStreak: 0, currentStreak: 0,
      maxDD: 0, sharpe: 0, stdDev: 0,
      bySymbol: {}, byHour: {}, byDay: {}, byMonth: {},
      cumPnl: []
    };
  }

  /* ----------------------------------------------------------
     calcStreaks — Consecutive win/loss streaks.
     Iterates trades in chronological order, tracking
     current and maximum consecutive win/loss runs.
  ---------------------------------------------------------- */
  function calcStreaks(trades) {
    let maxWin = 0, maxLoss = 0, curWin = 0, curLoss = 0;
    const sorted = [...trades].sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));
    for (const t of sorted) {
      if (t.pnl > 0) {
        curWin++; curLoss = 0;
        maxWin = Math.max(maxWin, curWin);
      } else if (t.pnl < 0) {
        curLoss++; curWin = 0;
        maxLoss = Math.max(maxLoss, curLoss);
      }
    }
    // Positive = win streak, negative = loss streak
    const currentStreak = curWin > 0 ? curWin : -curLoss;
    return { maxWinStreak: maxWin, maxLossStreak: maxLoss, currentStreak };
  }

  /* ----------------------------------------------------------
     calcMaxDrawdown — Largest peak-to-trough decline.
     Walks the cumulative P&L curve and tracks the biggest
     drop from any peak to any subsequent trough.
  ---------------------------------------------------------- */
  function calcMaxDrawdown(trades) {
    let peak = 0, maxDD = 0, cum = 0;
    const sorted = [...trades].sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));
    for (const t of sorted) {
      cum  += t.pnl;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
    }
    return parseFloat(maxDD.toFixed(2));
  }

  // ── PUBLIC API ────────────────────────────────────────────
  return { compute };

})();

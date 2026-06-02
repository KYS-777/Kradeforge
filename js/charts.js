/* ============================================================
   charts.js — All Chart.js Visualizations

   RESPONSIBILITIES:
   - Render all charts using Chart.js 4.4
   - Destroy and recreate charts on data refresh
   - Apply consistent dark theme colors throughout
   - Provide axis formatters for currency, %, duration

   CHARTS:
   Dashboard:  Cumulative P&L line, Win/Loss donut,
               Symbol P&L bar, Day distribution,  Hour P&L
   Analytics:  Monthly P&L, R-Multiple histogram,
               Drawdown curve, Symbol win rate,
               Duration scatter, Streak bar
   ============================================================ */

const Charts = (() => {
  const registry = {};

  const COLORS = {
    accent: '#f0a500',
    green: '#22c77a',
    red: '#ff4d6a',
    blue: '#4d9fff',
    purple: '#a78bfa',
    teal: '#2dd4bf',
    orange: '#fb923c',
    grid: 'rgba(255,255,255,0.05)',
    text: '#8892a4',
  };

  const defaults = {
    font: { family: 'Space Mono, monospace', size: 11 },
    color: COLORS.text,
  };

  Chart.defaults.font = defaults.font;
  Chart.defaults.color = defaults.color;

  function destroy(id) {
    if (registry[id]) { registry[id].destroy(); delete registry[id]; }
  }

  function get(id, type, data, options = {}) {
    destroy(id);
    const ctx = document.getElementById(id);
    if (!ctx) return null;
    const chart = new Chart(ctx, { type, data, options: deepMerge(baseOptions(type), options) });
    registry[id] = chart;
    return chart;
  }

  function baseOptions(type) {
    const base = {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e2330',
          borderColor: '#2e3848',
          borderWidth: 1,
          titleColor: '#d4dae8',
          bodyColor: '#8892a4',
          padding: 10,
          cornerRadius: 6,
        }
      }
    };

    if (['line', 'bar'].includes(type)) {
      base.scales = {
        x: {
          grid: { color: COLORS.grid },
          ticks: { maxRotation: 30 }
        },
        y: {
          grid: { color: COLORS.grid },
          ticks: {
            callback: (v) => formatCurrency(v)
          }
        }
      };
    }

    return base;
  }

  // ── CUMULATIVE P&L ──────────────────────────────────────
  function renderCumulativePnl(cumData) {
    if (!cumData.length) { destroy('cumulativePnlChart'); return; }

    const labels = cumData.map(d => fmtDate(d.date));
    const values = cumData.map(d => d.pnl);
    const isPositive = values[values.length - 1] >= 0;
    const color = isPositive ? COLORS.green : COLORS.red;

    get('cumulativePnlChart', 'line', {
      labels,
      datasets: [{
        data: values,
        borderColor: color,
        borderWidth: 2,
        pointRadius: cumData.length > 100 ? 0 : 3,
        pointHoverRadius: 5,
        fill: true,
        backgroundColor: (ctx) => {
          const c = ctx.chart.ctx;
          const g = c.createLinearGradient(0, 0, 0, 200);
          g.addColorStop(0, isPositive ? 'rgba(34,199,122,0.2)' : 'rgba(255,77,106,0.2)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          return g;
        },
        tension: 0.4
      }]
    }, {
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => `P&L: ${formatCurrency(ctx.raw)}`
          }
        }
      },
      scales: {
        y: {
          grid: { color: COLORS.grid },
          ticks: { callback: v => formatCurrency(v) }
        },
        x: {
          grid: { color: COLORS.grid },
          ticks: { maxTicksLimit: 12, maxRotation: 30 }
        }
      }
    });
  }

  // ── WIN/LOSS DONUT ───────────────────────────────────────
  function renderWinLoss(wins, losses, even) {
    destroy('winLossChart');
    const ctx = document.getElementById('winLossChart');
    if (!ctx || (!wins && !losses && !even)) return;

    registry['winLossChart'] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Wins', 'Losses', 'Even'],
        datasets: [{
          data: [wins, losses, even],
          backgroundColor: [
            'rgba(34,199,122,0.8)',
            'rgba(255,77,106,0.8)',
            'rgba(78,90,110,0.8)'
          ],
          borderColor: ['#22c77a', '#ff4d6a', '#4e5a6e'],
          borderWidth: 1,
          hoverOffset: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: '65%',
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: { boxWidth: 10, padding: 12, font: { size: 11 } }
          },
          tooltip: {
            backgroundColor: '#1e2330',
            borderColor: '#2e3848',
            borderWidth: 1,
            callbacks: {
              label: ctx => ` ${ctx.label}: ${ctx.raw} (${Math.round(ctx.raw / (wins + losses + even) * 100)}%)`
            }
          }
        }
      }
    });
  }

  // ── SYMBOL P&L BAR ──────────────────────────────────────
  function renderSymbolPnl(bySymbol) {
    const entries = Object.entries(bySymbol)
      .sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))
      .slice(0, 10);

    if (!entries.length) { destroy('symbolPnlChart'); return; }

    get('symbolPnlChart', 'bar', {
      labels: entries.map(([s]) => s),
      datasets: [{
        data: entries.map(([, v]) => v.pnl),
        backgroundColor: entries.map(([, v]) => v.pnl >= 0 ? 'rgba(34,199,122,0.7)' : 'rgba(255,77,106,0.7)'),
        borderColor: entries.map(([, v]) => v.pnl >= 0 ? COLORS.green : COLORS.red),
        borderWidth: 1,
        borderRadius: 4,
      }]
    }, {
      indexAxis: 'y',
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => ` P&L: ${formatCurrency(ctx.raw)}`
          }
        }
      },
      scales: {
        x: {
          grid: { color: COLORS.grid },
          ticks: { callback: v => formatCurrency(v) }
        },
        y: { grid: { color: COLORS.grid } }
      }
    });
  }

  // ── DAY DISTRIBUTION ────────────────────────────────────
  function renderDayDist(byDay) {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const counts = days.map(d => byDay[d] ? byDay[d].count : 0);
    const pnls = days.map(d => byDay[d] ? byDay[d].pnl : 0);

    get('dayDistChart', 'bar', {
      labels: days,
      datasets: [{
        label: 'Trades',
        data: counts,
        backgroundColor: 'rgba(77,159,255,0.6)',
        borderColor: COLORS.blue,
        borderWidth: 1,
        borderRadius: 4,
        yAxisID: 'y'
      }, {
        label: 'P&L',
        data: pnls,
        type: 'line',
        borderColor: COLORS.accent,
        borderWidth: 2,
        pointRadius: 4,
        fill: false,
        yAxisID: 'y2'
      }]
    }, {
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { boxWidth: 10, padding: 12, font: { size: 11 } }
        }
      },
      scales: {
        y: {
          position: 'left',
          grid: { color: COLORS.grid },
          ticks: { callback: v => v }
        },
        y2: {
          position: 'right',
          grid: { display: false },
          ticks: { callback: v => formatCurrency(v) }
        },
        x: { grid: { color: COLORS.grid } }
      }
    });
  }

  // ── HOUR P&L ────────────────────────────────────────────
  function renderHourPnl(byHour) {
    const hours = Array.from({ length: 24 }, (_, i) => i);
    const pnls = hours.map(h => byHour[h] ? byHour[h].pnl : 0);
    const labels = hours.map(h => `${String(h).padStart(2, '0')}:00`);

    get('hourPnlChart', 'bar', {
      labels,
      datasets: [{
        data: pnls,
        backgroundColor: pnls.map(v => v >= 0 ? 'rgba(34,199,122,0.6)' : 'rgba(255,77,106,0.6)'),
        borderColor: pnls.map(v => v >= 0 ? COLORS.green : COLORS.red),
        borderWidth: 1,
        borderRadius: 3,
      }]
    }, {
      scales: {
        y: { grid: { color: COLORS.grid }, ticks: { callback: v => formatCurrency(v) } },
        x: { grid: { color: COLORS.grid }, ticks: { maxTicksLimit: 12 } }
      }
    });
  }

  // ── MONTHLY P&L ──────────────────────────────────────────
  function renderMonthlyPnl(byMonth) {
    const sorted = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]));
    if (!sorted.length) { destroy('monthlyPnlChart'); return; }

    get('monthlyPnlChart', 'bar', {
      labels: sorted.map(([k]) => {
        const [y, m] = k.split('-');
        return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(m)-1]} ${y}`;
      }),
      datasets: [{
        data: sorted.map(([, v]) => v.pnl),
        backgroundColor: sorted.map(([, v]) => v.pnl >= 0 ? 'rgba(34,199,122,0.7)' : 'rgba(255,77,106,0.7)'),
        borderColor: sorted.map(([, v]) => v.pnl >= 0 ? COLORS.green : COLORS.red),
        borderWidth: 1,
        borderRadius: 6,
      }]
    }, {
      scales: {
        y: { grid: { color: COLORS.grid }, ticks: { callback: v => formatCurrency(v) } },
        x: { grid: { color: COLORS.grid }, ticks: { maxRotation: 45 } }
      }
    });
  }

  // ── R-MULTIPLE HISTOGRAM ──────────────────────────────────
  function renderRMultiple(trades) {
    const withR = trades.filter(t => t.r !== undefined && !isNaN(t.r));
    if (!withR.length) { destroy('rMultipleChart'); return; }

    const buckets = {};
    const step = 0.5;
    const min = Math.floor(Math.min(...withR.map(t => t.r)) / step) * step;
    const max = Math.ceil(Math.max(...withR.map(t => t.r)) / step) * step;

    for (let r = min; r <= max; r += step) {
      const key = r.toFixed(1);
      buckets[key] = 0;
    }
    for (const t of withR) {
      const key = (Math.floor(t.r / step) * step).toFixed(1);
      if (buckets[key] !== undefined) buckets[key]++;
    }

    const labels = Object.keys(buckets);
    const vals = Object.values(buckets);

    get('rMultipleChart', 'bar', {
      labels,
      datasets: [{
        data: vals,
        backgroundColor: labels.map(l => parseFloat(l) >= 0 ? 'rgba(34,199,122,0.7)' : 'rgba(255,77,106,0.7)'),
        borderColor: labels.map(l => parseFloat(l) >= 0 ? COLORS.green : COLORS.red),
        borderWidth: 1,
        borderRadius: 3,
      }]
    }, {
      scales: {
        y: { grid: { color: COLORS.grid }, ticks: { callback: v => v } },
        x: { grid: { color: COLORS.grid } }
      },
      plugins: {
        tooltip: {
          callbacks: {
            title: ctx => `R: ${ctx[0].label}`,
            label: ctx => ` Trades: ${ctx.raw}`
          }
        }
      }
    });
  }

  // ── DRAWDOWN CURVE ───────────────────────────────────────
  function renderDrawdown(trades) {
    if (!trades.length) { destroy('drawdownChart'); return; }

    const sorted = [...trades].sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));
    let peak = 0, cum = 0;
    const labels = [], dds = [];

    for (const t of sorted) {
      cum += t.pnl;
      if (cum > peak) peak = cum;
      dds.push(parseFloat((cum - peak).toFixed(2)));
      labels.push(fmtDate(t.entryDate));
    }

    get('drawdownChart', 'line', {
      labels,
      datasets: [{
        data: dds,
        borderColor: COLORS.red,
        borderWidth: 1.5,
        pointRadius: 0,
        fill: true,
        backgroundColor: 'rgba(255,77,106,0.15)',
        tension: 0.3
      }]
    }, {
      scales: {
        y: { grid: { color: COLORS.grid }, ticks: { callback: v => formatCurrency(v) } },
        x: { grid: { color: COLORS.grid }, ticks: { maxTicksLimit: 10 } }
      }
    });
  }

  // ── SYMBOL WIN RATE ──────────────────────────────────────
  function renderSymbolWinRate(bySymbol) {
    const entries = Object.entries(bySymbol)
      .filter(([, v]) => v.count >= 2)
      .map(([s, v]) => ({ symbol: s, winRate: (v.wins / v.count) * 100, count: v.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    if (!entries.length) { destroy('symbolWinRateChart'); return; }

    get('symbolWinRateChart', 'bar', {
      labels: entries.map(e => `${e.symbol} (${e.count})`),
      datasets: [{
        data: entries.map(e => e.winRate),
        backgroundColor: entries.map(e =>
          e.winRate >= 60 ? 'rgba(34,199,122,0.7)' :
          e.winRate >= 40 ? 'rgba(240,165,0,0.7)' : 'rgba(255,77,106,0.7)'
        ),
        borderRadius: 4,
        borderWidth: 0,
      }]
    }, {
      indexAxis: 'y',
      scales: {
        x: {
          grid: { color: COLORS.grid },
          min: 0, max: 100,
          ticks: { callback: v => v + '%' }
        },
        y: { grid: { color: COLORS.grid } }
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => ` Win Rate: ${ctx.raw.toFixed(1)}%`
          }
        }
      }
    });
  }

  // ── DURATION SCATTER ────────────────────────────────────
  function renderDurationScatter(trades) {
    const withDur = trades.filter(t => t.duration > 0 && t.pnl !== undefined);
    if (!withDur.length) { destroy('durationScatterChart'); return; }

    const wins = withDur.filter(t => t.pnl > 0);
    const losses = withDur.filter(t => t.pnl <= 0);

    get('durationScatterChart', 'scatter', {
      datasets: [
        {
          label: 'Wins',
          data: wins.map(t => ({ x: t.duration, y: t.pnl })),
          backgroundColor: 'rgba(34,199,122,0.6)',
          pointRadius: 4
        },
        {
          label: 'Losses',
          data: losses.map(t => ({ x: t.duration, y: t.pnl })),
          backgroundColor: 'rgba(255,77,106,0.6)',
          pointRadius: 4
        }
      ]
    }, {
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { boxWidth: 10, padding: 12, font: { size: 11 } }
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${formatDuration(ctx.raw.x)} | ${formatCurrency(ctx.raw.y)}`
          }
        }
      },
      scales: {
        x: {
          grid: { color: COLORS.grid },
          title: { display: true, text: 'Duration (min)', color: COLORS.text },
          ticks: { callback: v => formatDuration(v) }
        },
        y: {
          grid: { color: COLORS.grid },
          ticks: { callback: v => formatCurrency(v) }
        }
      }
    });
  }

  // ── STREAK CHART ─────────────────────────────────────────
  function renderStreaks(trades) {
    if (!trades.length) { destroy('streakChart'); return; }

    const sorted = [...trades].sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));
    const labels = [], streaks = [];
    let cur = 0;

    for (const t of sorted) {
      if (t.pnl > 0) cur = cur < 0 ? 1 : cur + 1;
      else if (t.pnl < 0) cur = cur > 0 ? -1 : cur - 1;
      labels.push(fmtDate(t.entryDate));
      streaks.push(cur);
    }

    get('streakChart', 'bar', {
      labels,
      datasets: [{
        data: streaks,
        backgroundColor: streaks.map(v => v > 0 ? 'rgba(34,199,122,0.7)' : 'rgba(255,77,106,0.7)'),
        borderColor: streaks.map(v => v > 0 ? COLORS.green : COLORS.red),
        borderWidth: 1,
        borderRadius: 3,
      }]
    }, {
      scales: {
        y: {
          grid: { color: COLORS.grid },
          ticks: { callback: v => v > 0 ? `+${v}W` : `${Math.abs(v)}L` }
        },
        x: { grid: { display: false }, ticks: { maxTicksLimit: 12 } }
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => ctx.raw > 0 ? ` ${ctx.raw} win streak` : ` ${Math.abs(ctx.raw)} loss streak`
          }
        }
      }
    });
  }

  // ── UTILITIES ────────────────────────────────────────────
  function formatCurrency(val) {
    if (val === 0) return '$0';
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    if (abs >= 1000000) return `${sign}$${(abs/1000000).toFixed(1)}M`;
    if (abs >= 10000)   return `${sign}$${(abs/1000).toFixed(1)}K`;
    if (abs >= 1000)    return `${sign}$${abs.toFixed(0)}`;
    return `${sign}$${abs.toFixed(2)}`;
  }

  function formatDuration(min) {
    if (min < 60) return `${min}m`;
    return `${Math.floor(min / 60)}h${min % 60 ? (min % 60) + 'm' : ''}`;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }

  return {
    renderCumulativePnl, renderWinLoss, renderSymbolPnl, renderDayDist, renderHourPnl,
    renderMonthlyPnl, renderRMultiple, renderDrawdown, renderSymbolWinRate,
    renderDurationScatter, renderStreaks,
    destroy
  };
})();

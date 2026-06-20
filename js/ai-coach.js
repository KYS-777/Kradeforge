/* ============================================================
   ai-coach.js — AI Trading Coach & Motivation Engine
   Uses Claude claude-sonnet-4-6 via Anthropic API (proxied through
   a simple fetch — user must supply their own key via settings,
   or we call through our own backend).

   FEATURES:
   1. AI Coach Chat — ask any trading question, get expert advice
   2. Trade Analysis — AI reviews a specific trade for mistakes/lessons
   3. Daily Briefing — AI generates morning insights from recent trades
   4. Weakness Detector — identifies patterns in losing trades
   5. Motivation System — XP, levels, badges, daily streaks
   6. Smart Nudges — context-aware tips shown on dashboard
   ============================================================ */

const AICoach = (() => {

  // ── STATE ─────────────────────────────────────────────────
  let chatHistory = [];
  let isThinking  = false;

  // ── MOTIVATION / GAMIFICATION ─────────────────────────────
  const LEVELS = [
    { min:0,     name:'Rookie',       icon:'🥉', color:'#94A3B8' },
    { min:100,   name:'Apprentice',   icon:'🥈', color:'#6B8EAF' },
    { min:300,   name:'Journeyman',   icon:'🥇', color:'#D4AF37' },
    { min:600,   name:'Skilled',      icon:'⚔️',  color:'#C9A84C' },
    { min:1000,  name:'Expert',       icon:'🏆',  color:'#10C98A' },
    { min:2000,  name:'Master',       icon:'💎',  color:'#9B78FA' },
    { min:5000,  name:'Elite',        icon:'👑',  color:'#FF4D6D' },
    { min:10000, name:'Legendary',    icon:'🌟',  color:'#F59E0B' },
  ];

  const BADGES = [
    { id:'first_trade',   name:'First Blood',    icon:'🎯', desc:'Logged your first trade',          check: t => t.length >= 1 },
    { id:'ten_trades',    name:'Getting Started', icon:'📈', desc:'Logged 10 trades',                 check: t => t.length >= 10 },
    { id:'fifty_trades',  name:'Dedicated',       icon:'💪', desc:'Logged 50 trades',                 check: t => t.length >= 50 },
    { id:'win_streak_3',  name:'Hot Hand',        icon:'🔥', desc:'3 wins in a row',                  check: t => getStreak(t) >= 3 },
    { id:'win_streak_5',  name:'On Fire',         icon:'🔥🔥',desc:'5 wins in a row',                 check: t => getStreak(t) >= 5 },
    { id:'win_streak_10', name:'Unstoppable',     icon:'⚡', desc:'10 wins in a row',                 check: t => getStreak(t) >= 10 },
    { id:'win_rate_60',   name:'Sharp Shooter',   icon:'🎖️', desc:'60%+ win rate (min 20 trades)',    check: t => t.length >= 20 && winRate(t) >= 60 },
    { id:'win_rate_70',   name:'Sniper',          icon:'🏹', desc:'70%+ win rate (min 30 trades)',    check: t => t.length >= 30 && winRate(t) >= 70 },
    { id:'profit_1k',     name:'First Thousand',  icon:'💵', desc:'$1,000 total profit',              check: t => netPnl(t) >= 1000 },
    { id:'profit_10k',    name:'Ten Grand',       icon:'💰', desc:'$10,000 total profit',             check: t => netPnl(t) >= 10000 },
    { id:'consistency',   name:'Consistent',      icon:'📊', desc:'Traded 5 days in a row',           check: t => tradingDayStreak(t) >= 5 },
    { id:'risk_master',   name:'Risk Master',     icon:'🛡️', desc:'Profit factor > 2.0 (min 20 trades)', check: t => t.length >= 20 && profitFactor(t) >= 2.0 },
    { id:'journal_10',    name:'Thoughtful',      icon:'📝', desc:'10 trades with notes',             check: t => t.filter(x => x.notes && x.notes.length > 10).length >= 10 },
    { id:'comeback',      name:'Comeback Kid',    icon:'💫', desc:'Recovered from a losing streak',   check: t => hasComeback(t) },
    { id:'diversified',   name:'Diversified',     icon:'🌐', desc:'Traded 5+ different instruments',  check: t => new Set(t.map(x => x.symbol)).size >= 5 },
  ];

  // helper fns
  function winRate(trades) {
    if (!trades.length) return 0;
    return (trades.filter(t => t.result === 'WIN').length / trades.length) * 100;
  }
  function netPnl(trades) {
    return trades.reduce((s, t) => s + (t.pnl || 0), 0);
  }
  function profitFactor(trades) {
    const gw = trades.filter(t => (t.pnl||0) > 0).reduce((s,t) => s+(t.pnl||0), 0);
    const gl = Math.abs(trades.filter(t => (t.pnl||0) < 0).reduce((s,t) => s+(t.pnl||0), 0));
    return gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
  }
  function getStreak(trades) {
    const sorted = [...trades].sort((a,b) => new Date(a.entryDate)-new Date(b.entryDate));
    let max = 0, cur = 0;
    for (const t of sorted) {
      if (t.result === 'WIN') { cur++; max = Math.max(max, cur); }
      else cur = 0;
    }
    return max;
  }
  function tradingDayStreak(trades) {
    if (!trades.length) return 0;
    const days = [...new Set(trades.map(t => t.entryDate?.slice(0,10)))].sort().reverse();
    let streak = 0;
    let prev = null;
    for (const d of days) {
      if (!prev) { streak = 1; prev = d; continue; }
      const diff = (new Date(prev) - new Date(d)) / 86400000;
      if (diff <= 2) { streak++; prev = d; } else break;
    }
    return streak;
  }
  function hasComeback(trades) {
    const sorted = [...trades].sort((a,b) => new Date(a.entryDate)-new Date(b.entryDate));
    let lossStreak = 0, hadLoss3 = false;
    for (const t of sorted) {
      if (t.result === 'LOSS') { lossStreak++; if (lossStreak >= 3) hadLoss3 = true; }
      else if (t.result === 'WIN' && hadLoss3) return true;
      else lossStreak = 0;
    }
    return false;
  }

  function calcXP(trades) {
    let xp = 0;
    xp += trades.length * 10;                                        // 10 XP per trade
    xp += trades.filter(t => t.result === 'WIN').length * 15;       // 15 bonus per win
    xp += trades.filter(t => t.notes && t.notes.length > 20).length * 8; // 8 XP for journaling
    xp += Math.max(0, Math.floor(netPnl(trades) / 100));            // 1 XP per $100 profit
    const wr = winRate(trades);
    if (wr >= 60) xp += 100;
    if (wr >= 70) xp += 200;
    const streak = getStreak(trades);
    xp += streak * 20;
    return Math.max(0, Math.round(xp));
  }

  function getLevel(xp) {
    let level = LEVELS[0];
    for (const l of LEVELS) { if (xp >= l.min) level = l; }
    return level;
  }

  function getNextLevel(xp) {
    for (let i = 0; i < LEVELS.length - 1; i++) {
      if (xp < LEVELS[i+1].min) return LEVELS[i+1];
    }
    return null;
  }

  function getEarnedBadges(trades) {
    return BADGES.filter(b => {
      try { return b.check(trades); } catch(e) { return false; }
    });
  }

  // ── MOTIVATION RENDER ─────────────────────────────────────
  function renderMotivation() {
    const trades = typeof DataStore !== 'undefined' ? DataStore.getTrades() : [];
    const xp     = calcXP(trades);
    const level  = getLevel(xp);
    const next   = getNextLevel(xp);
    const badges = getEarnedBadges(trades);
    const pct    = next ? Math.round(((xp - level.min) / (next.min - level.min)) * 100) : 100;

    const el = document.getElementById('motivationPanel');
    if (!el) return;

    el.innerHTML = `
      <div class="motiv-head">
        <div class="motiv-level-badge" style="color:${level.color}">
          <span class="motiv-level-icon">${level.icon}</span>
          <div>
            <div class="motiv-level-name">${level.name}</div>
            <div class="motiv-xp">${xp.toLocaleString()} XP</div>
          </div>
        </div>
        ${next ? `<div class="motiv-next">Next: ${next.icon} ${next.name} at ${next.min.toLocaleString()} XP</div>` : '<div class="motiv-next">🌟 Max Level!</div>'}
      </div>
      <div class="motiv-bar-wrap">
        <div class="motiv-bar-track">
          <div class="motiv-bar-fill" style="width:${pct}%;background:${level.color}"></div>
        </div>
        <span class="motiv-bar-pct">${pct}%</span>
      </div>
      <div class="motiv-badges">
        ${badges.length ? badges.map(b => `
          <div class="motiv-badge" title="${b.desc}">
            <span class="motiv-badge-icon">${b.icon}</span>
            <span class="motiv-badge-name">${b.name}</span>
          </div>`).join('') : '<div class="motiv-no-badges">Complete trades to earn badges</div>'}
      </div>
      <div class="motiv-tip">
        <span class="motiv-tip-icon">💡</span>
        <span>${getMotivTip(trades, xp, badges)}</span>
      </div>
    `;
  }

  function getMotivTip(trades, xp, badges) {
    if (!trades.length) return 'Log your first trade to start earning XP and unlock badges!';
    const wr = winRate(trades);
    const streak = getStreak(trades);
    const notes = trades.filter(t => t.notes && t.notes.length > 10).length;
    const pct = notes / trades.length;

    if (streak >= 5) return `🔥 ${streak}-win streak! You're in the zone — stay disciplined.`;
    if (wr < 40 && trades.length >= 10) return 'Focus on your setup quality. Less is more — wait for A+ setups.';
    if (pct < 0.3) return 'Adding notes earns +8 XP per trade and builds long-term edge. Journal more!';
    if (xp < 100) return 'You need 100 XP to reach Apprentice. Keep logging trades!';
    if (badges.length < 3) return 'You have unclaimed badges nearby — check your progress!';
    return 'Consistency beats perfection. Show up every day and trust the process.';
  }

  // ── SMART NUDGES ─────────────────────────────────────────
  function getNudge(trades) {
    if (!trades.length) return { icon:'👋', text:'Welcome! Log your first trade to begin your journey.', type:'info' };

    const recent = trades.slice(-5);
    const losses = recent.filter(t => t.result === 'LOSS').length;
    const wr = winRate(trades);
    const pf = profitFactor(trades);
    const unotes = trades.filter(t => !t.notes || t.notes.length < 5).length;
    const streak = getStreak(trades);
    const hour = new Date().getHours();

    if (losses >= 4) return { icon:'⚠️', text:'4 of your last 5 trades were losses. Consider taking a break and reviewing your setup criteria.', type:'warn' };
    if (streak >= 5) return { icon:'🔥', text:`${streak}-trade win streak! Stay disciplined — don't overtrade in euphoria.`, type:'success' };
    if (wr > 65 && trades.length >= 20) return { icon:'🎯', text:`Elite ${wr.toFixed(1)}% win rate! You have genuine edge — document what's working.`, type:'success' };
    if (pf < 1 && trades.length >= 10) return { icon:'📊', text:`Profit factor is ${pf.toFixed(2)}. Your losses outweigh wins. Review stop placement.`, type:'warn' };
    if (unotes > trades.length * 0.6) return { icon:'📝', text:'Most trades lack journal notes. Notes = learning = improvement. Start journaling!', type:'info' };
    if (hour >= 22 || hour < 6)  return { icon:'😴', text:'Late night trading is risky. Fatigue impairs decision-making. Consider rest.', type:'warn' };
    if (hour >= 8 && hour < 10) return { icon:'☀️', text:'Morning session — the best time for disciplined, focused trading. Good luck!', type:'info' };

    const msgs = [
      { icon:'💪', text:'Every trade is a lesson. Review, learn, improve.', type:'info' },
      { icon:'🎯', text:'Focus on process, not outcome. Good process = long-term profits.', type:'info' },
      { icon:'🧘', text:'Patience is an edge. Wait for your A+ setup.', type:'info' },
      { icon:'📈', text:'The best traders review their trades daily. Are you reviewing yours?', type:'info' },
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  function renderNudge() {
    const el = document.getElementById('smartNudge');
    if (!el) return;
    const trades = typeof DataStore !== 'undefined' ? DataStore.getTrades() : [];
    const nudge = getNudge(trades);
    el.className = `smart-nudge nudge-${nudge.type}`;
    el.innerHTML = `<span class="nudge-icon">${nudge.icon}</span><span class="nudge-text">${nudge.text}</span>`;
  }

  // ── AI COACH CHAT ─────────────────────────────────────────
  async function sendMessage(userMsg) {
    if (!userMsg.trim() || isThinking) return;
    isThinking = true;

    const trades  = typeof DataStore !== 'undefined' ? DataStore.getTrades() : [];
    const stats   = buildStatsContext(trades);

    chatHistory.push({ role: 'user', content: userMsg });
    renderChat();
    setThinking(true);

    const systemPrompt = `You are KradeForge AI Coach — an expert trading mentor with deep knowledge of technical analysis, risk management, trading psychology, and performance optimization.

The trader's current stats:
- Total trades: ${stats.total}
- Win rate: ${stats.winRate}%
- Net P&L: $${stats.netPnl}
- Profit factor: ${stats.pf}
- Avg win: $${stats.avgWin} | Avg loss: $${stats.avgLoss}
- Best symbol: ${stats.bestSymbol}
- Worst symbol: ${stats.worstSymbol}
- Current win streak: ${stats.winStreak}
- Most traded: ${stats.mostTraded}
- Notes coverage: ${stats.notesCoverage}% of trades have journal notes

Your role:
- Be direct, specific, and actionable — not generic
- Reference the trader's actual numbers when relevant
- Identify patterns in their data
- Give concrete improvement steps
- Be encouraging but honest about weaknesses
- Keep responses concise (3-5 sentences max unless deep analysis requested)
- Use emojis sparingly for clarity`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 600,
          system: systemPrompt,
          messages: chatHistory.slice(-10), // last 10 for context
        })
      });

      const data = await res.json();

      if (data.error) {
        // API key not set — give smart offline response
        const offlineReply = getOfflineResponse(userMsg, stats);
        chatHistory.push({ role: 'assistant', content: offlineReply });
      } else {
        const reply = data.content?.[0]?.text || 'I couldn\'t process that. Try again.';
        chatHistory.push({ role: 'assistant', content: reply });
      }
    } catch (e) {
      const offlineReply = getOfflineResponse(userMsg, stats);
      chatHistory.push({ role: 'assistant', content: offlineReply });
    }

    isThinking = false;
    setThinking(false);
    renderChat();
  }

  // Smart offline responses using actual trade data
  function getOfflineResponse(msg, stats) {
    const m = msg.toLowerCase();

    if (m.includes('win rate') || m.includes('winrate')) {
      if (stats.winRate >= 60) return `Your ${stats.winRate}% win rate is excellent! 🎯 Most profitable traders operate between 50-65%. Focus on maintaining this through strict setup criteria rather than chasing more trades.`;
      if (stats.winRate < 40) return `Your ${stats.winRate}% win rate needs attention. Focus on trade selection quality — only take setups where you have clear edge. Consider raising your minimum R:R to 2:1 to remain profitable even at low win rates.`;
      return `Your ${stats.winRate}% win rate is solid. To improve, review your losing trades for common patterns — are you entering too early, ignoring key levels, or trading against the trend?`;
    }

    if (m.includes('loss') || m.includes('losing') || m.includes('drawdown')) {
      return `With ${stats.total} trades and a $${stats.netPnl} net P&L, focus on cutting losers faster. Review your worst trades — most losing streaks come from not respecting your stop loss. Your profit factor is ${stats.pf}. Target 1.5+ for long-term success. 💪`;
    }

    if (m.includes('psychology') || m.includes('emotion') || m.includes('fear') || m.includes('greed')) {
      return `Trading psychology is 80% of success. With ${stats.winStreak} win streak currently, watch for overconfidence. Stick to your system size regardless of recent results. Write in your journal after every trade — it builds self-awareness. 🧘`;
    }

    if (m.includes('risk') || m.includes('position size') || m.includes('lot size')) {
      return `Risk management is your #1 priority. Never risk more than 1-2% per trade. With your current avg loss of $${stats.avgLoss}, make sure this represents ≤2% of your account. Your avg win of $${stats.avgWin} gives you a ${(stats.avgWin / Math.max(stats.avgLoss, 1)).toFixed(2)}:1 R:R ratio. 🛡️`;
    }

    if (m.includes('best') || m.includes('symbol') || m.includes('pair') || m.includes('instrument')) {
      return `Your best symbol is ${stats.bestSymbol || 'not yet determined'}. Focus there — specialization builds pattern recognition faster. Avoid overtrading multiple instruments until you master 1-2. Your worst performer is ${stats.worstSymbol || 'unknown'} — consider removing it from your watchlist. 📊`;
    }

    if (m.includes('improve') || m.includes('better') || m.includes('tip') || m.includes('advice')) {
      const tips = [];
      if (stats.notesCoverage < 50) tips.push('journal every trade with entry reason and lesson');
      if (parseFloat(stats.pf) < 1.5) tips.push('improve your R:R ratio by letting winners run');
      if (stats.winRate < 50) tips.push('be more selective — only A+ setups');
      if (!tips.length) tips.push('backtest your best setup on 3 more instruments');
      return `Top improvement for you right now: ${tips[0]}. Based on your data (${stats.winRate}% WR, ${stats.pf} PF, ${stats.total} trades), your biggest lever is ${tips[0]}. Take 1 week focused on just this. 🚀`;
    }

    if (m.includes('hello') || m.includes('hi') || m.includes('hey')) {
      return `Hey! I'm your KradeForge AI Coach. 👋 You have ${stats.total} trades logged with a ${stats.winRate}% win rate. What do you want to work on today? Ask me about your patterns, psychology, risk, or any specific trade.`;
    }

    return `Based on your ${stats.total} trades: ${stats.winRate}% win rate, $${stats.netPnl} net P&L, profit factor ${stats.pf}. ${stats.winRate >= 55 ? 'Your win rate is solid' : 'Win rate needs focus'}. ${parseFloat(stats.pf) >= 1.5 ? 'R:R is healthy' : 'Improve your R:R by letting winners run'}. What specific aspect do you want to improve? 📈`;
  }

  function buildStatsContext(trades) {
    if (!trades.length) return { total:0, winRate:'0', netPnl:'0.00', pf:'0.00', avgWin:'0.00', avgLoss:'0.00', bestSymbol:'—', worstSymbol:'—', winStreak:0, mostTraded:'—', notesCoverage:0 };

    const wins   = trades.filter(t => t.result === 'WIN');
    const losses = trades.filter(t => t.result === 'LOSS');
    const wr     = winRate(trades).toFixed(1);
    const pnl    = netPnl(trades).toFixed(2);
    const gw     = wins.reduce((s,t) => s+(t.pnl||0), 0);
    const gl     = Math.abs(losses.reduce((s,t) => s+(t.pnl||0), 0));
    const pf     = gl > 0 ? (gw/gl).toFixed(2) : gw > 0 ? '∞' : '0.00';
    const avgW   = wins.length ? (gw/wins.length).toFixed(2) : '0.00';
    const avgL   = losses.length ? (gl/losses.length).toFixed(2) : '0.00';

    // by symbol
    const bySymbol = {};
    for (const t of trades) {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { pnl:0, count:0 };
      bySymbol[t.symbol].pnl += (t.pnl||0);
      bySymbol[t.symbol].count++;
    }
    const syms = Object.entries(bySymbol);
    const bestSym  = syms.sort((a,b) => b[1].pnl-a[1].pnl)[0]?.[0] || '—';
    const worstSym = syms.sort((a,b) => a[1].pnl-b[1].pnl)[0]?.[0] || '—';
    const mostTraded = syms.sort((a,b) => b[1].count-a[1].count)[0]?.[0] || '—';

    const notesCov = Math.round((trades.filter(t => t.notes && t.notes.length > 10).length / trades.length) * 100);
    const streak = getStreak(trades);

    return { total:trades.length, winRate:wr, netPnl:pnl, pf, avgWin:avgW, avgLoss:avgL, bestSymbol:bestSym, worstSymbol:worstSym, winStreak:streak, mostTraded, notesCoverage:notesCov };
  }

  // ── TRADE ANALYSIS (AI reviews a specific trade) ──────────
  async function analyzeTrade(trade) {
    if (!trade) return;
    const msg = `Analyze this trade:
Symbol: ${trade.symbol} | Side: ${trade.side} | Qty: ${trade.qty}
Entry: $${trade.entry} | Exit: $${trade.exit || '—'} | Stop: ${trade.stop ? '$'+trade.stop : 'none set'}
P&L: $${trade.pnl?.toFixed(2)} | R-Multiple: ${trade.r ? trade.r.toFixed(2)+'R' : '—'}
Result: ${trade.result} | Duration: ${trade.duration ? trade.duration+'min' : '—'}
Notes: ${trade.notes || 'none'}

Give me: 1) What went well 2) What could be improved 3) One specific lesson`;

    openCoach();
    chatHistory.push({ role:'user', content:`📊 Analyzing trade: ${trade.symbol} ${trade.side} → ${trade.result} ($${trade.pnl?.toFixed(2)})` });
    renderChat();
    await sendMessageDirect(msg);
  }

  async function sendMessageDirect(msg) {
    chatHistory.push({ role:'user', content: msg });
    await sendMessage(''); // trigger with existing history
    chatHistory.pop(); chatHistory.pop(); // remove the duplicate
  }

  // ── DAILY BRIEFING ────────────────────────────────────────
  async function getDailyBriefing() {
    const trades  = typeof DataStore !== 'undefined' ? DataStore.getTrades() : [];
    const today   = new Date();
    const week    = trades.filter(t => {
      const d = new Date(t.entryDate);
      return (today - d) < 7 * 86400000;
    });

    const briefingEl = document.getElementById('dailyBriefing');
    if (!briefingEl) return;

    briefingEl.innerHTML = '<div class="briefing-loading"><div class="ai-spinner"></div> Generating your briefing…</div>';

    const stats = buildStatsContext(week);
    const prompt = `Generate a concise daily trading briefing (3 bullet points max) for this trader based on their last 7 days:
- Trades this week: ${week.length}
- This week P&L: $${stats.netPnl}  
- Win rate this week: ${stats.winRate}%
- Best instrument: ${stats.bestSymbol}
Format: start with one motivating sentence, then 3 specific action points for today. Be direct and personal.`;

    chatHistory = [];
    await sendMessage(prompt);

    const lastReply = chatHistory[chatHistory.length - 1];
    if (lastReply?.role === 'assistant') {
      briefingEl.innerHTML = `
        <div class="briefing-content">
          <div class="briefing-header">
            <span class="briefing-icon">☀️</span>
            <div>
              <div class="briefing-title">Daily Briefing</div>
              <div class="briefing-date">${today.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' })}</div>
            </div>
          </div>
          <div class="briefing-text">${lastReply.content.replace(/\n/g, '<br>')}</div>
        </div>`;
    }
    chatHistory = [];
  }

  // ── CHAT RENDER ───────────────────────────────────────────
  function renderChat() {
    const el = document.getElementById('coachChatMessages');
    if (!el) return;

    if (!chatHistory.length) {
      el.innerHTML = `
        <div class="coach-welcome">
          <div class="coach-welcome-icon">🤖</div>
          <div class="coach-welcome-title">KradeForge AI Coach</div>
          <div class="coach-welcome-sub">Ask me anything about your trading — patterns, psychology, risk, specific trades, or improvement areas.</div>
          <div class="coach-quick-btns">
            <button class="coach-quick" onclick="AICoach.quickAsk('Analyze my biggest weakness')">🔍 My Weaknesses</button>
            <button class="coach-quick" onclick="AICoach.quickAsk('How can I improve my win rate?')">📈 Improve Win Rate</button>
            <button class="coach-quick" onclick="AICoach.quickAsk('Give me a risk management tip')">🛡️ Risk Management</button>
            <button class="coach-quick" onclick="AICoach.quickAsk('Review my trading psychology')">🧘 Psychology</button>
          </div>
        </div>`;
      return;
    }

    el.innerHTML = chatHistory.map(msg => `
      <div class="chat-msg chat-${msg.role}">
        <div class="chat-avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
        <div class="chat-bubble">
          <div class="chat-text">${msg.content.replace(/\n/g, '<br>')}</div>
        </div>
      </div>`).join('');

    el.scrollTop = el.scrollHeight;
  }

  function setThinking(on) {
    const el = document.getElementById('coachChatMessages');
    if (!el) return;
    const existing = el.querySelector('.chat-thinking');
    if (on && !existing) {
      el.innerHTML += `
        <div class="chat-msg chat-assistant chat-thinking">
          <div class="chat-avatar">🤖</div>
          <div class="chat-bubble">
            <div class="thinking-dots"><span></span><span></span><span></span></div>
          </div>
        </div>`;
      el.scrollTop = el.scrollHeight;
    } else if (!on && existing) {
      existing.remove();
    }
  }

  // ── COACH PANEL ───────────────────────────────────────────
  function openCoach() {
    document.getElementById('coachPanel')?.classList.add('open');
    renderChat();
  }

  function closeCoach() {
    document.getElementById('coachPanel')?.classList.remove('open');
  }

  function clearChat() {
    chatHistory = [];
    renderChat();
  }

  function quickAsk(msg) {
    document.getElementById('coachInput').value = msg;
    sendFromInput();
  }

  function sendFromInput() {
    const input = document.getElementById('coachInput');
    if (!input) return;
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    sendMessage(msg);
  }

  // ── INIT ─────────────────────────────────────────────────
  function init() {
    renderMotivation();
    renderNudge();

    // Coach panel toggle
    document.getElementById('coachFab')?.addEventListener('click', openCoach);
    document.getElementById('coachClose')?.addEventListener('click', closeCoach);
    document.getElementById('coachClearBtn')?.addEventListener('click', clearChat);
    document.getElementById('coachOverlay')?.addEventListener('click', closeCoach);

    // Chat send
    document.getElementById('coachSendBtn')?.addEventListener('click', sendFromInput);
    document.getElementById('coachInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFromInput(); }
    });

    // Daily briefing
    document.getElementById('briefingRefreshBtn')?.addEventListener('click', getDailyBriefing);

    // Refresh motivation when trades change
    window.addEventListener('kf-trades-updated', () => {
      renderMotivation();
      renderNudge();
    });
  }

  return {
    init,
    openCoach,
    closeCoach,
    quickAsk,
    sendMessage,
    analyzeTrade,
    getDailyBriefing,
    renderMotivation,
    renderNudge,
  };

})();

document.addEventListener('DOMContentLoaded', AICoach.init);

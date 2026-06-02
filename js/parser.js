/* ============================================================
   parser.js — Broker File Parser & Auto-Detector

   RESPONSIBILITIES:
   - Accept CSV, XLSX, XLS files from any broker
   - Auto-detect broker format from headers/content
   - Parse each broker's specific column structure
   - Normalize symbols (XAUUSDm → XAU/USD)
   - Match BUY/SELL orders into round-trip trades (FIFO)
   - Handle Exness multi-line block format

   SUPPORTED BROKERS:
   Exness, Interactive Brokers, TD Ameritrade/Schwab,
   E*TRADE, Robinhood, Webull, Tastytrade, Fidelity,
   TradeStation, Generic CSV, MetaTrader MT4/MT5
   Supports: Exness CSV, Exness/MetaTrader block text,
   Interactive Brokers, TD Ameritrade, E*TRADE,
   Robinhood, Webull, Tastytrade, Schwab, Fidelity,
   TradeStation, Generic CSV, XLSX
   ============================================================ */

const BrokerParser = (() => {

  // ── MAIN ENTRY ──────────────────────────────────────────────
  async function parseFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    let rows = [];
    let rawText = '';
    let logMessages = [];

    log(`📄 File: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`, logMessages);

    if (ext === 'csv' || ext === 'txt') {
      rawText = await readText(file);

      // Try Exness block-format FIRST (symbol/side on separate lines)
      const exnessBlockResult = tryParseExnessBlock(rawText, logMessages);
      if (exnessBlockResult) return exnessBlockResult;

      // Parse as standard CSV
      rows = parseCSVText(rawText);
      log(`✓ Parsed CSV: ${rows.length} rows`, logMessages);

    } else if (ext === 'xlsx' || ext === 'xls') {
      rows = await parseXLSX(file);
      log(`✓ Parsed XLSX: ${rows.length} rows`, logMessages);
    } else {
      throw new Error(`Unsupported file type: .${ext}`);
    }

    if (!rows.length) throw new Error('No data rows found in file.');

    const broker = detectBroker(rows, file.name, rawText);
    log(`🔍 Detected broker: ${broker.name}`, logMessages, 'success');

    const trades = broker.parser(rows, logMessages);
    log(`✅ Parsed ${trades.length} trades`, logMessages, 'success');

    return { trades, broker: broker.name, logMessages };
  }

  // ════════════════════════════════════════════════════════════
  // EXNESS STANDARD CSV PARSER
  // Headers (confirmed from real file):
  // ticket, opening_time_utc, closing_time_utc, type, lots,
  // original_position_size, symbol, opening_price, closing_price,
  // stop_loss, take_profit, commission, swap, profit,
  // equity, margin_level, close_reason
  // ════════════════════════════════════════════════════════════
  function parseExnessCSV(rows, logMessages) {
    // Use key-based (not index-based) access — immune to empty-field column shifting
    // PapaParse gives us proper key→value objects, so row['profit'] is always correct
    const trades = [];
    const dataRows = rows.slice(1);

    // Build normalised header→original-key map
    const rawHeaders = getHeaders(rows);
    const keyMap = {};
    for (const h of rawHeaders) { keyMap[h.toLowerCase().trim()] = h; }

    const hdr = (...names) => {
      for (const n of names) {
        if (keyMap[n]) return keyMap[n];
        const found = Object.keys(keyMap).find(k => k.includes(n));
        if (found) return keyMap[found];
      }
      return null;
    };

    const kType      = hdr('type');
    const kLots      = hdr('lots');
    const kSymbol    = hdr('symbol');
    const kOpen      = hdr('opening_price', 'open_price');
    const kClose     = hdr('closing_price', 'close_price');
    const kProfit    = hdr('profit');
    const kComm      = hdr('commission');
    const kSwap      = hdr('swap');
    const kSL        = hdr('stop_loss', 'stoploss');
    const kOpenTime  = hdr('opening_time_utc', 'opening_time', 'open_time');
    const kCloseTime = hdr('closing_time_utc', 'closing_time', 'close_time');
    const kTicket    = hdr('ticket', 'order', 'position');
    const kReason    = hdr('close_reason', 'reason');

    log(`📋 Exness CSV — ${dataRows.length} trades detected`, logMessages);

    const gv = (row, key) => key ? String(row[key] || '').trim() : '';

    for (const row of dataRows) {
      try {
        const typeRaw = gv(row, kType).toLowerCase();
        if (typeRaw !== 'buy' && typeRaw !== 'sell') continue;

        const side   = typeRaw === 'buy' ? 'LONG' : 'SHORT';
        const symbol = normalizeSymbol(gv(row, kSymbol));
        const lots   = parseNum(gv(row, kLots));
        const entry  = parseNum(gv(row, kOpen));
        const exit   = parseNum(gv(row, kClose));
        const profit = parseNum(gv(row, kProfit));
        const commission = parseNum(gv(row, kComm)) || 0;
        const swap   = parseNum(gv(row, kSwap)) || 0;
        const sl     = parseNum(gv(row, kSL)) || undefined;
        const entryDate = parseDate(gv(row, kOpenTime));
        const exitDate  = parseDate(gv(row, kCloseTime));
        const ticket    = gv(row, kTicket);
        const reason    = gv(row, kReason);

        if (!symbol || !lots || !entry) continue;

        // Net P&L = profit + commission + swap (Exness provides all three)
        const netPnl = (isNaN(profit) ? 0 : profit) + commission + swap;

        const trade = DataStore.enrichTrade({
          symbol, side, qty: lots, entry, exit,
          stop: sl,
          pnl: netPnl,
          commission: Math.abs(commission),
          entryDate, exitDate,
          notes: `Ticket: ${ticket}${reason ? ' | ' + reason.toUpperCase() : ''}`,
          tags: ['exness', reason || 'closed']
        });

        trades.push(trade);
      } catch (e) {
        log(`⚠ Row error: ${e.message}`, logMessages, 'warn');
      }
    }

    return trades;
  }

  // ════════════════════════════════════════════════════════════
  // METATRADER GENERIC CSV
  // Handles MT4/MT5 statement exports with headers like:
  // Order/Position, Time, Type, Size, Price, S/L, T/P, Profit
  // ════════════════════════════════════════════════════════════
  function parseMetaTraderCSV(rows, logMessages) {
    const trades = [];
    const headers = getHeaders(rows).map(h => h.toLowerCase().trim());

    const col = (...names) => {
      for (const n of names) {
        const idx = headers.findIndex(h => h === n || h.includes(n));
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const iType    = col('type');
    const iSymbol  = col('symbol', 'item');
    const iSize    = col('size', 'lots', 'volume', 'qty');
    const iPrice   = col('price', 'open');
    const iClose   = col('close', 'exit');
    const iProfit  = col('profit');
    const iSL      = col('s/l', 'sl', 'stop');
    const iTP      = col('t/p', 'tp', 'take');
    const iTime    = col('time', 'open time', 'date');
    const iCloseT  = col('close time', 'exit time');

    for (const row of rows.slice(1)) {
      try {
        const vals = Object.values(row);
        const g = (i) => i !== -1 ? String(vals[i] || '').trim() : '';
        const typeRaw = g(iType).toLowerCase();
        if (typeRaw !== 'buy' && typeRaw !== 'sell') continue;

        const symbol = normalizeSymbol(g(iSymbol).toUpperCase());
        const side   = typeRaw === 'buy' ? 'LONG' : 'SHORT';
        const lots   = parseNum(g(iSize));
        const entry  = parseNum(g(iPrice));
        const exit   = parseNum(g(iClose));
        const profit = parseNum(g(iProfit));

        if (!symbol || !lots || !entry) continue;

        trades.push(DataStore.enrichTrade({
          symbol, side, qty: lots, entry, exit,
          stop: parseNum(g(iSL)) || undefined,
          pnl: isNaN(profit) ? undefined : profit,
          commission: 0,
          entryDate: parseDate(g(iTime)),
          exitDate: parseDate(g(iCloseT) || g(iTime)),
          notes: 'MetaTrader import',
          tags: ['metatrader']
        }));
      } catch(e) {}
    }
    return trades;
  }

  // ════════════════════════════════════════════════════════════
  // EXNESS BLOCK FORMAT (multi-line text, symbol on its own line)
  // XAU/USD
  // sell
  // 15 May 10:09:46  15 May 10:52:01  0.06  4,558.825  4,568.375  -57.30
  // ════════════════════════════════════════════════════════════
  function tryParseExnessBlock(text, logMessages) {
    const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
    const symbolLineRe = /^([A-Z]{2,6}[\/\-]?[A-Z]{0,6}(?:m)?)\s*$/i;
    const sideLineRe   = /^(buy|sell)\s*$/i;
    const dateTokenRe  = /\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2}:\d{2}/i;
    const mt4DateRe    = /\d{4}\.\d{2}\.\d{2}\s+\d{2}:\d{2}/;

    const lines = text.split('\n').map(l => l.trimEnd());
    const hasSymbolLine = lines.some(l => symbolLineRe.test(l.trim()));
    const hasSideLine   = lines.some(l => sideLineRe.test(l.trim()));
    const hasDateLine   = lines.some(l => dateTokenRe.test(l) || mt4DateRe.test(l));

    if (!hasSymbolLine || !hasSideLine || !hasDateLine) return null;

    log(`🔍 Detected Exness/MT block format`, logMessages, 'success');
    const trades = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();
      const symMatch = line.match(symbolLineRe);
      if (!symMatch) { i++; continue; }

      const rawSymbol = symMatch[1].toUpperCase();
      const symbol = normalizeSymbol(rawSymbol);

      let sideStr = null, sideIdx = -1;
      for (let j = i+1; j < Math.min(i+4, lines.length); j++) {
        if (sideLineRe.test(lines[j].trim())) { sideStr = lines[j].trim().toLowerCase(); sideIdx = j; break; }
      }
      if (!sideStr) { i++; continue; }

      let dataLine = null, dataIdx = -1;
      for (let j = sideIdx+1; j < Math.min(sideIdx+4, lines.length); j++) {
        const c = lines[j].trim();
        if ((dateTokenRe.test(c) || mt4DateRe.test(c)) && c.length > 20) { dataLine = c; dataIdx = j; break; }
      }
      if (!dataLine) { i++; continue; }

      // Extract dates
      const dateMatches = [];
      const dp1Re = /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2}:\d{2}(?::\d{2})?)/gi;
      let dm;
      while ((dm = dp1Re.exec(dataLine)) !== null) {
        const day = parseInt(dm[1]);
        const mon = MONTHS[dm[2].toLowerCase().slice(0,3)];
        const [h, min, sec] = dm[3].split(':').map(Number);
        const now = new Date();
        const d = new Date(now.getFullYear(), mon, day, h, min||0, sec||0);
        if (d > now) d.setFullYear(d.getFullYear() - 1);
        dateMatches.push(d.toISOString());
      }

      // Strip dates, extract numbers
      let numericPart = dataLine
        .replace(/\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2}:\d{2}(?::\d{2})?/gi, '')
        .trim();

      const numRe = /(-?\d{1,6}(?:,\d{3})*(?:\.\d+)?)/g;
      const nums = [];
      let nm;
      while ((nm = numRe.exec(numericPart)) !== null) {
        nums.push(parseFloat(nm[1].replace(/,(?=\d{3})/g, '')));
      }

      const lotsIdx = nums.findIndex(n => n > 0 && n < 200);
      const lots = lotsIdx !== -1 ? nums[lotsIdx] : nums[0];
      const rest = nums.slice(lotsIdx !== -1 ? lotsIdx + 1 : 1);
      const isGold = /XAU|GOLD/i.test(symbol);
      const priceNums = rest.filter(n => isGold ? (n > 500 && n < 9999) : (n > 0.1 && n < 99999));
      const profit = rest[rest.length - 1];

      const trade = DataStore.enrichTrade({
        symbol, side: sideStr === 'buy' ? 'LONG' : 'SHORT',
        qty: lots, entry: priceNums[0]||0, exit: priceNums[1]||priceNums[0]||0,
        pnl: profit,
        commission: 0,
        entryDate: dateMatches[0] || new Date().toISOString(),
        exitDate:  dateMatches[1] || dateMatches[0] || new Date().toISOString(),
        notes: `Exness/MT — ${rawSymbol} ${sideStr}`,
        tags: ['exness', 'metatrader']
      });

      if (trade.entry > 0 || trade.pnl !== undefined) trades.push(trade);
      i = dataIdx + 1;
    }

    if (!trades.length) return null;
    log(`✅ Imported ${trades.length} Exness/MT block trades`, logMessages, 'success');
    return { trades, broker: 'Exness / MetaTrader', logMessages };
  }

  // ── SYMBOL NORMALIZER ────────────────────────────────────
  function normalizeSymbol(raw) {
    if (!raw) return '';
    // Strip trailing broker suffixes: m, .r, .x etc.
    const s = raw.toUpperCase().replace(/M$/, '').replace(/\.[A-Z]+$/, '');
    const pairs = [
      ['XAUUSD','XAU/USD'], ['XAGUSD','XAG/USD'],
      ['EURUSD','EUR/USD'], ['GBPUSD','GBP/USD'], ['USDJPY','USD/JPY'],
      ['USDCHF','USD/CHF'], ['AUDUSD','AUD/USD'], ['NZDUSD','NZD/USD'],
      ['USDCAD','USD/CAD'], ['EURGBP','EUR/GBP'], ['EURJPY','EUR/JPY'],
      ['GBPJPY','GBP/JPY'], ['BTCUSD','BTC/USD'], ['ETHUSD','ETH/USD'],
      ['LTCUSD','LTC/USD'], ['XRPUSD','XRP/USD'], ['BNBUSD','BNB/USD'],
    ];
    for (const [from, to] of pairs) {
      if (s === from || s.startsWith(from)) return to;
    }
    if (s.includes('/')) return s;
    return s;
  }

  // ── BROKER DETECTION ────────────────────────────────────
  function detectBroker(rows, filename, rawText = '') {
    const fn = filename.toLowerCase();
    const headers = getHeaders(rows).map(h => h.toLowerCase().trim());
    const headerStr = headers.join('|');

    // Exness standard CSV (confirmed real format)
    if (headerStr.includes('opening_time_utc') ||
        headerStr.includes('closing_time_utc') ||
        (headerStr.includes('opening_price') && headerStr.includes('closing_price')) ||
        (headerStr.includes('ticket') && headerStr.includes('lots') && headerStr.includes('profit') && headerStr.includes('type'))) {
      return { name: 'Exness', parser: parseExnessCSV };
    }

    // MetaTrader generic CSV statement
    if ((headerStr.includes('size') && headerStr.includes('s/l') && headerStr.includes('t/p')) ||
        (headerStr.includes('order') && headerStr.includes('type') && headerStr.includes('size') && headerStr.includes('profit'))) {
      return { name: 'MetaTrader', parser: parseMetaTraderCSV };
    }

    // Interactive Brokers
    if (fn.includes('ib') || fn.includes('interactive') ||
        headerStr.includes('comm/fee') || headerStr.includes('t. price') ||
        headerStr.includes('realized p/l') ||
        (headerStr.includes('date/time') && headerStr.includes('quantity'))) {
      return { name: 'Interactive Brokers', parser: parseIBKR };
    }

    // TD Ameritrade / Schwab
    if (fn.includes('tda') || fn.includes('ameritrade') || fn.includes('schwab') ||
        (headerStr.includes('description') && headerStr.includes('action') && headerStr.includes('quantity') && headerStr.includes('amount'))) {
      return { name: 'TD Ameritrade / Schwab', parser: parseTDA };
    }

    // Tastytrade
    if (fn.includes('tastytrade') || headerStr.includes('root symbol') || headerStr.includes('call or put')) {
      return { name: 'Tastytrade', parser: parseTastytrade };
    }

    // E*TRADE
    if (fn.includes('etrade') || fn.includes('e-trade') ||
        (headerStr.includes('transaction type') && headerStr.includes('net amount'))) {
      return { name: 'E*TRADE', parser: parseETrade };
    }

    // Robinhood
    if (fn.includes('robinhood') ||
        (headerStr.includes('instrument') && headerStr.includes('average price')) ||
        (headerStr.includes('activity date') && headerStr.includes('process date'))) {
      return { name: 'Robinhood', parser: parseRobinhood };
    }

    // Webull
    if (fn.includes('webull') || (headerStr.includes('filled qty') && headerStr.includes('avg price'))) {
      return { name: 'Webull', parser: parseWebull };
    }

    // Fidelity
    if (fn.includes('fidelity') ||
        (headerStr.includes('run date') && headerStr.includes('action')) ||
        (headerStr.includes('settlement date') && headerStr.includes('security description'))) {
      return { name: 'Fidelity', parser: parseFidelity };
    }

    // TradeStation
    if (fn.includes('tradestation') || (headerStr.includes('order exec time') && headerStr.includes('open/close'))) {
      return { name: 'TradeStation', parser: parseTradeStation };
    }

    return { name: 'Generic CSV', parser: parseGeneric };
  }

  // ── INTERACTIVE BROKERS ──────────────────────────────────
  function parseIBKR(rows, logMessages) {
    const trades = [];
    let tradeRows = [], inTrades = false, headers = null;
    for (const row of rows) {
      const vals = Object.values(row);
      const first = (vals[0]||'').toString().trim();
      const second = (vals[1]||'').toString().trim().toLowerCase();
      if (first==='Trades' && second==='header') { headers=Object.values(row); inTrades=true; continue; }
      if (inTrades && first==='Trades' && second==='data') { const obj={}; headers.forEach((h,i)=>{obj[h]=vals[i];}); tradeRows.push(obj); }
      if (inTrades && first!=='Trades') inTrades=false;
    }
    if (!tradeRows.length) { const h=getHeaders(rows); tradeRows=rows.slice(1).map(row=>{const obj={};h.forEach((k,i)=>{obj[k]=Object.values(row)[i];});return obj;}); }
    for (const r of tradeRows) {
      try {
        const symbol=clean(r['Symbol']||''); if(!symbol||symbol==='Symbol') continue;
        const qty=parseFloat(clean(r['Quantity']||'0'));
        const entry=parseFloat(clean(r['T. Price']||r['Price']||'0'));
        const realizedPnl=parseFloat(clean(r['Realized P/L']||r['Realized P&L']||'0'));
        const commission=Math.abs(parseFloat(clean(r['Comm/Fee']||r['Commission']||'0')));
        const dateStr=clean(r['Date/Time']||r['Date']||'');
        if(!entry||!dateStr) continue;
        trades.push(DataStore.enrichTrade({ symbol:normalizeSymbol(symbol), side:qty<0?'SHORT':'LONG', qty:Math.abs(qty), entry, exit:entry+(qty!==0?realizedPnl/Math.abs(qty):0), pnl:realizedPnl, commission, entryDate:parseDate(dateStr), exitDate:parseDate(dateStr), notes:'Interactive Brokers', tags:['ibkr'] }));
      } catch(e){}
    }
    return trades;
  }

  // ── TD AMERITRADE / SCHWAB ───────────────────────────────
  function parseTDA(rows, logMessages) {
    const trades=[], headers=getHeaders(rows);
    for (const row of rows.slice(1)) {
      try {
        const r=mapRow(headers,row);
        const action=clean(r['Action']||r['Transaction Type']||'');
        const isBuy=/buy|bought/i.test(action), isSell=/sell|sold/i.test(action);
        if(!isBuy&&!isSell) continue;
        const symbol=normalizeSymbol(clean(r['Symbol']||r['Instrument']||'').toUpperCase());
        if(!symbol) continue;
        const qty=Math.abs(parseFloat(clean(r['Quantity']||r['Qty']||'0')));
        const price=parseFloat(clean(r['Price']||r['Avg Price']||'0'));
        const commission=Math.abs(parseFloat(clean(r['Fees & Comm']||r['Commission']||'0')));
        const dateStr=clean(r['Date']||r['Trade Date']||'');
        if(!qty||!price||!dateStr) continue;
        trades.push({ symbol, side:isBuy?'LONG':'SHORT', qty, entry:price, exit:null, commission, entryDate:parseDate(dateStr), notes:action, tags:['tda'] });
      } catch(e){}
    }
    return pairOrdersToTrades(trades);
  }

  // ── TASTYTRADE ────────────────────────────────────────────
  function parseTastytrade(rows, logMessages) {
    const trades=[], headers=getHeaders(rows);
    for (const row of rows.slice(1)) {
      try {
        const r=mapRow(headers,row);
        if(!/trade/i.test(clean(r['Type']||''))) continue;
        const action=clean(r['Action']||'').toLowerCase();
        const symbol=normalizeSymbol(clean(r['Symbol']||r['Root Symbol']||'').toUpperCase());
        const qty=Math.abs(parseFloat(clean(r['Quantity']||'0')));
        const price=parseFloat(clean(r['Average Price']||'0'));
        const commission=Math.abs(parseFloat(clean(r['Commissions']||'0')))+Math.abs(parseFloat(clean(r['Fees']||'0')));
        const dateStr=clean(r['Date']||r['Executed At']||'');
        if(!symbol||!qty||!dateStr) continue;
        trades.push({ symbol, side:action.includes('buy')?'LONG':'SHORT', qty, entry:price, exit:null, commission, entryDate:parseDate(dateStr), notes:`Tastytrade: ${action}`, tags:['tastytrade'] });
      } catch(e){}
    }
    return pairOrdersToTrades(trades);
  }

  // ── E*TRADE ───────────────────────────────────────────────
  function parseETrade(rows, logMessages) {
    const trades=[], headers=getHeaders(rows);
    for (const row of rows.slice(1)) {
      try {
        const r=mapRow(headers,row);
        const txType=clean(r['Transaction Type']||r['Action']||'');
        const isBuy=/bought|buy/i.test(txType), isSell=/sold|sell/i.test(txType);
        if(!isBuy&&!isSell) continue;
        const symbol=normalizeSymbol(clean(r['Symbol']||'').toUpperCase());
        const qty=Math.abs(parseFloat(clean(r['Quantity']||r['Shares/Quantity']||'0')));
        const price=parseFloat(clean(r['Price']||r['Price/Share']||'0'));
        const commission=Math.abs(parseFloat(clean(r['Commission']||'0')));
        const dateStr=clean(r['Transaction Date']||r['Date']||'');
        if(!symbol||!qty||!price||!dateStr) continue;
        trades.push({ symbol, side:isBuy?'LONG':'SHORT', qty, entry:price, exit:null, commission, entryDate:parseDate(dateStr), notes:`E*TRADE: ${txType}`, tags:['etrade'] });
      } catch(e){}
    }
    return pairOrdersToTrades(trades);
  }

  // ── ROBINHOOD ────────────────────────────────────────────
  function parseRobinhood(rows, logMessages) {
    const trades=[], headers=getHeaders(rows);
    for (const row of rows.slice(1)) {
      try {
        const r=mapRow(headers,row);
        const side=clean(r['Side']||r['Trans Code']||'').toUpperCase();
        const isBuy=/buy/i.test(side), isSell=/sell/i.test(side);
        if(!isBuy&&!isSell) continue;
        const symbol=normalizeSymbol(clean(r['Instrument']||r['Symbol']||'').toUpperCase());
        const qty=Math.abs(parseFloat(clean(r['Quantity']||r['Shares']||'0')));
        const price=parseFloat(clean(r['Average Price']||r['Price']||'0'));
        const dateStr=clean(r['Date']||r['Activity Date']||'');
        if(!symbol||!qty||!price||!dateStr) continue;
        trades.push({ symbol, side:isBuy?'LONG':'SHORT', qty, entry:price, exit:null, commission:0, entryDate:parseDate(dateStr), notes:'Robinhood', tags:['robinhood'] });
      } catch(e){}
    }
    return pairOrdersToTrades(trades);
  }

  // ── WEBULL ───────────────────────────────────────────────
  function parseWebull(rows, logMessages) {
    const trades=[], headers=getHeaders(rows);
    for (const row of rows.slice(1)) {
      try {
        const r=mapRow(headers,row);
        const side=clean(r['Side']||r['Action']||'').toUpperCase();
        const isBuy=/buy/i.test(side), isSell=/sell/i.test(side);
        if(!isBuy&&!isSell) continue;
        const symbol=normalizeSymbol(clean(r['Symbol']||r['Ticker']||'').toUpperCase());
        const qty=Math.abs(parseFloat(clean(r['Filled Qty']||r['Quantity']||'0')));
        const price=parseFloat(clean(r['Avg Price']||r['Average Price']||r['Price']||'0'));
        const commission=Math.abs(parseFloat(clean(r['Commission']||r['Fees']||'0')));
        const dateStr=clean(r['Filled Time']||r['Date']||'');
        if(!symbol||!qty||!price||!dateStr) continue;
        trades.push({ symbol, side:isBuy?'LONG':'SHORT', qty, entry:price, exit:null, commission, entryDate:parseDate(dateStr), notes:'Webull', tags:['webull'] });
      } catch(e){}
    }
    return pairOrdersToTrades(trades);
  }

  // ── FIDELITY ──────────────────────────────────────────────
  function parseFidelity(rows, logMessages) {
    const trades=[], headers=getHeaders(rows);
    for (const row of rows.slice(1)) {
      try {
        const r=mapRow(headers,row);
        const action=clean(r['Action']||r['Transaction Type']||'');
        const isBuy=/bought|buy/i.test(action), isSell=/sold|sell/i.test(action);
        if(!isBuy&&!isSell) continue;
        const symbol=normalizeSymbol(clean(r['Symbol']||r['Security']||'').toUpperCase());
        const qty=Math.abs(parseFloat(clean(r['Quantity']||r['Shares']||'0')));
        const price=parseFloat(clean(r['Price']||'0'));
        const commission=Math.abs(parseFloat(clean(r['Commission']||r['Fees']||'0')));
        const dateStr=clean(r['Run Date']||r['Trade Date']||'');
        if(!symbol||!qty||!price||!dateStr) continue;
        trades.push({ symbol, side:isBuy?'LONG':'SHORT', qty, entry:price, exit:null, commission, entryDate:parseDate(dateStr), notes:`Fidelity: ${action}`, tags:['fidelity'] });
      } catch(e){}
    }
    return pairOrdersToTrades(trades);
  }

  // ── TRADESTATION ──────────────────────────────────────────
  function parseTradeStation(rows, logMessages) {
    const trades=[], headers=getHeaders(rows);
    for (const row of rows.slice(1)) {
      try {
        const r=mapRow(headers,row);
        const action=clean(r['Buy/Sell']||r['Side']||r['Action']||'');
        const isBuy=/buy/i.test(action), isSell=/sell/i.test(action);
        if(!isBuy&&!isSell) continue;
        const symbol=normalizeSymbol(clean(r['Symbol']||'').toUpperCase());
        const qty=Math.abs(parseFloat(clean(r['Qty']||r['Quantity']||'0')));
        const price=parseFloat(clean(r['Exec Price']||r['Price']||'0'));
        const commission=Math.abs(parseFloat(clean(r['Commission']||'0')));
        const dateStr=clean(r['Order Exec Time']||r['Date']||'');
        if(!symbol||!qty||!price||!dateStr) continue;
        trades.push({ symbol, side:isBuy?'LONG':'SHORT', qty, entry:price, exit:null, commission, entryDate:parseDate(dateStr), notes:'TradeStation', tags:['tradestation'] });
      } catch(e){}
    }
    return pairOrdersToTrades(trades);
  }

  // ── GENERIC CSV ───────────────────────────────────────────
  function parseGeneric(rows, logMessages) {
    const trades=[];
    const headers=getHeaders(rows).map(h=>h.toLowerCase().trim());
    const find=(...candidates)=>{ for(const c of candidates){const idx=headers.findIndex(h=>h.includes(c.toLowerCase()));if(idx!==-1)return idx;} return -1; };
    const colMap={
      symbol:find('symbol','ticker','instrument','stock','asset'),
      side:find('side','action','type','direction','buy/sell'),
      qty:find('qty','quantity','shares','size','lots','volume'),
      entry:find('entry','buy price','open price','opening_price','avg','price','open'),
      exit:find('exit','sell price','close price','closing_price','exit price','close'),
      pnl:find('pnl','p&l','profit','gain','net'),
      commission:find('commission','comm','fee','fees'),
      date:find('opening_time','open_time','date','time','datetime','trade date','entry date'),
      exitdate:find('closing_time','close_time','exit date','close date','exit time'),
      stop:find('stop_loss','stop','sl'),
      notes:find('note','comment','remark','desc','close_reason'),
      tags:find('tag','label','category'),
    };
    const g=(row,col)=>{if(col===-1)return '';const vals=Object.values(row);return clean(vals[col]||'');};
    for(const row of rows.slice(1)){
      try{
        const symbol=normalizeSymbol(g(row,colMap.symbol).toUpperCase());
        if(!symbol||symbol==='SYMBOL') continue;
        const rawSide=g(row,colMap.side).toLowerCase();
        const side=/sell|short/.test(rawSide)?'SHORT':'LONG';
        const qty=Math.abs(parseFloat(g(row,colMap.qty))||0);
        const entry=parseFloat(g(row,colMap.entry))||0;
        const exit=parseFloat(g(row,colMap.exit))||0;
        const pnlRaw=g(row,colMap.pnl);
        const pnl=pnlRaw?parseFloat(pnlRaw):undefined;
        const commission=Math.abs(parseFloat(g(row,colMap.commission))||0);
        const dateStr=g(row,colMap.date);
        const exitDateStr=g(row,colMap.exitdate);
        if(!symbol||!dateStr) continue;
        const trade=DataStore.enrichTrade({
          symbol,side,qty,entry,exit:exit||entry,
          stop:parseFloat(g(row,colMap.stop))||undefined,
          pnl:pnl!==undefined?pnl:undefined,commission,
          entryDate:parseDate(dateStr),
          exitDate:exitDateStr?parseDate(exitDateStr):parseDate(dateStr),
          notes:g(row,colMap.notes),
          tags:g(row,colMap.tags)?g(row,colMap.tags).split(/[,;]/).map(t=>t.trim()):['imported']
        });
        if(trade.entry>0) trades.push(trade);
      }catch(e){}
    }
    return trades;
  }

  // ── TRADE PAIRING (FIFO) ─────────────────────────────────
  function pairOrdersToTrades(orders) {
    const trades=[], bySymbol={};
    for(const o of orders){
      if(!bySymbol[o.symbol]) bySymbol[o.symbol]={buys:[],sells:[]};
      if(o.side==='LONG') bySymbol[o.symbol].buys.push(o);
      else bySymbol[o.symbol].sells.push(o);
    }
    for(const [symbol,{buys,sells}] of Object.entries(bySymbol)){
      buys.sort((a,b)=>new Date(a.entryDate)-new Date(b.entryDate));
      sells.sort((a,b)=>new Date(a.entryDate)-new Date(b.entryDate));
      let bi=0,si=0,buyRemain=buys[0]?buys[0].qty:0,sellRemain=sells[0]?sells[0].qty:0;
      while(bi<buys.length&&si<sells.length){
        const buy=buys[bi],sell=sells[si];
        const matchQty=Math.min(buyRemain,sellRemain);
        const entryFirst=new Date(buy.entryDate)<=new Date(sell.entryDate);
        const entry_=entryFirst?buy:sell, exit_=entryFirst?sell:buy;
        const commission=((buy.commission||0)+(sell.commission||0))*(matchQty/buy.qty);
        trades.push(DataStore.enrichTrade({ symbol, side:entryFirst?'LONG':'SHORT', qty:matchQty, entry:entry_.entry, exit:exit_.entry, stop:entry_.stop, commission, entryDate:entry_.entryDate, exitDate:exit_.entryDate, notes:buy.notes||sell.notes||'', tags:[...new Set([...(buy.tags||[]),...(sell.tags||[])])] }));
        buyRemain-=matchQty; sellRemain-=matchQty;
        if(buyRemain<=0.001){bi++;buyRemain=buys[bi]?buys[bi].qty:0;}
        if(sellRemain<=0.001){si++;sellRemain=sells[si]?sells[si].qty:0;}
      }
      while(bi<buys.length){const b=buys[bi++];trades.push(DataStore.enrichTrade({...b,exit:b.entry,pnl:0,result:'OPEN',exitDate:null,notes:(b.notes||'')+' [OPEN]'}));}
    }
    return trades;
  }

  // ── FILE UTILITIES ───────────────────────────────────────
  function readText(file) {
    return new Promise((res,rej)=>{const r=new FileReader();r.onload=e=>res(e.target.result);r.onerror=()=>rej(new Error('File read error'));r.readAsText(file,'UTF-8');});
  }

  function parseCSVText(text) {
    const t=text.replace(/^\uFEFF/,'');
    const result=Papa.parse(t,{header:true,skipEmptyLines:true,dynamicTyping:false,transformHeader:h=>h.trim()});
    return result.data;
  }

  async function parseXLSX(file) {
    return new Promise((res,rej)=>{
      const r=new FileReader();
      r.onload=e=>{try{const wb=XLSX.read(e.target.result,{type:'array',cellDates:true});const ws=wb.Sheets[wb.SheetNames[0]];res(XLSX.utils.sheet_to_json(ws,{raw:false,defval:''}));}catch(err){rej(err);}};
      r.onerror=()=>rej(new Error('XLSX read error'));r.readAsArrayBuffer(file);
    });
  }

  function getHeaders(rows){return rows.length?Object.keys(rows[0]):[];}
  function mapRow(headers,row){const vals=Object.values(row);const obj={};headers.forEach((h,i)=>{obj[h]=vals[i];});return obj;}
  function clean(val){if(val===null||val===undefined)return '';return String(val).replace(/[$%"']/g,'').replace(/,(?=\d{3})/g,'').trim();}
  function parseNum(val){if(val===null||val===undefined||val==='')return NaN;return parseFloat(String(val).replace(/,(?=\d{3})/g,'').trim());}

  function parseDate(str) {
    if(!str) return new Date().toISOString();
    try {
      const s=str.trim();
      // ISO format: 2026-05-26T10:46:06 or 2026-05-26 10:46:06
      const d=new Date(s.replace(' ','T'));
      if(!isNaN(d.getTime())) return d.toISOString();
      // MT date: "15 May 10:09:46"
      const MONTHS={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
      const mtMatch=s.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*(\d{4})?\s*(\d{2}:\d{2}(?::\d{2})?)?/i);
      if(mtMatch){
        const day=parseInt(mtMatch[1]),mon=MONTHS[mtMatch[2].toLowerCase().slice(0,3)];
        const year=mtMatch[3]?parseInt(mtMatch[3]):new Date().getFullYear();
        const [h,m2,sc]=(mtMatch[4]||'0:0:0').split(':').map(Number);
        const dt=new Date(year,mon,day,h,m2||0,sc||0);
        if(!isNaN(dt)){if(dt>new Date())dt.setFullYear(dt.getFullYear()-1);return dt.toISOString();}
      }
      // MT4: 2024.05.15 10:09
      const mt4=s.match(/(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)?/);
      if(mt4){const dt=new Date(`${mt4[1]}-${mt4[2]}-${mt4[3]}T${mt4[4]||'00:00'}`);if(!isNaN(dt))return dt.toISOString();}
      // US: MM/DD/YYYY
      const us=s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if(us){const y=us[3].length===2?2000+parseInt(us[3]):parseInt(us[3]);const dt=new Date(y,parseInt(us[1])-1,parseInt(us[2]));if(!isNaN(dt))return dt.toISOString();}
    } catch(e){}
    return new Date().toISOString();
  }

  function log(msg,arr,type=''){arr.push({msg,type});}

  return { parseFile };
})();

/* ============================================================
   parser.js — Broker File Parser & Auto-Detector
   
   RESPONSIBILITIES:
   - Accept CSV, XLSX, XLS, TXT files from any broker
   - Auto-detect broker format from headers/filename/content
   - Parse each broker's specific column structure
   - Normalize symbols (XAUUSDm → XAU/USD)
   - Match BUY/SELL orders into round-trip trades (FIFO)
   - Handle Exness multi-line block text format

   SUPPORTED BROKERS (20 total):
   ─────────────────────────────────────────────────────────
   MetaTrader / Forex Brokers:
   1.  Exness MT5 CSV         (your confirmed format)
   2.  Exness MT4 CSV
   3.  MetaTrader 4 Standard  (XM, IC Markets, FxPro, AvaTrade...)
   4.  MetaTrader 5 Standard  (Pepperstone, FTMO, etc.)
   5.  OANDA
   6.  Plus500
   7.  eToro
   8.  Capital.com
   9.  Deriv / Binary.com

   Crypto Brokers:
   10. Binance (spot + futures)
   11. Bybit

   US Stock Brokers:
   12. Interactive Brokers (IBKR)
   13. TD Ameritrade / Schwab
   14. E*TRADE
   15. Robinhood
   16. Webull
   17. Tastytrade
   18. Fidelity
   19. TradeStation

   Fallback:
   20. Generic CSV (auto-detects columns by name)
   ============================================================ */

const BrokerParser = (() => {

  // ── MAIN ENTRY POINT ─────────────────────────────────────
  async function parseFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    let rows = [], rawText = '', logMessages = [];

    log(`📄 File: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`, logMessages);

    if (ext === 'csv' || ext === 'txt' || ext === 'htm' || ext === 'html') {
      rawText = await readText(file);

      // Try Exness block-format first (symbol/side on separate lines)
      const blockResult = tryParseExnessBlock(rawText, logMessages);
      if (blockResult) return blockResult;

      rows = parseCSVText(rawText);
      log(`✓ Parsed CSV: ${rows.length} rows`, logMessages);

    } else if (ext === 'xlsx' || ext === 'xls') {
      rows = await parseXLSX(file);
      log(`✓ Parsed XLSX: ${rows.length} rows`, logMessages);
    } else {
      throw new Error(`Unsupported file type: .${ext}. Use CSV, XLSX, or TXT.`);
    }

    if (!rows.length) throw new Error('No data rows found. Check the file has trade data.');

    const broker = detectBroker(rows, file.name, rawText);
    log(`🔍 Detected broker: ${broker.name}`, logMessages, 'success');

    const trades = broker.parser(rows, logMessages);
    log(`✅ Parsed ${trades.length} trades from ${broker.name}`, logMessages, 'success');

    return { trades, broker: broker.name, logMessages };
  }

  // ══════════════════════════════════════════════════════════
  // BROKER DETECTION
  // Checks filename + headers to identify which parser to use.
  // Order matters — most specific checks first.
  // ══════════════════════════════════════════════════════════
  function detectBroker(rows, filename, rawText = '') {
    const fn  = filename.toLowerCase();
    const hdrs = getHeaders(rows).map(h => h.toLowerCase().trim());
    const hs  = hdrs.join('|');

    // ── EXNESS MT5 (confirmed real format) ──────────────────
    // Headers: ticket, opening_time_utc, closing_time_utc, type, lots, symbol, opening_price...
    if (hs.includes('opening_time_utc') || hs.includes('closing_time_utc') ||
        (hs.includes('opening_price') && hs.includes('closing_price') && hs.includes('lots'))) {
      return { name: 'Exness MT5', parser: parseExnessMT5 };
    }

    // ── EXNESS MT4 ───────────────────────────────────────────
    // Headers: Ticket, Open Time, Type, Lots, Symbol, Open Price, S/L, T/P, Close Time, Close Price...
    if (fn.includes('exness') ||
        (hs.includes('ticket') && hs.includes('open time') && hs.includes('lots') &&
         hs.includes('open price') && hs.includes('close price'))) {
      return { name: 'Exness MT4', parser: parseExnessMT4 };
    }

    // ── METATRADER 5 STANDARD ────────────────────────────────
    // Headers: Deal, Time, Symbol, Type, Direction, Volume, Price, Commission, Swap, Profit
    if ((hs.includes('deal') && hs.includes('direction') && hs.includes('volume')) ||
        (hs.includes('position') && hs.includes('symbol') && hs.includes('action') &&
         hs.includes('volume') && hs.includes('swap'))) {
      return { name: 'MetaTrader 5', parser: parseMT5 };
    }

    // ── METATRADER 4 STANDARD ────────────────────────────────
    // Headers: Ticket, Open Time, Type, Size/Lots, Item/Symbol, Price, S/L, T/P, Close Time, Price, Comm, Swap, Profit
    if ((hs.includes('ticket') && hs.includes('open time') && hs.includes('type') &&
         (hs.includes('size') || hs.includes('lots')) && hs.includes('swap') && hs.includes('profit')) ||
        fn.includes('mt4') || fn.includes('metatrader')) {
      return { name: 'MetaTrader 4', parser: parseMT4 };
    }

    // ── OANDA ────────────────────────────────────────────────
    if (fn.includes('oanda') ||
        (hs.includes('trade id') && hs.includes('units') && hs.includes('instrument')) ||
        (hs.includes('instrument') && hs.includes('financing') && hs.includes('open ask'))) {
      return { name: 'OANDA', parser: parseOANDA };
    }

    // ── PLUS500 ──────────────────────────────────────────────
    if (fn.includes('plus500') ||
        (hs.includes('action') && hs.includes('instrument') && hs.includes('units') &&
         hs.includes('opening rate') && hs.includes('closing rate'))) {
      return { name: 'Plus500', parser: parsePlus500 };
    }

    // ── ETORO ────────────────────────────────────────────────
    if (fn.includes('etoro') ||
        (hs.includes('position id') && hs.includes('action') && hs.includes('amount') &&
         hs.includes('open rate') && hs.includes('close rate'))) {
      return { name: 'eToro', parser: parseEToro };
    }

    // ── CAPITAL.COM ──────────────────────────────────────────
    if (fn.includes('capital') ||
        (hs.includes('reference') && hs.includes('market') && hs.includes('direction') &&
         hs.includes('size') && hs.includes('open level') && hs.includes('close level'))) {
      return { name: 'Capital.com', parser: parseCapitalCom };
    }

    // ── DERIV / BINARY.COM ───────────────────────────────────
    if (fn.includes('deriv') || fn.includes('binary') ||
        (hs.includes('contract id') && hs.includes('contract type') && hs.includes('buy price'))) {
      return { name: 'Deriv / Binary.com', parser: parseDeriv };
    }

    // ── BINANCE ──────────────────────────────────────────────
    if (fn.includes('binance') ||
        (hs.includes('pair') && hs.includes('side') && hs.includes('executed') && hs.includes('fee')) ||
        (hs.includes('symbol') && hs.includes('side') && hs.includes('realized profit') && hs.includes('fee'))) {
      return { name: 'Binance', parser: parseBinance };
    }

    // ── BYBIT ────────────────────────────────────────────────
    if (fn.includes('bybit') ||
        (hs.includes('symbol') && hs.includes('side') && hs.includes('qty') &&
         hs.includes('order price') && hs.includes('exec fee'))) {
      return { name: 'Bybit', parser: parseBybit };
    }

    // ── INTERACTIVE BROKERS ──────────────────────────────────
    if (fn.includes('ib') || fn.includes('interactive') ||
        hs.includes('comm/fee') || hs.includes('t. price') ||
        hs.includes('realized p/l') ||
        (hs.includes('date/time') && hs.includes('quantity'))) {
      return { name: 'Interactive Brokers', parser: parseIBKR };
    }

    // ── TD AMERITRADE / SCHWAB ───────────────────────────────
    if (fn.includes('tda') || fn.includes('ameritrade') || fn.includes('schwab') ||
        (hs.includes('description') && hs.includes('action') &&
         hs.includes('quantity') && hs.includes('amount'))) {
      return { name: 'TD Ameritrade / Schwab', parser: parseTDA };
    }

    // ── TASTYTRADE ───────────────────────────────────────────
    if (fn.includes('tastytrade') || fn.includes('tasty') ||
        hs.includes('root symbol') || hs.includes('call or put')) {
      return { name: 'Tastytrade', parser: parseTastytrade };
    }

    // ── E*TRADE ──────────────────────────────────────────────
    if (fn.includes('etrade') || fn.includes('e-trade') ||
        (hs.includes('transaction type') && hs.includes('net amount'))) {
      return { name: 'E*TRADE', parser: parseETrade };
    }

    // ── ROBINHOOD ────────────────────────────────────────────
    if (fn.includes('robinhood') ||
        (hs.includes('instrument') && hs.includes('average price') && hs.includes('side')) ||
        (hs.includes('activity date') && hs.includes('process date'))) {
      return { name: 'Robinhood', parser: parseRobinhood };
    }

    // ── WEBULL ───────────────────────────────────────────────
    if (fn.includes('webull') ||
        (hs.includes('filled qty') && hs.includes('avg price'))) {
      return { name: 'Webull', parser: parseWebull };
    }

    // ── FIDELITY ─────────────────────────────────────────────
    if (fn.includes('fidelity') ||
        (hs.includes('run date') && hs.includes('action')) ||
        (hs.includes('settlement date') && hs.includes('security description'))) {
      return { name: 'Fidelity', parser: parseFidelity };
    }

    // ── TRADESTATION ─────────────────────────────────────────
    if (fn.includes('tradestation') ||
        (hs.includes('order exec time') && hs.includes('open/close'))) {
      return { name: 'TradeStation', parser: parseTradeStation };
    }

    // ── FALLBACK: GENERIC CSV ────────────────────────────────
    return { name: 'Generic CSV', parser: parseGeneric };
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 1 — EXNESS MT5
  // Your confirmed real file format.
  // Headers: ticket, opening_time_utc, closing_time_utc, type,
  //          lots, original_position_size, symbol, opening_price,
  //          closing_price, stop_loss, take_profit, commission,
  //          swap, profit, equity, margin_level, close_reason
  // ══════════════════════════════════════════════════════════
  function parseExnessMT5(rows, logMessages) {
    const trades   = [];
    const rawHdrs  = getHeaders(rows);
    const keyMap   = buildKeyMap(rawHdrs);
    const hdr      = makeHdrFinder(keyMap);

    const kType      = hdr('type');
    const kLots      = hdr('lots');
    const kSymbol    = hdr('symbol');
    const kOpen      = hdr('opening_price', 'open_price');
    const kClose     = hdr('closing_price', 'close_price');
    const kProfit    = hdr('profit');
    const kComm      = hdr('commission');
    const kSwap      = hdr('swap');
    const kSL        = hdr('stop_loss', 'stoploss');
    const kTP        = hdr('take_profit', 'takeprofit');
    const kOpenTime  = hdr('opening_time_utc', 'opening_time', 'open_time');
    const kCloseTime = hdr('closing_time_utc', 'closing_time', 'close_time');
    const kTicket    = hdr('ticket', 'order', 'position');
    const kReason    = hdr('close_reason', 'reason');

    log(`📋 Exness MT5 — ${rows.length - 1} rows`, logMessages);

    for (const row of rows.slice(1)) {
      try {
        const typeRaw = gv(row, kType).toLowerCase();
        if (typeRaw !== 'buy' && typeRaw !== 'sell') continue;

        const side    = typeRaw === 'buy' ? 'LONG' : 'SHORT';
        const symbol  = normalizeSymbol(gv(row, kSymbol));
        const lots    = parseNum(gv(row, kLots));
        const entry   = parseNum(gv(row, kOpen));
        const exit    = parseNum(gv(row, kClose));
        const profit  = parseNum(gv(row, kProfit));
        const comm    = parseNum(gv(row, kComm)) || 0;
        const swap    = parseNum(gv(row, kSwap))  || 0;
        const sl      = parseNum(gv(row, kSL))    || undefined;
        const tp      = parseNum(gv(row, kTP))    || undefined;

        if (!symbol || !lots || !entry) continue;

        trades.push(DataStore.enrichTrade({
          symbol, side, qty: lots, entry, exit,
          stop: sl, tp,
          pnl: profit + comm + swap,
          commission: Math.abs(comm),
          entryDate: parseDate(gv(row, kOpenTime)),
          exitDate:  parseDate(gv(row, kCloseTime)),
          notes: `Ticket: ${gv(row, kTicket)}${gv(row, kReason) ? ' | ' + gv(row, kReason).toUpperCase() : ''}`,
          tags: ['exness', 'mt5', gv(row, kReason) || 'closed']
        }));
      } catch (e) {}
    }
    return trades;
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 2 — EXNESS MT4
  // Headers: Ticket, Open Time, Type, Lots, Symbol,
  //          Open Price, S/L, T/P, Close Time, Close Price,
  //          Commission, Taxes, Swap, Profit
  // ══════════════════════════════════════════════════════════
  function parseExnessMT4(rows, logMessages) {
    const trades  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kType      = hdr('type');
    const kLots      = hdr('lots', 'size');
    const kSymbol    = hdr('symbol', 'item');
    const kOpen      = hdr('open price', 'opening price');
    const kClose     = hdr('close price', 'closing price');
    const kProfit    = hdr('profit');
    const kComm      = hdr('commission');
    const kSwap      = hdr('swap');
    const kSL        = hdr('s/l', 'stop loss', 'sl');
    const kTP        = hdr('t/p', 'take profit', 'tp');
    const kOpenTime  = hdr('open time', 'opening time');
    const kCloseTime = hdr('close time', 'closing time');
    const kTicket    = hdr('ticket', 'order');

    log(`📋 Exness MT4 — ${rows.length - 1} rows`, logMessages);

    for (const row of rows.slice(1)) {
      try {
        const typeRaw = gv(row, kType).toLowerCase();
        if (typeRaw !== 'buy' && typeRaw !== 'sell') continue;

        const symbol = normalizeSymbol(gv(row, kSymbol));
        const lots   = parseNum(gv(row, kLots));
        const entry  = parseNum(gv(row, kOpen));
        const exit   = parseNum(gv(row, kClose));
        const profit = parseNum(gv(row, kProfit)) || 0;
        const comm   = parseNum(gv(row, kComm))   || 0;
        const swap   = parseNum(gv(row, kSwap))   || 0;

        if (!symbol || !lots || !entry) continue;

        trades.push(DataStore.enrichTrade({
          symbol, side: typeRaw === 'buy' ? 'LONG' : 'SHORT',
          qty: lots, entry, exit,
          stop: parseNum(gv(row, kSL)) || undefined,
          tp:   parseNum(gv(row, kTP)) || undefined,
          pnl:  profit + comm + swap,
          commission: Math.abs(comm),
          entryDate: parseDate(gv(row, kOpenTime)),
          exitDate:  parseDate(gv(row, kCloseTime)),
          notes: `Ticket: ${gv(row, kTicket)}`,
          tags: ['exness', 'mt4']
        }));
      } catch (e) {}
    }
    return trades;
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 3 — METATRADER 4 STANDARD
  // Used by: XM, IC Markets, FxPro, AvaTrade, HotForex,
  //          Pepperstone MT4, and most MT4 brokers
  // Headers: Ticket, Open Time, Type, Size, Item,
  //          Price, S/L, T/P, Close Time, Price,
  //          Commission, Taxes, Swap, Profit
  // ══════════════════════════════════════════════════════════
  function parseMT4(rows, logMessages) {
    const trades  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    // MT4 has two "Price" columns — first is open, second is close
    // We handle this by position when needed
    const allKeys = Object.keys(keyMap);
    const priceKeys = allKeys.filter(k => k.includes('price'));

    const kType      = hdr('type');
    const kSize      = hdr('size', 'lots', 'volume');
    const kSymbol    = hdr('item', 'symbol', 'pair');
    const kOpenPrice = hdr('open price', 'opening price') || priceKeys[0];
    const kClosePrice= hdr('close price', 'closing price') || priceKeys[1];
    const kSL        = hdr('s/l', 'stop loss');
    const kTP        = hdr('t/p', 'take profit');
    const kComm      = hdr('commission');
    const kSwap      = hdr('swap');
    const kProfit    = hdr('profit');
    const kOpenTime  = hdr('open time');
    const kCloseTime = hdr('close time');
    const kTicket    = hdr('ticket', 'order');

    log(`📋 MetaTrader 4 — ${rows.length - 1} rows`, logMessages);

    for (const row of rows.slice(1)) {
      try {
        const typeRaw = gv(row, kType).toLowerCase().trim();
        if (typeRaw !== 'buy' && typeRaw !== 'sell') continue;

        const symbol  = normalizeSymbol(gv(row, kSymbol));
        const size    = parseNum(gv(row, kSize));
        const entry   = parseNum(gv(row, kOpenPrice));
        const exit    = parseNum(gv(row, kClosePrice));
        const profit  = parseNum(gv(row, kProfit)) || 0;
        const comm    = parseNum(gv(row, kComm))   || 0;
        const swap    = parseNum(gv(row, kSwap))   || 0;

        if (!symbol || !size || !entry) continue;

        trades.push(DataStore.enrichTrade({
          symbol, side: typeRaw === 'buy' ? 'LONG' : 'SHORT',
          qty: size, entry, exit,
          stop: parseNum(gv(row, kSL)) || undefined,
          tp:   parseNum(gv(row, kTP)) || undefined,
          pnl:  profit + comm + swap,
          commission: Math.abs(comm),
          entryDate: parseDate(gv(row, kOpenTime)),
          exitDate:  parseDate(gv(row, kCloseTime)),
          notes: `Ticket: ${gv(row, kTicket)}`,
          tags: ['mt4']
        }));
      } catch (e) {}
    }
    return trades;
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 4 — METATRADER 5 STANDARD
  // Used by: Pepperstone MT5, FTMO, My Forex Funds,
  //          IC Markets MT5, and most MT5 brokers
  // Headers: Deal, Time, Symbol, Type, Direction,
  //          Volume, Price, Order, Commission, Swap,
  //          Profit, Balance, Comment
  // ══════════════════════════════════════════════════════════
  function parseMT5(rows, logMessages) {
    const trades  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kType      = hdr('type');
    const kDirection = hdr('direction', 'action');
    const kVolume    = hdr('volume', 'size', 'lots');
    const kSymbol    = hdr('symbol');
    const kPrice     = hdr('price');
    const kComm      = hdr('commission');
    const kSwap      = hdr('swap');
    const kProfit    = hdr('profit');
    const kTime      = hdr('time', 'date');
    const kDeal      = hdr('deal', 'position', 'ticket');
    const kComment   = hdr('comment');

    log(`📋 MetaTrader 5 — ${rows.length - 1} rows`, logMessages);

    // MT5 exports individual deal rows (entries + exits separately)
    // Group by position/deal ID and pair them up
    const deals = [];
    for (const row of rows.slice(1)) {
      try {
        const typeRaw = gv(row, kType).toLowerCase();
        const dir     = gv(row, kDirection).toLowerCase();
        if (typeRaw !== 'buy' && typeRaw !== 'sell' &&
            dir !== 'in' && dir !== 'out' &&
            !typeRaw.includes('buy') && !typeRaw.includes('sell')) continue;

        deals.push({
          deal:      gv(row, kDeal),
          type:      typeRaw,
          direction: dir,
          symbol:    normalizeSymbol(gv(row, kSymbol)),
          volume:    parseNum(gv(row, kVolume)),
          price:     parseNum(gv(row, kPrice)),
          commission:parseNum(gv(row, kComm))   || 0,
          swap:      parseNum(gv(row, kSwap))   || 0,
          profit:    parseNum(gv(row, kProfit)) || 0,
          time:      parseDate(gv(row, kTime)),
          comment:   gv(row, kComment)
        });
      } catch (e) {}
    }

    // Match IN deals with OUT deals by symbol+volume (FIFO)
    const entries = deals.filter(d => d.direction === 'in'  || d.type.includes('buy')  || d.type === 'buy');
    const exits   = deals.filter(d => d.direction === 'out' || d.type.includes('sell') || d.type === 'sell');

    // If all deals have profit field, they may already be complete trades
    const hasProfit = deals.some(d => !isNaN(d.profit) && d.profit !== 0);
    if (hasProfit && entries.length === 0) {
      // Each row is already a complete trade
      for (const d of deals) {
        if (!d.symbol || !d.volume || !d.price) continue;
        trades.push(DataStore.enrichTrade({
          symbol: d.symbol,
          side:   d.type.includes('sell') ? 'SHORT' : 'LONG',
          qty: d.volume, entry: d.price, exit: d.price,
          pnl: d.profit + d.commission + d.swap,
          commission: Math.abs(d.commission),
          entryDate: d.time, exitDate: d.time,
          notes: d.comment || 'MT5', tags: ['mt5']
        }));
      }
      return trades;
    }

    // Pair entries with exits
    const usedExits = new Set();
    for (const en of entries) {
      const match = exits.find((ex, i) =>
        !usedExits.has(i) && ex.symbol === en.symbol
      );
      if (!match) continue;
      usedExits.add(exits.indexOf(match));

      const totalPnl = en.profit + match.profit + en.commission + match.commission + en.swap + match.swap;
      trades.push(DataStore.enrichTrade({
        symbol: en.symbol,
        side:   en.type.includes('buy') || en.direction === 'in' ? 'LONG' : 'SHORT',
        qty: en.volume, entry: en.price, exit: match.price,
        pnl: totalPnl,
        commission: Math.abs(en.commission) + Math.abs(match.commission),
        entryDate: en.time, exitDate: match.time,
        notes: en.comment || match.comment || 'MT5',
        tags: ['mt5']
      }));
    }

    return trades;
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 5 — OANDA
  // Headers: Trade ID, Units, Instrument, Open time,
  //          Open ask, Open bid, Close time, Close rate,
  //          P&L, Financing, Balance
  // ══════════════════════════════════════════════════════════
  function parseOANDA(rows, logMessages) {
    const trades  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kUnits     = hdr('units');
    const kSymbol    = hdr('instrument', 'symbol', 'pair');
    const kOpenTime  = hdr('open time', 'opentime', 'opened');
    const kCloseTime = hdr('close time', 'closetime', 'closed');
    const kOpenRate  = hdr('open ask', 'open bid', 'open rate', 'open price');
    const kCloseRate = hdr('close rate', 'close price');
    const kPnl       = hdr('p&l', 'pnl', 'profit/loss', 'gain/loss');
    const kFinancing = hdr('financing', 'swap');
    const kId        = hdr('trade id', 'id');

    log(`📋 OANDA — ${rows.length - 1} rows`, logMessages);

    for (const row of rows.slice(1)) {
      try {
        const units  = parseNum(gv(row, kUnits));
        const symbol = normalizeSymbol(gv(row, kSymbol).replace('_', '/'));
        const entry  = parseNum(gv(row, kOpenRate));
        const exit   = parseNum(gv(row, kCloseRate));
        const pnl    = parseNum(gv(row, kPnl))       || 0;
        const fin    = parseNum(gv(row, kFinancing))  || 0;

        if (!symbol || !units || !entry) continue;

        // OANDA: positive units = LONG, negative = SHORT
        const side = units >= 0 ? 'LONG' : 'SHORT';

        trades.push(DataStore.enrichTrade({
          symbol, side, qty: Math.abs(units), entry, exit,
          pnl: pnl + fin,
          commission: 0,
          entryDate: parseDate(gv(row, kOpenTime)),
          exitDate:  parseDate(gv(row, kCloseTime)),
          notes: `OANDA Trade ID: ${gv(row, kId)}`,
          tags: ['oanda']
        }));
      } catch (e) {}
    }
    return trades;
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 6 — PLUS500
  // Headers: Action, Instrument, Description, Status,
  //          Units, Opening Rate, Closing Rate,
  //          Opening Date, Closing Date, P&L
  // ══════════════════════════════════════════════════════════
  function parsePlus500(rows, logMessages) {
    const trades  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kAction    = hdr('action');
    const kSymbol    = hdr('instrument', 'symbol', 'name');
    const kUnits     = hdr('units', 'qty', 'quantity');
    const kOpenRate  = hdr('opening rate', 'open rate', 'open price');
    const kCloseRate = hdr('closing rate', 'close rate', 'close price');
    const kPnl       = hdr('profit', 'p&l', 'net profit');
    const kOpenTime  = hdr('opening date', 'open date', 'open time');
    const kCloseTime = hdr('closing date', 'close date', 'close time');

    log(`📋 Plus500 — ${rows.length - 1} rows`, logMessages);

    for (const row of rows.slice(1)) {
      try {
        const action = gv(row, kAction).toLowerCase();
        if (!action.includes('buy') && !action.includes('sell')) continue;

        const symbol = normalizeSymbol(gv(row, kSymbol));
        const units  = parseNum(gv(row, kUnits));
        const entry  = parseNum(gv(row, kOpenRate));
        const exit   = parseNum(gv(row, kCloseRate));
        const pnl    = parseNum(gv(row, kPnl)) || 0;

        if (!symbol || !units || !entry) continue;

        trades.push(DataStore.enrichTrade({
          symbol, side: action.includes('buy') ? 'LONG' : 'SHORT',
          qty: units, entry, exit, pnl, commission: 0,
          entryDate: parseDate(gv(row, kOpenTime)),
          exitDate:  parseDate(gv(row, kCloseTime)),
          notes: 'Plus500', tags: ['plus500']
        }));
      } catch (e) {}
    }
    return trades;
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 7 — ETORO
  // Headers: Position ID, Action, Amount, Units,
  //          Open Rate, Open Date, Leverage,
  //          Close Rate, Close Date, Profit, Notes
  // ══════════════════════════════════════════════════════════
  function parseEToro(rows, logMessages) {
    const trades  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kAction    = hdr('action', 'type', 'direction');
    const kSymbol    = hdr('instrument', 'symbol', 'pair', 'asset');
    const kUnits     = hdr('units', 'amount', 'qty');
    const kOpenRate  = hdr('open rate', 'open price');
    const kCloseRate = hdr('close rate', 'close price');
    const kProfit    = hdr('profit', 'net profit', 'p&l');
    const kOpenTime  = hdr('open date', 'open time', 'date');
    const kCloseTime = hdr('close date', 'close time');
    const kId        = hdr('position id', 'trade id', 'id');

    log(`📋 eToro — ${rows.length - 1} rows`, logMessages);

    for (const row of rows.slice(1)) {
      try {
        const action = gv(row, kAction).toLowerCase();
        if (!action.includes('buy') && !action.includes('sell') &&
            !action.includes('long') && !action.includes('short')) continue;

        const symbol = normalizeSymbol(gv(row, kSymbol));
        const units  = parseNum(gv(row, kUnits));
        const entry  = parseNum(gv(row, kOpenRate));
        const exit   = parseNum(gv(row, kCloseRate));
        const profit = parseNum(gv(row, kProfit)) || 0;

        if (!symbol || !units || !entry) continue;

        const side = (action.includes('buy') || action.includes('long')) ? 'LONG' : 'SHORT';

        trades.push(DataStore.enrichTrade({
          symbol, side, qty: units, entry, exit, pnl: profit,
          commission: 0,
          entryDate: parseDate(gv(row, kOpenTime)),
          exitDate:  parseDate(gv(row, kCloseTime)),
          notes: `eToro Position: ${gv(row, kId)}`,
          tags: ['etoro']
        }));
      } catch (e) {}
    }
    return trades;
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 8 — CAPITAL.COM
  // Headers: Reference, Market, Category, Direction,
  //          Size, Open Level, Close Level,
  //          Opening Date, Closing Date, Profit/Loss,
  //          Currency, Overnight Funding
  // ══════════════════════════════════════════════════════════
  function parseCapitalCom(rows, logMessages) {
    const trades  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kDir       = hdr('direction', 'side', 'action');
    const kSymbol    = hdr('market', 'instrument', 'symbol');
    const kSize      = hdr('size', 'qty', 'units');
    const kOpenLevel = hdr('open level', 'open price', 'opening level');
    const kCloseLevel= hdr('close level', 'close price', 'closing level');
    const kProfit    = hdr('profit/loss', 'profit', 'p&l', 'net profit');
    const kOpenTime  = hdr('opening date', 'open date', 'opened');
    const kCloseTime = hdr('closing date', 'close date', 'closed');
    const kRef       = hdr('reference', 'id', 'trade id');

    log(`📋 Capital.com — ${rows.length - 1} rows`, logMessages);

    for (const row of rows.slice(1)) {
      try {
        const dir    = gv(row, kDir).toLowerCase();
        const symbol = normalizeSymbol(gv(row, kSymbol));
        const size   = parseNum(gv(row, kSize));
        const entry  = parseNum(gv(row, kOpenLevel));
        const exit   = parseNum(gv(row, kCloseLevel));
        const profit = parseNum(gv(row, kProfit)) || 0;

        if (!symbol || !size || !entry) continue;

        const side = (dir.includes('buy') || dir.includes('long')) ? 'LONG' : 'SHORT';

        trades.push(DataStore.enrichTrade({
          symbol, side, qty: size, entry, exit, pnl: profit,
          commission: 0,
          entryDate: parseDate(gv(row, kOpenTime)),
          exitDate:  parseDate(gv(row, kCloseTime)),
          notes: `Capital.com Ref: ${gv(row, kRef)}`,
          tags: ['capital.com']
        }));
      } catch (e) {}
    }
    return trades;
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 9 — DERIV / BINARY.COM
  // Headers: Contract ID, Reference ID, Buy time,
  //          Buy price, Sell time, Sell price,
  //          Contract type, Symbol, Duration, P&L
  // ══════════════════════════════════════════════════════════
  function parseDeriv(rows, logMessages) {
    const trades  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kType      = hdr('contract type', 'type');
    const kSymbol    = hdr('symbol', 'market', 'underlying');
    const kBuyPrice  = hdr('buy price', 'purchase price', 'stake');
    const kSellPrice = hdr('sell price', 'payout');
    const kPnl       = hdr('profit/loss', 'profit', 'p&l', 'pnl');
    const kBuyTime   = hdr('buy time', 'start time', 'date purchased');
    const kSellTime  = hdr('sell time', 'end time', 'date sold');
    const kId        = hdr('contract id', 'id', 'reference');

    log(`📋 Deriv/Binary.com — ${rows.length - 1} rows`, logMessages);

    for (const row of rows.slice(1)) {
      try {
        const typeRaw = gv(row, kType).toLowerCase();
        const symbol  = normalizeSymbol(gv(row, kSymbol));
        const buy     = parseNum(gv(row, kBuyPrice));
        const sell    = parseNum(gv(row, kSellPrice));
        const profit  = parseNum(gv(row, kPnl)) || (sell - buy);

        if (!symbol || !buy) continue;

        // CALL/RISE = LONG, PUT/FALL = SHORT
        const side = (typeRaw.includes('call') || typeRaw.includes('rise') ||
                      typeRaw.includes('higher') || typeRaw.includes('up'))
                   ? 'LONG' : 'SHORT';

        trades.push(DataStore.enrichTrade({
          symbol, side, qty: 1, entry: buy, exit: sell, pnl: profit,
          commission: 0,
          entryDate: parseDate(gv(row, kBuyTime)),
          exitDate:  parseDate(gv(row, kSellTime)),
          notes: `Deriv Contract: ${gv(row, kId)} | ${gv(row, kType)}`,
          tags: ['deriv']
        }));
      } catch (e) {}
    }
    return trades;
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 10 — BINANCE
  // Spot: Date, Pair, Side, Price, Executed, Amount, Fee
  // Futures: Symbol, Side, Realized Profit, Fee, Time
  // ══════════════════════════════════════════════════════════
  function parseBinance(rows, logMessages) {
    const trades  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kSymbol  = hdr('pair', 'symbol');
    const kSide    = hdr('side');
    const kPrice   = hdr('price', 'avg price', 'average price');
    const kQty     = hdr('executed', 'qty', 'quantity', 'amount', 'size');
    const kFee     = hdr('fee', 'commission');
    const kProfit  = hdr('realized profit', 'pnl', 'profit');
    const kDate    = hdr('date', 'time', 'created time');

    log(`📋 Binance — ${rows.length - 1} rows`, logMessages);

    const orders = [];
    for (const row of rows.slice(1)) {
      try {
        const sideRaw = gv(row, kSide).toLowerCase();
        if (sideRaw !== 'buy' && sideRaw !== 'sell') continue;

        const symbol = normalizeSymbol(gv(row, kSymbol).replace(/USDT?$/, '/USDT'));
        const price  = parseNum(gv(row, kPrice));
        const qty    = parseNum(gv(row, kQty));
        const fee    = parseNum(gv(row, kFee)) || 0;
        const profit = parseNum(gv(row, kProfit));

        if (!symbol || !price || !qty) continue;

        // If futures with profit — it's already a complete trade
        if (!isNaN(profit)) {
          trades.push(DataStore.enrichTrade({
            symbol, side: sideRaw === 'buy' ? 'LONG' : 'SHORT',
            qty, entry: price, exit: price,
            pnl: profit - Math.abs(fee),
            commission: Math.abs(fee),
            entryDate: parseDate(gv(row, kDate)),
            exitDate:  parseDate(gv(row, kDate)),
            notes: 'Binance Futures', tags: ['binance', 'futures']
          }));
        } else {
          // Spot — pair orders
          orders.push({
            symbol, side: sideRaw === 'buy' ? 'LONG' : 'SHORT',
            qty, entry: price, exit: null,
            commission: Math.abs(fee),
            entryDate: parseDate(gv(row, kDate)),
            notes: 'Binance Spot', tags: ['binance', 'spot']
          });
        }
      } catch (e) {}
    }

    return trades.length > 0 ? trades : pairOrdersToTrades(orders);
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 11 — BYBIT
  // Headers: Symbol, Side, Qty, Order Price, Order Type,
  //          Exec Fee, Exec Time, Exec Price
  // ══════════════════════════════════════════════════════════
  function parseBybit(rows, logMessages) {
    const trades  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kSymbol  = hdr('symbol');
    const kSide    = hdr('side');
    const kQty     = hdr('qty', 'quantity', 'size');
    const kPrice   = hdr('exec price', 'order price', 'avg price', 'price');
    const kFee     = hdr('exec fee', 'fee', 'commission');
    const kProfit  = hdr('closed pnl', 'realized pnl', 'profit');
    const kTime    = hdr('exec time', 'time', 'date');

    log(`📋 Bybit — ${rows.length - 1} rows`, logMessages);

    const orders = [];
    for (const row of rows.slice(1)) {
      try {
        const sideRaw = gv(row, kSide).toLowerCase();
        if (sideRaw !== 'buy' && sideRaw !== 'sell') continue;

        const symbol = normalizeSymbol(gv(row, kSymbol).replace(/USDT?$/, '/USDT'));
        const qty    = parseNum(gv(row, kQty));
        const price  = parseNum(gv(row, kPrice));
        const fee    = parseNum(gv(row, kFee)) || 0;
        const profit = parseNum(gv(row, kProfit));

        if (!symbol || !qty || !price) continue;

        if (!isNaN(profit)) {
          trades.push(DataStore.enrichTrade({
            symbol, side: sideRaw === 'buy' ? 'LONG' : 'SHORT',
            qty, entry: price, exit: price,
            pnl: profit - Math.abs(fee),
            commission: Math.abs(fee),
            entryDate: parseDate(gv(row, kTime)),
            exitDate:  parseDate(gv(row, kTime)),
            notes: 'Bybit', tags: ['bybit']
          }));
        } else {
          orders.push({
            symbol, side: sideRaw === 'buy' ? 'LONG' : 'SHORT',
            qty, entry: price, exit: null,
            commission: Math.abs(fee),
            entryDate: parseDate(gv(row, kTime)),
            notes: 'Bybit', tags: ['bybit']
          });
        }
      } catch (e) {}
    }
    return trades.length > 0 ? trades : pairOrdersToTrades(orders);
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 12 — INTERACTIVE BROKERS
  // Supports both the multi-section format (with Trades/header rows)
  // and direct CSV export
  // ══════════════════════════════════════════════════════════
  function parseIBKR(rows, logMessages) {
    const trades = [];
    let tradeRows = [], inTrades = false, headers = null;

    // Try multi-section format first
    for (const row of rows) {
      const vals  = Object.values(row);
      const first = (vals[0] || '').toString().trim();
      const second= (vals[1] || '').toString().trim().toLowerCase();
      if (first === 'Trades' && second === 'header') { headers = Object.values(row); inTrades = true; continue; }
      if (inTrades && first === 'Trades' && second === 'data') {
        const obj = {}; headers.forEach((h, i) => { obj[h] = vals[i]; }); tradeRows.push(obj);
      }
      if (inTrades && first !== 'Trades') inTrades = false;
    }

    // Fallback: direct CSV
    if (!tradeRows.length) {
      const h = getHeaders(rows);
      tradeRows = rows.slice(1).map(row => {
        const obj = {}; h.forEach((k, i) => { obj[k] = Object.values(row)[i]; }); return obj;
      });
    }

    log(`📋 Interactive Brokers — ${tradeRows.length} rows`, logMessages);

    for (const r of tradeRows) {
      try {
        const symbol = clean(r['Symbol'] || '');
        if (!symbol || symbol === 'Symbol') continue;
        const qty    = parseFloat(clean(r['Quantity'] || '0'));
        const entry  = parseFloat(clean(r['T. Price'] || r['Price'] || '0'));
        const pnl    = parseFloat(clean(r['Realized P/L'] || r['Realized P&L'] || '0'));
        const comm   = Math.abs(parseFloat(clean(r['Comm/Fee'] || r['Commission'] || '0')));
        const date   = clean(r['Date/Time'] || r['Date'] || '');
        if (!entry || !date) continue;

        trades.push(DataStore.enrichTrade({
          symbol: normalizeSymbol(symbol),
          side: qty < 0 ? 'SHORT' : 'LONG',
          qty: Math.abs(qty), entry,
          exit: entry + (qty !== 0 ? pnl / Math.abs(qty) : 0),
          pnl, commission: comm,
          entryDate: parseDate(date), exitDate: parseDate(date),
          notes: 'Interactive Brokers', tags: ['ibkr']
        }));
      } catch (e) {}
    }
    return trades;
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 13 — TD AMERITRADE / SCHWAB
  // ══════════════════════════════════════════════════════════
  function parseTDA(rows, logMessages) {
    const trades  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kAction = hdr('action', 'transaction type');
    const kSymbol = hdr('symbol', 'instrument');
    const kQty    = hdr('quantity', 'qty');
    const kPrice  = hdr('price', 'avg price');
    const kComm   = hdr('fees & comm', 'commission', 'commissions');
    const kDate   = hdr('date', 'trade date');

    log(`📋 TD Ameritrade/Schwab — ${rows.length - 1} rows`, logMessages);

    const orders = [];
    for (const row of rows.slice(1)) {
      try {
        const action = gv(row, kAction);
        const isBuy  = /buy|bought/i.test(action);
        const isSell = /sell|sold/i.test(action);
        if (!isBuy && !isSell) continue;
        const symbol = normalizeSymbol(gv(row, kSymbol).toUpperCase());
        const qty    = Math.abs(parseNum(gv(row, kQty)));
        const price  = parseNum(gv(row, kPrice));
        const comm   = Math.abs(parseNum(gv(row, kComm)) || 0);
        const date   = gv(row, kDate);
        if (!symbol || !qty || !price || !date) continue;
        orders.push({ symbol, side: isBuy ? 'LONG' : 'SHORT', qty, entry: price, exit: null, commission: comm, entryDate: parseDate(date), notes: action, tags: ['tda'] });
      } catch (e) {}
    }
    return pairOrdersToTrades(orders);
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 14 — TASTYTRADE
  // ══════════════════════════════════════════════════════════
  function parseTastytrade(rows, logMessages) {
    const trades  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kType   = hdr('type');
    const kAction = hdr('action');
    const kSymbol = hdr('symbol', 'root symbol', 'underlying symbol');
    const kQty    = hdr('quantity');
    const kPrice  = hdr('average price', 'value');
    const kComm   = hdr('commissions', 'commission');
    const kFees   = hdr('fees');
    const kDate   = hdr('date', 'executed at');

    log(`📋 Tastytrade — ${rows.length - 1} rows`, logMessages);

    const orders = [];
    for (const row of rows.slice(1)) {
      try {
        if (!/trade/i.test(gv(row, kType))) continue;
        const action = gv(row, kAction).toLowerCase();
        const isBuy  = action.includes('buy');
        const symbol = normalizeSymbol(gv(row, kSymbol).toUpperCase());
        const qty    = Math.abs(parseNum(gv(row, kQty)));
        const price  = parseNum(gv(row, kPrice));
        const comm   = (Math.abs(parseNum(gv(row, kComm)) || 0)) + (Math.abs(parseNum(gv(row, kFees)) || 0));
        const date   = gv(row, kDate);
        if (!symbol || !qty || !date) continue;
        orders.push({ symbol, side: isBuy ? 'LONG' : 'SHORT', qty, entry: price, exit: null, commission: comm, entryDate: parseDate(date), notes: `Tastytrade: ${action}`, tags: ['tastytrade'] });
      } catch (e) {}
    }
    return pairOrdersToTrades(orders);
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 15 — E*TRADE
  // ══════════════════════════════════════════════════════════
  function parseETrade(rows, logMessages) {
    const orders  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kType   = hdr('transaction type', 'action');
    const kSymbol = hdr('symbol');
    const kQty    = hdr('quantity', 'shares/quantity');
    const kPrice  = hdr('price', 'price/share');
    const kComm   = hdr('commission', 'commission/fee');
    const kDate   = hdr('transaction date', 'date');

    log(`📋 E*TRADE — ${rows.length - 1} rows`, logMessages);

    for (const row of rows.slice(1)) {
      try {
        const type   = gv(row, kType);
        const isBuy  = /bought|buy/i.test(type);
        const isSell = /sold|sell/i.test(type);
        if (!isBuy && !isSell) continue;
        const symbol = normalizeSymbol(gv(row, kSymbol).toUpperCase());
        const qty    = Math.abs(parseNum(gv(row, kQty)));
        const price  = parseNum(gv(row, kPrice));
        const comm   = Math.abs(parseNum(gv(row, kComm)) || 0);
        const date   = gv(row, kDate);
        if (!symbol || !qty || !price || !date) continue;
        orders.push({ symbol, side: isBuy ? 'LONG' : 'SHORT', qty, entry: price, exit: null, commission: comm, entryDate: parseDate(date), notes: `E*TRADE: ${type}`, tags: ['etrade'] });
      } catch (e) {}
    }
    return pairOrdersToTrades(orders);
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 16 — ROBINHOOD
  // ══════════════════════════════════════════════════════════
  function parseRobinhood(rows, logMessages) {
    const orders  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kSide   = hdr('side', 'trans code');
    const kSymbol = hdr('instrument', 'symbol');
    const kQty    = hdr('quantity', 'shares');
    const kPrice  = hdr('average price', 'price');
    const kDate   = hdr('date', 'activity date', 'order placed at');

    log(`📋 Robinhood — ${rows.length - 1} rows`, logMessages);

    for (const row of rows.slice(1)) {
      try {
        const side   = gv(row, kSide).toLowerCase();
        const isBuy  = /buy|b$/i.test(side);
        const isSell = /sell|s$/i.test(side);
        if (!isBuy && !isSell) continue;
        const symbol = normalizeSymbol(gv(row, kSymbol).toUpperCase());
        const qty    = Math.abs(parseNum(gv(row, kQty)));
        const price  = parseNum(gv(row, kPrice));
        const date   = gv(row, kDate);
        if (!symbol || !qty || !price || !date) continue;
        orders.push({ symbol, side: isBuy ? 'LONG' : 'SHORT', qty, entry: price, exit: null, commission: 0, entryDate: parseDate(date), notes: 'Robinhood', tags: ['robinhood'] });
      } catch (e) {}
    }
    return pairOrdersToTrades(orders);
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 17 — WEBULL
  // ══════════════════════════════════════════════════════════
  function parseWebull(rows, logMessages) {
    const orders  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kSide   = hdr('side', 'action');
    const kSymbol = hdr('symbol', 'ticker');
    const kQty    = hdr('filled qty', 'quantity');
    const kPrice  = hdr('avg price', 'average price', 'price');
    const kComm   = hdr('commission', 'fees');
    const kDate   = hdr('filled time', 'date', 'time');

    log(`📋 Webull — ${rows.length - 1} rows`, logMessages);

    for (const row of rows.slice(1)) {
      try {
        const side   = gv(row, kSide).toLowerCase();
        const isBuy  = /buy/i.test(side);
        const isSell = /sell/i.test(side);
        if (!isBuy && !isSell) continue;
        const symbol = normalizeSymbol(gv(row, kSymbol).toUpperCase());
        const qty    = Math.abs(parseNum(gv(row, kQty)));
        const price  = parseNum(gv(row, kPrice));
        const comm   = Math.abs(parseNum(gv(row, kComm)) || 0);
        const date   = gv(row, kDate);
        if (!symbol || !qty || !price || !date) continue;
        orders.push({ symbol, side: isBuy ? 'LONG' : 'SHORT', qty, entry: price, exit: null, commission: comm, entryDate: parseDate(date), notes: 'Webull', tags: ['webull'] });
      } catch (e) {}
    }
    return pairOrdersToTrades(orders);
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 18 — FIDELITY
  // ══════════════════════════════════════════════════════════
  function parseFidelity(rows, logMessages) {
    const orders  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kAction = hdr('action', 'transaction type');
    const kSymbol = hdr('symbol', 'security');
    const kQty    = hdr('quantity', 'shares');
    const kPrice  = hdr('price');
    const kComm   = hdr('commission', 'fees');
    const kDate   = hdr('run date', 'trade date', 'settlement date');

    log(`📋 Fidelity — ${rows.length - 1} rows`, logMessages);

    for (const row of rows.slice(1)) {
      try {
        const action = gv(row, kAction);
        const isBuy  = /bought|buy/i.test(action);
        const isSell = /sold|sell/i.test(action);
        if (!isBuy && !isSell) continue;
        const symbol = normalizeSymbol(gv(row, kSymbol).toUpperCase());
        const qty    = Math.abs(parseNum(gv(row, kQty)));
        const price  = parseNum(gv(row, kPrice));
        const comm   = Math.abs(parseNum(gv(row, kComm)) || 0);
        const date   = gv(row, kDate);
        if (!symbol || !qty || !price || !date) continue;
        orders.push({ symbol, side: isBuy ? 'LONG' : 'SHORT', qty, entry: price, exit: null, commission: comm, entryDate: parseDate(date), notes: `Fidelity: ${action}`, tags: ['fidelity'] });
      } catch (e) {}
    }
    return pairOrdersToTrades(orders);
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 19 — TRADESTATION
  // ══════════════════════════════════════════════════════════
  function parseTradeStation(rows, logMessages) {
    const orders  = [];
    const rawHdrs = getHeaders(rows);
    const keyMap  = buildKeyMap(rawHdrs);
    const hdr     = makeHdrFinder(keyMap);

    const kAction = hdr('buy/sell', 'side', 'action');
    const kSymbol = hdr('symbol');
    const kQty    = hdr('qty', 'quantity');
    const kPrice  = hdr('exec price', 'price');
    const kComm   = hdr('commission');
    const kDate   = hdr('order exec time', 'date', 'time');

    log(`📋 TradeStation — ${rows.length - 1} rows`, logMessages);

    for (const row of rows.slice(1)) {
      try {
        const action = gv(row, kAction);
        const isBuy  = /buy/i.test(action);
        const isSell = /sell/i.test(action);
        if (!isBuy && !isSell) continue;
        const symbol = normalizeSymbol(gv(row, kSymbol).toUpperCase());
        const qty    = Math.abs(parseNum(gv(row, kQty)));
        const price  = parseNum(gv(row, kPrice));
        const comm   = Math.abs(parseNum(gv(row, kComm)) || 0);
        const date   = gv(row, kDate);
        if (!symbol || !qty || !price || !date) continue;
        orders.push({ symbol, side: isBuy ? 'LONG' : 'SHORT', qty, entry: price, exit: null, commission: comm, entryDate: parseDate(date), notes: 'TradeStation', tags: ['tradestation'] });
      } catch (e) {}
    }
    return pairOrdersToTrades(orders);
  }

  // ══════════════════════════════════════════════════════════
  // PARSER 20 — GENERIC CSV (FALLBACK)
  // Auto-detects columns by matching common header names.
  // Works for any CSV that has recognizable column names.
  // ══════════════════════════════════════════════════════════
  function parseGeneric(rows, logMessages) {
    const trades  = [];
    const headers = getHeaders(rows).map(h => h.toLowerCase().trim());
    const find    = (...candidates) => {
      for (const c of candidates) {
        const idx = headers.findIndex(h => h.includes(c.toLowerCase()));
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const cols = {
      symbol:  find('symbol','ticker','instrument','stock','asset','pair','market'),
      side:    find('side','action','type','direction','buy/sell'),
      qty:     find('qty','quantity','shares','size','lots','volume','units'),
      entry:   find('entry','buy price','open price','opening_price','avg','price','open'),
      exit:    find('exit','sell price','close price','closing_price','exit price','close'),
      pnl:     find('pnl','p&l','profit','gain','net','realized'),
      comm:    find('commission','comm','fee','fees'),
      date:    find('opening_time','open_time','date','time','datetime','trade date','entry date'),
      exitdate:find('closing_time','close_time','exit date','close date','exit time'),
      stop:    find('stop_loss','stop','sl','s/l'),
      notes:   find('note','comment','remark','desc','close_reason'),
      tags:    find('tag','label','category'),
    };

    const g = (row, col) => { if (col === -1) return ''; const vals = Object.values(row); return clean(vals[col] || ''); };

    log(`📋 Generic CSV — auto-detecting columns from ${headers.length} headers`, logMessages);

    for (const row of rows.slice(1)) {
      try {
        const symbol = normalizeSymbol(g(row, cols.symbol).toUpperCase());
        if (!symbol || symbol === 'SYMBOL') continue;
        const rawSide = g(row, cols.side).toLowerCase();
        const side    = /sell|short/.test(rawSide) ? 'SHORT' : 'LONG';
        const qty     = Math.abs(parseNum(g(row, cols.qty)) || 0);
        const entry   = parseNum(g(row, cols.entry)) || 0;
        const exit    = parseNum(g(row, cols.exit))  || 0;
        const pnl     = parseNum(g(row, cols.pnl));
        const comm    = Math.abs(parseNum(g(row, cols.comm)) || 0);
        const date    = g(row, cols.date);
        const exitDt  = g(row, cols.exitdate);
        if (!symbol || !date) continue;

        trades.push(DataStore.enrichTrade({
          symbol, side, qty, entry, exit: exit || entry,
          stop: parseNum(g(row, cols.stop)) || undefined,
          pnl:  !isNaN(pnl) ? pnl : undefined,
          commission: comm,
          entryDate: parseDate(date),
          exitDate:  exitDt ? parseDate(exitDt) : parseDate(date),
          notes: g(row, cols.notes),
          tags:  g(row, cols.tags) ? g(row, cols.tags).split(/[,;]/).map(t => t.trim()) : ['imported']
        }));
      } catch (e) {}
    }
    return trades;
  }

  // ══════════════════════════════════════════════════════════
  // EXNESS BLOCK FORMAT (multi-line text)
  // Detects and parses the non-CSV Exness text format where
  // symbol and side are on separate lines above the data row.
  // ══════════════════════════════════════════════════════════
  function tryParseExnessBlock(text, logMessages) {
    const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
    const symbolLineRe = /^([A-Z]{2,6}[\/\-]?[A-Z]{0,6}(?:m)?)\s*$/i;
    const sideLineRe   = /^(buy|sell)\s*$/i;
    const dateTokenRe  = /\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2}:\d{2}/i;

    const lines = text.split('\n').map(l => l.trimEnd());
    const hasSymbolLine = lines.some(l => symbolLineRe.test(l.trim()));
    const hasSideLine   = lines.some(l => sideLineRe.test(l.trim()));
    const hasDateLine   = lines.some(l => dateTokenRe.test(l));
    if (!hasSymbolLine || !hasSideLine || !hasDateLine) return null;

    log(`🔍 Detected Exness block text format`, logMessages, 'success');
    const trades = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();
      const symMatch = line.match(symbolLineRe);
      if (!symMatch) { i++; continue; }
      const symbol = normalizeSymbol(symMatch[1].toUpperCase());

      let sideStr = null, sideIdx = -1;
      for (let j = i+1; j < Math.min(i+4, lines.length); j++) {
        if (sideLineRe.test(lines[j].trim())) { sideStr = lines[j].trim().toLowerCase(); sideIdx = j; break; }
      }
      if (!sideStr) { i++; continue; }

      let dataLine = null, dataIdx = -1;
      for (let j = sideIdx+1; j < Math.min(sideIdx+4, lines.length); j++) {
        const c = lines[j].trim();
        if (dateTokenRe.test(c) && c.length > 20) { dataLine = c; dataIdx = j; break; }
      }
      if (!dataLine) { i++; continue; }

      // Extract dates from the data line
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

      // Extract numeric values after stripping dates
      let numericPart = dataLine.replace(/\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2}:\d{2}(?::\d{2})?/gi, '').trim();
      const numRe = /(-?\d{1,6}(?:,\d{3})*(?:\.\d+)?)/g;
      const nums = [];
      let nm;
      while ((nm = numRe.exec(numericPart)) !== null) {
        nums.push(parseFloat(nm[1].replace(/,(?=\d{3})/g, '')));
      }

      const lotsIdx    = nums.findIndex(n => n > 0 && n < 200);
      const lots       = lotsIdx !== -1 ? nums[lotsIdx] : nums[0];
      const rest       = nums.slice(lotsIdx !== -1 ? lotsIdx + 1 : 1);
      const isGold     = /XAU|GOLD/i.test(symbol);
      const priceNums  = rest.filter(n => isGold ? (n > 500 && n < 9999) : (n > 0.1 && n < 99999));
      const profit     = rest[rest.length - 1];

      if (lots && priceNums[0]) {
        trades.push(DataStore.enrichTrade({
          symbol, side: sideStr === 'buy' ? 'LONG' : 'SHORT',
          qty: lots, entry: priceNums[0], exit: priceNums[1] || priceNums[0],
          pnl: profit, commission: 0,
          entryDate: dateMatches[0] || new Date().toISOString(),
          exitDate:  dateMatches[1] || dateMatches[0] || new Date().toISOString(),
          notes: `Exness block format`,
          tags: ['exness', 'mt']
        }));
      }
      i = dataIdx + 1;
    }

    if (!trades.length) return null;
    log(`✅ Imported ${trades.length} trades from Exness block format`, logMessages, 'success');
    return { trades, broker: 'Exness (block format)', logMessages };
  }

  // ══════════════════════════════════════════════════════════
  // SHARED UTILITIES
  // ══════════════════════════════════════════════════════════

  // Build a map of lowercase-header → original-header
  // Used for safe key-based row access (immune to column shifting)
  function buildKeyMap(rawHeaders) {
    const keyMap = {};
    for (const h of rawHeaders) { keyMap[h.toLowerCase().trim()] = h; }
    return keyMap;
  }

  // Returns a function that finds the original header key
  // by matching normalised names (exact then partial)
  function makeHdrFinder(keyMap) {
    return (...names) => {
      for (const n of names) {
        if (keyMap[n]) return keyMap[n];
        const found = Object.keys(keyMap).find(k => k.includes(n));
        if (found) return keyMap[found];
      }
      return null;
    };
  }

  // Get value from row by key (safe — returns '' if key missing)
  function gv(row, key) {
    return key ? String(row[key] || '').trim() : '';
  }

  // Normalize forex/commodity/crypto symbol strings
  // Strips broker suffixes (m, .r, .p) and inserts slash
  function normalizeSymbol(raw) {
    if (!raw) return '';
    const s = raw.toUpperCase()
      .replace(/M$/,   '')   // XAUUSDm → XAUUSD
      .replace(/\.[A-Z]+$/, '') // XAUUSD.r → XAUUSD
      .replace(/PRO$/, '')   // EURUSDpro → EURUSD
      .trim();

    // Known forex/commodity pairs → add slash
    const pairs = [
      ['XAUUSD','XAU/USD'], ['XAGUSD','XAG/USD'],  ['XPTUSD','XPT/USD'],
      ['EURUSD','EUR/USD'], ['GBPUSD','GBP/USD'],   ['USDJPY','USD/JPY'],
      ['USDCHF','USD/CHF'], ['AUDUSD','AUD/USD'],   ['NZDUSD','NZD/USD'],
      ['USDCAD','USD/CAD'], ['EURGBP','EUR/GBP'],   ['EURJPY','EUR/JPY'],
      ['GBPJPY','GBP/JPY'], ['EURCHF','EUR/CHF'],   ['AUDCAD','AUD/CAD'],
      ['AUDCHF','AUD/CHF'], ['AUDJPY','AUD/JPY'],   ['AUDNZD','AUD/NZD'],
      ['CADJPY','CAD/JPY'], ['CHFJPY','CHF/JPY'],   ['EURAUD','EUR/AUD'],
      ['EURCAD','EUR/CAD'], ['EURNZD','EUR/NZD'],   ['GBPAUD','GBP/AUD'],
      ['GBPCAD','GBP/CAD'], ['GBPCHF','GBP/CHF'],   ['GBPNZD','GBP/NZD'],
      ['NZDCAD','NZD/CAD'], ['NZDCHF','NZD/CHF'],   ['NZDJPY','NZD/JPY'],
      ['USDCNH','USD/CNH'], ['USDHKD','USD/HKD'],   ['USDSGD','USD/SGD'],
      ['USDZAR','USD/ZAR'], ['USDSEK','USD/SEK'],   ['USDNOK','USD/NOK'],
      ['USDMXN','USD/MXN'], ['USDTRY','USD/TRY'],
      // Crypto
      ['BTCUSD','BTC/USD'], ['ETHUSD','ETH/USD'],   ['LTCUSD','LTC/USD'],
      ['XRPUSD','XRP/USD'], ['BNBUSD','BNB/USD'],   ['SOLUSD','SOL/USD'],
      ['ADAUSD','ADA/USD'], ['DOTUSD','DOT/USD'],   ['DOGEUSD','DOGE/USD'],
      // Indices
      ['US30','US30'], ['NAS100','NAS100'], ['SPX500','SPX500'],
      ['GER40','GER40'], ['UK100','UK100'], ['JPN225','JPN225'],
      ['AUS200','AUS200'], ['FRA40','FRA40'],
      // Commodities
      ['USOIL','USOIL'], ['UKOIL','UKOIL'], ['NGAS','NGAS'],
    ];

    for (const [from, to] of pairs) {
      if (s === from || s.startsWith(from)) return to;
    }
    if (s.includes('/')) return s; // already has slash
    return s; // return as-is (indices, custom, etc.)
  }

  // FIFO order matching — pairs BUY orders with SELL orders
  // Used by brokers that export individual orders (not round trips)
  function pairOrdersToTrades(orders) {
    const trades = [], bySymbol = {};
    for (const o of orders) {
      if (!bySymbol[o.symbol]) bySymbol[o.symbol] = { buys: [], sells: [] };
      if (o.side === 'LONG') bySymbol[o.symbol].buys.push(o);
      else bySymbol[o.symbol].sells.push(o);
    }
    for (const [symbol, { buys, sells }] of Object.entries(bySymbol)) {
      buys.sort((a, b)  => new Date(a.entryDate) - new Date(b.entryDate));
      sells.sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));
      let bi = 0, si = 0;
      let buyR = buys[0] ? buys[0].qty : 0;
      let sellR= sells[0] ? sells[0].qty : 0;
      while (bi < buys.length && si < sells.length) {
        const buy = buys[bi], sell = sells[si];
        const mQty = Math.min(buyR, sellR);
        const entryFirst = new Date(buy.entryDate) <= new Date(sell.entryDate);
        const en_ = entryFirst ? buy : sell;
        const ex_ = entryFirst ? sell : buy;
        const comm = ((buy.commission||0)+(sell.commission||0))*(mQty/buy.qty);
        trades.push(DataStore.enrichTrade({
          symbol, side: entryFirst ? 'LONG' : 'SHORT',
          qty: mQty, entry: en_.entry, exit: ex_.entry,
          stop: en_.stop, commission: comm,
          entryDate: en_.entryDate, exitDate: ex_.entryDate,
          notes: buy.notes || sell.notes || '',
          tags: [...new Set([...(buy.tags||[]),...(sell.tags||[])])]
        }));
        buyR -= mQty; sellR -= mQty;
        if (buyR  <= 0.001) { bi++; buyR  = buys[bi]  ? buys[bi].qty  : 0; }
        if (sellR <= 0.001) { si++; sellR = sells[si] ? sells[si].qty : 0; }
      }
      // Remaining unmatched buys = open positions
      while (bi < buys.length) {
        const b = buys[bi++];
        trades.push(DataStore.enrichTrade({ ...b, exit: b.entry, pnl: 0, result: 'OPEN', exitDate: null, notes: (b.notes||'')+' [OPEN]' }));
      }
    }
    return trades;
  }

  // Read file as UTF-8 text
  function readText(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => res(e.target.result);
      r.onerror = () => rej(new Error('File read failed'));
      r.readAsText(file, 'UTF-8');
    });
  }

  // Parse CSV text using PapaParse (handles quoted fields, BOM, etc.)
  function parseCSVText(text) {
    const t = text.replace(/^\uFEFF/, '');
    const result = Papa.parse(t, { header: true, skipEmptyLines: true, dynamicTyping: false, transformHeader: h => h.trim() });
    return result.data;
  }

  // Parse XLSX/XLS using SheetJS
  async function parseXLSX(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
          const ws = wb.Sheets[wb.SheetNames[0]];
          res(XLSX.utils.sheet_to_json(ws, { raw: false, defval: '' }));
        } catch (err) { rej(err); }
      };
      r.onerror = () => rej(new Error('XLSX read failed'));
      r.readAsArrayBuffer(file);
    });
  }

  function getHeaders(rows) { return rows.length ? Object.keys(rows[0]) : []; }

  // Strip currency symbols, quotes, and thousands-separator commas
  function clean(val) {
    if (val === null || val === undefined) return '';
    return String(val).replace(/[$%"']/g, '').replace(/,(?=\d{3})/g, '').trim();
  }

  // Parse a numeric string safely (handles $, commas, spaces)
  function parseNum(val) {
    if (val === null || val === undefined || val === '') return NaN;
    return parseFloat(String(val).replace(/[$%"',\s]/g, '').trim());
  }

  // Parse a date string into ISO format
  // Handles: ISO, "15 May 10:09", "2026.05.15 10:09", MM/DD/YYYY, DD.MM.YYYY
  function parseDate(str) {
    if (!str) return new Date().toISOString();
    try {
      const s = str.trim();
      // ISO / standard (most common)
      const d = new Date(s.replace(' ', 'T'));
      if (!isNaN(d.getTime())) return d.toISOString();
      // "15 May 10:09:46"
      const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
      const mt = s.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*(\d{4})?\s*(\d{2}:\d{2}(?::\d{2})?)?/i);
      if (mt) {
        const [h, m2, sc] = (mt[4]||'0:0:0').split(':').map(Number);
        const dt = new Date(mt[3]?parseInt(mt[3]):new Date().getFullYear(), MONTHS[mt[2].toLowerCase().slice(0,3)], parseInt(mt[1]), h, m2||0, sc||0);
        if (!isNaN(dt)) { if (dt > new Date()) dt.setFullYear(dt.getFullYear()-1); return dt.toISOString(); }
      }
      // "2024.05.15 10:09"
      const mt4 = s.match(/(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)?/);
      if (mt4) { const dt=new Date(`${mt4[1]}-${mt4[2]}-${mt4[3]}T${mt4[4]||'00:00'}`); if(!isNaN(dt)) return dt.toISOString(); }
      // MM/DD/YYYY
      const us = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if (us) { const y=us[3].length===2?2000+parseInt(us[3]):parseInt(us[3]); const dt=new Date(y,parseInt(us[1])-1,parseInt(us[2])); if(!isNaN(dt)) return dt.toISOString(); }
      // DD.MM.YYYY
      const eu = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      if (eu) { const dt=new Date(parseInt(eu[3]),parseInt(eu[2])-1,parseInt(eu[1])); if(!isNaN(dt)) return dt.toISOString(); }
    } catch(e) {}
    return new Date().toISOString();
  }

  function log(msg, arr, type = '') { arr.push({ msg, type }); }

  // ── PUBLIC API ────────────────────────────────────────────
  return { parseFile };

})();

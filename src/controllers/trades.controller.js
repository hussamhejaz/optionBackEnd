const { db, admin } = require('../database');

// Helper function to get current timestamp (works with both Firestore and local DB)
function getCurrentTimestamp() {
  if (admin && admin.firestore) {
    return admin.firestore.Timestamp.now();
  }
  // For local DB, return a simple timestamp object
  return {
    toDate: () => new Date(),
    toMillis: () => Date.now(),
    seconds: Math.floor(Date.now() / 1000),
    nanoseconds: 0
  };
}

// Helper function to get server timestamp (works with both Firestore and local DB)
function getServerTimestamp() {
  if (admin && admin.firestore) {
    return admin.firestore.FieldValue.serverTimestamp();
  }
  // For local DB, return current timestamp
  return getCurrentTimestamp();
}
const { requireFields } = require('../utils/validators');
const { getOptionQuote, getOptionContractStats } = require('../services/thetaClient');
const { sendTelegramMessage, sendTelegramPhoto } = require('../services/telegramService');
const { renderTradeCardPNG } = require('../services/cardRenderer');
const ENABLE_TELEGRAM_IMAGE =
  String(process.env.ENABLE_TELEGRAM_IMAGE || 'false').toLowerCase() === 'true';
const TELEGRAM_CHAT_ID_TRADES = process.env.TELEGRAM_CHAT_ID_TRADES || process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_BOT_TOKEN_TRADES =
  process.env.TELEGRAM_BOT_TOKEN_TRADES || process.env.TELEGRAM_BOT_TOKEN;

const OPTION_MULTIPLIER = 100; // standard equity option multiplier
const SUCCESS_PROFIT_TARGET_USD = 50;
const MIN_AD_AUTO_PROFIT_USD = 50;
const createTradeWriteTimeoutRaw = Number(process.env.CREATE_TRADE_WRITE_TIMEOUT_MS || 60000);
const createTradeWriteRecoveryRaw = Number(process.env.CREATE_TRADE_WRITE_RECOVERY_MS || 60000);
const CREATE_TRADE_WRITE_TIMEOUT_MS =
  Number.isFinite(createTradeWriteTimeoutRaw) ? createTradeWriteTimeoutRaw : 60000;
const CREATE_TRADE_WRITE_RECOVERY_MS =
  Number.isFinite(createTradeWriteRecoveryRaw) && createTradeWriteRecoveryRaw > 0
    ? createTradeWriteRecoveryRaw
    : 30000;

const collection = db.collection('trades');
const reportsCollection = db.collection('reports');
const adsCollection = db.collection('ads');

function normalizeExpiration(exp) {
  if (!exp) return null;
  const digits = String(exp).replace(/-/g, '');
  if (!/^[0-9]{8}$/.test(digits)) return null;
  return digits;
}



function normalizeRight(right) {
  const r = String(right || '').toLowerCase();
  return r === 'call' || r === 'put' ? r : null;
}


function normalizeStrike(strike) {
  const num = Number(strike);
  if (!Number.isFinite(num)) return null;
  return Number(num.toFixed(3));


}

function toFiniteNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof ts === 'object' && ts.seconds !== undefined) {
    const seconds = Number(ts.seconds);
    const nanos = Number(ts.nanoseconds || 0);
    if (Number.isFinite(seconds) && Number.isFinite(nanos)) {
      return (seconds * 1000) + (nanos / 1000000);
    }
  }
  return 0;
}

function getPeriodStartMillis(period) {
  const now = Date.now();
  if (period === 'all') return 0;
  if (period === 'weekly') return now - (7 * 24 * 60 * 60 * 1000);

  // default: daily (UTC calendar day)
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return start.getTime();
}

function resolveWinnerTimestampMillis(trade = {}) {
  return (
    toMillis(trade.closedAt) ||
    toMillis(trade.updatedAt) ||
    toMillis(trade.createdAt) ||
    0
  );
}

function normalizeTradeReportHighFields(trade = {}) {
  const normalized = { ...trade };
  const entry = toFiniteNumberOrNull(normalized.entryPrice);
  const close = toFiniteNumberOrNull(normalized.reportClosePrice ?? normalized.closePrice);
  const high = toFiniteNumberOrNull(normalized.highPrice);
  const contractsRaw = Number(normalized.contracts);
  const contracts = Number.isFinite(contractsRaw) && contractsRaw > 0 ? contractsRaw : 1;
  const peakPnlFromHigh =
    Number.isFinite(entry) && Number.isFinite(high)
      ? (high - entry) * OPTION_MULTIPLIER * contracts
      : null;
  const useHighPriceForReport =
    Boolean(normalized.usedHighPriceForReport) ||
    Boolean(normalized.hasReachedProfit50) ||
    normalized.successRule === 'PROFIT_TARGET_50_REACHED' ||
    (Number.isFinite(peakPnlFromHigh) && peakPnlFromHigh >= SUCCESS_PROFIT_TARGET_USD);

  const effectiveHigh = useHighPriceForReport ? high : close;
  const effectivePeakPriceReached = Number.isFinite(effectiveHigh)
    ? effectiveHigh
    : toFiniteNumberOrNull(normalized.peakPriceReached);
  const effectivePeakRisePrice =
    Number.isFinite(entry) && Number.isFinite(effectivePeakPriceReached)
      ? Number((effectivePeakPriceReached - entry).toFixed(4))
      : toFiniteNumberOrNull(normalized.peakRisePrice);
  const effectivePeakRisePercent =
    Number.isFinite(entry) && Number.isFinite(effectivePeakPriceReached) && entry !== 0
      ? Number((((effectivePeakPriceReached - entry) / entry) * 100).toFixed(2))
      : toFiniteNumberOrNull(normalized.peakRisePercent);
  const effectivePeakPnlAmount =
    Number.isFinite(entry) && Number.isFinite(effectivePeakPriceReached)
      ? Number(((effectivePeakPriceReached - entry) * OPTION_MULTIPLIER * contracts).toFixed(2))
      : toFiniteNumberOrNull(normalized.peakPnlAmount);

  if (Number.isFinite(effectiveHigh)) normalized.highPrice = effectiveHigh;
  if (Number.isFinite(effectivePeakPriceReached)) normalized.peakPriceReached = effectivePeakPriceReached;
  if (Number.isFinite(effectivePeakRisePrice)) normalized.peakRisePrice = effectivePeakRisePrice;
  if (Number.isFinite(effectivePeakRisePercent)) normalized.peakRisePercent = effectivePeakRisePercent;
  if (Number.isFinite(effectivePeakPnlAmount)) normalized.peakPnlAmount = effectivePeakPnlAmount;
  normalized.usedHighPriceForReport =
    Boolean(normalized.usedHighPriceForReport) || useHighPriceForReport;
  return normalized;
}

function hydrateTradeFromReport(trade = {}, report = null) {
  if (!report) return trade;

  const hydrated = { ...trade };
  if (!hydrated.symbol && report.symbol) hydrated.symbol = report.symbol;
  if (!hydrated.right && report.right) hydrated.right = report.right;
  if ((hydrated.strike === undefined || hydrated.strike === null) && report.strike !== undefined) {
    hydrated.strike = report.strike;
  }
  if (!hydrated.expiration && report.expiration) hydrated.expiration = report.expiration;

  if (!Number.isFinite(Number(hydrated.entryPrice)) && Number.isFinite(Number(report.entryPrice))) {
    hydrated.entryPrice = Number(report.entryPrice);
  }
  if (Number.isFinite(Number(report.closePrice))) {
    hydrated.closePrice = Number(report.closePrice);
  }
  if (Number.isFinite(Number(report.pnlAmount))) {
    hydrated.pnl = Number(report.pnlAmount);
  }
  if (Number.isFinite(Number(report.pnlPercent))) {
    hydrated.pnlPercent = Number(report.pnlPercent);
  }
  if (hydrated.isSuccessful === undefined && report.isSuccessful !== undefined) {
    hydrated.isSuccessful = Boolean(report.isSuccessful);
  }

  return hydrated;
}

function formatExpirationForCaption(expiration) {
  const raw = String(expiration || '').replace(/-/g, '');
  if (!/^\d{8}$/.test(raw)) return String(expiration || '');
  const y = raw.slice(0, 4);
  const m = raw.slice(4, 6);
  const d = raw.slice(6, 8);
  return `${d}-${m}-${y}`;
}

async function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(`${label} timed out`);
      err.statusCode = 504;
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function createTrade(req, res, next) {
  try {
    requireFields(req.body, ['symbol', 'right', 'strike', 'expiration']);
    const symbol = String(req.body.symbol).toUpperCase();
    const right = normalizeRight(req.body.right);
    const expiration = normalizeExpiration(req.body.expiration);
    const strike = normalizeStrike(req.body.strike);
    if (!right || !expiration || strike === null) {
      const error = new Error('Invalid right/expiration/strike');
      error.statusCode = 400;
      throw error;
    }

    const idempotencyKey = String(req.get('Idempotency-Key') || '').trim();
    const tradeId = idempotencyKey || collection.doc().id;
    const docRef = collection.doc(tradeId);
    const existing = await withTimeout(
      docRef.get(),
      CREATE_TRADE_WRITE_TIMEOUT_MS,
      'create trade precheck'
    );
    if (existing.exists) {
      return res.status(200).json({ id: tradeId, ...existing.data(), reused: true });
    }

    // Fetch live quote to set entryPrice automatically.
    let entryPrice = null;
    let quote = null;
    try {
      quote = await getOptionQuote({
        symbol,
        expiration,
        right,
        strike,
      });
      if (!Number.isFinite(quote?.mid)) {
        return res.status(400).json({ message: 'Invalid option contract (no data from market)' });
      }
      entryPrice = quote.mid;
    } catch (err) {
      const msg = err?.message || '';
      if (msg.includes('No data found')) {
        return res.status(400).json({ message: 'Invalid option contract (no data from market)' });
      }
      throw err;
    }

    const contractKey = `${symbol}-${expiration}-${right}-${strike}`;
    const stopLoss = req.body.stopLoss !== undefined ? Number(req.body.stopLoss) : null;
    const parsedContracts = Number(req.body.contracts);
    const contracts =
      Number.isFinite(parsedContracts) && parsedContracts > 0 ? Math.floor(parsedContracts) : 1;

    let openInterest = null;
    let volume = null;
    try {
      const stats = await getOptionContractStats({ symbol, expiration, right, strike });
      openInterest = toFiniteNumberOrNull(stats?.openInterest);
      volume = toFiniteNumberOrNull(stats?.volume);
    } catch (err) {
      openInterest = null;
      volume = null;
      console.warn(`contract stats fetch failed ${contractKey}: ${err.message}`);
    }
    console.log(
      `contract stats ${contractKey} | openInterest=${openInterest ?? 'null'} | volume=${volume ?? 'null'}`
    );

    const nowTs = getCurrentTimestamp();
    const payload = {
      symbol,
      right,
      strike,
      expiration,
      entryPrice,
      openInterest,
      volume,
      statsUpdatedAt: nowTs,
      stopLoss: Number.isFinite(stopLoss) ? stopLoss : null,
      status: 'OPEN',
      contracts,
      lastNotifiedPrice: Number.isFinite(entryPrice) ? Number(entryPrice.toFixed(2)) : null,
      lastMidPrice: null,
      lastQuoteAt: null,
      createdAt: nowTs,
      updatedAt: nowTs,
    };

    console.log(`create trade write started ${tradeId}`);
    const writeStartMs = Date.now();
    const writePromise = docRef.set(payload);
    writePromise
      .then(() => console.log(`fs write resolved ${tradeId}`))
      .catch((e) => console.warn(`fs write rejected ${tradeId}: ${e?.message || 'unknown error'}`));
    try {
      await withTimeout(writePromise, CREATE_TRADE_WRITE_TIMEOUT_MS, `create trade write ${tradeId}`);
      console.log(`create trade persisted ${tradeId} in ${Date.now() - writeStartMs}ms`);
    } catch (timeoutError) {
      console.error(`create trade write timeout ${tradeId}: ${timeoutError.message}`);
      throw timeoutError;
    }
    if (res.headersSent || res.writableEnded) {
      return;
    }
    res.status(201).json({ id: tradeId, ...payload });

    const creationText =
      `✨ مقترح جديد 🚀\n` +
       `🌟 ليست توصية للشراء او البيع 🌟\n`
      `🏢 الرمز: ${payload.symbol}\n` +
      `🏷️ النوع: ${String(payload.right).toUpperCase()}\n` +
      `🎯 السترايك: ${payload.strike}\n` +
      `📅 التاريخ: ${formatExpirationForCaption(payload.expiration)}\n` +
      `💵 الدخول: ${payload.entryPrice ?? 'n/a'}`;

    void (async () => {
      try {
        if (ENABLE_TELEGRAM_IMAGE) {
          try {
            const card = await renderTradeCardPNG({
              symbol: payload.symbol,
              strike: payload.strike,
              expiration: payload.expiration,
              right: payload.right,
              entryPrice: payload.entryPrice,
              mid: payload.entryPrice,
              openInterest: toFiniteNumberOrNull(openInterest),
              volume: toFiniteNumberOrNull(volume),
              pnlValue: 0,
              pnlPct: 0,
            });
            await sendTelegramPhoto({
              caption: creationText,
              imageBuffer: card,
              chatId: TELEGRAM_CHAT_ID_TRADES,
              token: TELEGRAM_BOT_TOKEN_TRADES,
            });
          } catch (photoErr) {
            console.error(`Telegram image send failed (new trade) for ${tradeId}:`, photoErr.message);
            await sendTelegramMessage(creationText, {
              chatId: TELEGRAM_CHAT_ID_TRADES,
              token: TELEGRAM_BOT_TOKEN_TRADES,
            });
          }
        } else {
          await sendTelegramMessage(creationText, {
            chatId: TELEGRAM_CHAT_ID_TRADES,
            token: TELEGRAM_BOT_TOKEN_TRADES,
          });
        }
      } catch (err) {
        console.error(`Telegram send failed (new trade) for ${tradeId}:`, err.message);
      }
      try {
        await db.collection('alerts').add({
          tradeId,
          type: 'NEW_TRADE',
          mid: payload.entryPrice,
          reached: null,
          createdAt: getServerTimestamp(),
        });
      } catch (e) {
        console.error('Failed to log alert metadata (new trade):', e.message);
      }
    })();
  } catch (err) {
    next(err);
  }
}

async function getTrades(req, res, next) {
  try {
    const status = (req.query.status || 'OPEN').toUpperCase();
    // Avoid Firestore composite index requirement (status + createdAt) by client-side sort.
    const snap = await collection.where('status', '==', status).get();
    const trades = snap.docs
      .map((doc) => {
        const trade = { id: doc.id, ...doc.data() };
        
        // Calculate price direction and change
        const currentPrice = trade.lastMidPrice || trade.lastNotifiedPrice;
        if (currentPrice && trade.entryPrice) {
          const change = currentPrice - trade.entryPrice;
          const changePercent = (change / trade.entryPrice) * 100;
          trade.priceDirection = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
          trade.priceChange = Number(change.toFixed(2));
          trade.priceChangePercent = Number(changePercent.toFixed(2));
        } else {
          trade.priceDirection = null;
          trade.priceChange = 0;
          trade.priceChangePercent = 0;
        }
        
        return status === 'CLOSED' ? normalizeTradeReportHighFields(trade) : trade;
      })
      .sort((a, b) => {
        const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return tb - ta; // desc
      });
    res.json(trades);
  } catch (err) {
    next(err);
  }
}

async function getTradesDashboard(req, res, next) {
  try {
    const status = (req.query.status || 'OPEN').toUpperCase();
    const snap = await collection.where('status', '==', status).get();
    const trades = snap.docs
      .map((doc) => {
        const data = doc.data();
        const entry = Number.isFinite(data.entryPrice) ? data.entryPrice : 0;
        const current = Number.isFinite(data.lastMidPrice) ? data.lastMidPrice : entry;
        const contracts = Number.isFinite(data.contracts) ? data.contracts : 1;
        const diff = current - entry;
        const percent = entry ? Number(((diff / entry) * 100).toFixed(2)) : 0;
        const amount = Number((diff * OPTION_MULTIPLIER * contracts).toFixed(2));
        const priceDirection = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
        const trade = {
          id: doc.id,
          symbol: data.symbol,
          right: data.right,
          strike: data.strike,
          expiration: data.expiration,
          status: data.status,
          entryPrice: entry,
          currentPrice: current,
          highPrice: data.highPrice ?? null,
          openInterest: Number.isFinite(Number(data.openInterest)) ? Number(data.openInterest) : null,
          volume: Number.isFinite(Number(data.volume)) ? Number(data.volume) : null,
          statsUpdatedAt: data.statsUpdatedAt ?? null,
          lastMidPrice: data.lastMidPrice ?? null,
          lastQuoteAt: data.lastQuoteAt ?? null,
          updatedAt: data.updatedAt ?? null,
          contracts,
          pnlAmount: amount,
          pnlPercent: percent,
          priceDirection,
          priceChange: Number(diff.toFixed(2)),
        };
        return status === 'CLOSED' ? normalizeTradeReportHighFields(trade) : trade;
      })
      .sort((a, b) => {
        const ta = a.updatedAt?.toMillis ? a.updatedAt.toMillis() : 0;
        const tb = b.updatedAt?.toMillis ? b.updatedAt.toMillis() : 0;
        return tb - ta; // newest first
      });

    res.json(trades);
  } catch (err) {
    next(err);
  }
}

async function getHighestHighPrice(req, res, next) {
  try {
    const status = (req.query.status || 'OPEN').toUpperCase();
    const snap = await collection.where('status', '==', status).get();
    const best = snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((t) => Number.isFinite(t.highPrice))
      .sort((a, b) => b.highPrice - a.highPrice)[0];

    if (!best) {
      return res.status(404).json({ message: 'No trades with highPrice found' });
    }
    res.json(best);
  } catch (err) {
    next(err);
  }
}

function formatPeriods(date) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  // ISO week number
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  const week = String(weekNo).padStart(2, '0');
  return {
    daily: `${y}-${m}-${day}`,
    weekly: `${y}-W${week}`,
    monthly: `${y}-${m}`,
  };
}

function derivePnlAmount(trade = {}) {
  const directPnl = Number(trade.pnl);
  if (Number.isFinite(directPnl)) return directPnl;

  const entry = Number(trade.entryPrice);
  const current = Number(trade.closePrice ?? trade.lastMidPrice ?? trade.lastNotifiedPrice);
  const contractsRaw = Number(trade.contracts);
  const contracts = Number.isFinite(contractsRaw) && contractsRaw > 0 ? contractsRaw : 1;
  if (!Number.isFinite(entry) || !Number.isFinite(current)) return null;
  return (current - entry) * OPTION_MULTIPLIER * contracts;
}

async function upsertAutoAdFromTrade(tradeId, trade) {
  if (!tradeId || !trade || trade.autoAdSuppressedAt) return;
  const pnlAmount = Number(trade.reportPnlAmount ?? trade.pnl);
  if (!Number.isFinite(pnlAmount) || pnlAmount < MIN_AD_AUTO_PROFIT_USD) return;

  const pnlPercent = Number(trade.reportPnlPercent ?? trade.pnlPercent);
  const entryPrice = Number(trade.entryPrice);
  const closePrice = Number(trade.reportClosePrice ?? trade.closePrice ?? trade.lastMidPrice);
  const adId = `auto-${tradeId}`;
  const adRef = adsCollection.doc(adId);
  const nowTs = getServerTimestamp();
  const adSnap = await adRef.get();
  const previous = adSnap.exists ? adSnap.data() || {} : {};

  await adRef.set(
    {
      tradeId,
      title:
        previous.title ||
        `${String(trade.symbol || '').toUpperCase()} ${String(trade.right || '').toUpperCase()} ${trade.strike}`,
      status: previous.status || 'ready',
      symbol: trade.symbol,
      right: trade.right,
      strike: trade.strike,
      expiration: trade.expiration,
      entryPrice: Number.isFinite(entryPrice) ? Number(entryPrice.toFixed(2)) : null,
      closePrice: Number.isFinite(closePrice) ? Number(closePrice.toFixed(2)) : null,
      pnlAmount: Number(pnlAmount.toFixed(2)),
      pnlPercent: Number.isFinite(pnlPercent) ? Number(pnlPercent.toFixed(2)) : null,
      isSuccessful: true,
      openInterest: Number.isFinite(Number(trade.openInterest)) ? Number(trade.openInterest) : null,
      volume: Number.isFinite(Number(trade.volume)) ? Number(trade.volume) : null,
      autoGenerated: true,
      source: previous.source || 'AUTO_PROFIT_50_USD',
      createdAt: previous.createdAt || nowTs,
      updatedAt: nowTs,
    },
    { merge: true }
  );
}

async function finalizeClose({ id, reason, closePriceOverride, stopLossValue }) {
  const ref = collection.doc(id);
  const doc = await ref.get();
  if (!doc.exists) return { notFound: true };
  const data = doc.data();
  const contracts = Number.isFinite(data.contracts) ? data.contracts : 1;
  const entry = Number.isFinite(data.entryPrice) ? data.entryPrice : null;
  const closePrice = Number.isFinite(closePriceOverride)
    ? closePriceOverride
    : Number.isFinite(data.lastMidPrice)
      ? data.lastMidPrice
      : entry;

  const pnlAmount =
    Number.isFinite(entry) && Number.isFinite(closePrice)
      ? (closePrice - entry) * OPTION_MULTIPLIER * contracts
      : null;
  const pnlPercent =
    Number.isFinite(entry) && Number.isFinite(closePrice) && entry !== 0
      ? Number((((closePrice - entry) / entry) * 100).toFixed(2))
      : null;
  const highPrice = Number.isFinite(Number(data.highPrice)) ? Number(data.highPrice) : null;
  const maxPnlAmount =
    Number.isFinite(entry) && Number.isFinite(highPrice)
      ? (highPrice - entry) * OPTION_MULTIPLIER * contracts
      : null;
  const hasReachedProfitTarget =
    Boolean(data.hasReachedProfit50 || data.reachedProfit50At || data.milestone50SentAt) ||
    (Number.isFinite(maxPnlAmount) && maxPnlAmount >= SUCCESS_PROFIT_TARGET_USD);
  const dippedBelowEntryAfterProfitTarget = Boolean(data.dippedBelowEntryAfterProfit50);
  const hasHighPriceAboveEntry =
    Number.isFinite(highPrice) && Number.isFinite(entry) && highPrice > entry;
  // Keep peak price in report only when trade reached the 50$ profit target.
  const useHighPriceForReport = hasReachedProfitTarget && hasHighPriceAboveEntry;
  const reportClosePrice = useHighPriceForReport ? highPrice : closePrice;
  const reportHighPrice = useHighPriceForReport ? highPrice : reportClosePrice;
  const reportPnlAmount =
    Number.isFinite(entry) && Number.isFinite(reportClosePrice)
      ? (reportClosePrice - entry) * OPTION_MULTIPLIER * contracts
      : null;
  const reportPnlPercent =
    Number.isFinite(entry) && Number.isFinite(reportClosePrice) && entry !== 0
      ? Number((((reportClosePrice - entry) / entry) * 100).toFixed(2))
      : null;
  const peakPriceReached = Number.isFinite(reportHighPrice)
    ? reportHighPrice
    : Number.isFinite(reportClosePrice)
      ? reportClosePrice
      : null;
  const peakRisePrice =
    Number.isFinite(entry) && Number.isFinite(peakPriceReached)
      ? Number((peakPriceReached - entry).toFixed(4))
      : null;
  const peakRisePercent =
    Number.isFinite(entry) && Number.isFinite(peakPriceReached) && entry !== 0
      ? Number((((peakPriceReached - entry) / entry) * 100).toFixed(2))
      : null;
  const peakPnlAmount =
    Number.isFinite(entry) && Number.isFinite(peakPriceReached)
      ? Number(((peakPriceReached - entry) * OPTION_MULTIPLIER * contracts).toFixed(2))
      : null;
  const isSuccessful =
    hasReachedProfitTarget || (Number.isFinite(pnlAmount) && pnlAmount > 0);
  const successRule = hasReachedProfitTarget ? 'PROFIT_TARGET_50_REACHED' : 'POSITIVE_PNL';

  const closedAt = getServerTimestamp();
  const updates = {
    status: 'CLOSED',
    closedAt,
    closePrice: Number.isFinite(reportClosePrice) ? reportClosePrice : null,
    closePriceActual: Number.isFinite(closePrice) ? closePrice : null,
    pnl: reportPnlAmount,
    pnlPercent: reportPnlPercent,
    pnlActual: pnlAmount,
    pnlPercentActual: pnlPercent,
    reportClosePrice: Number.isFinite(reportClosePrice) ? reportClosePrice : null,
    reportPnlAmount,
    reportPnlPercent,
    peakPriceReached,
    peakRisePrice,
    peakRisePercent,
    peakPnlAmount,
    isSuccessful,
    successRule,
    hasReachedProfit50: hasReachedProfitTarget,
    dippedBelowEntryAfterProfit50: dippedBelowEntryAfterProfitTarget,
    usedHighPriceForReport: useHighPriceForReport,
    stopLoss: Number.isFinite(stopLossValue) ? stopLossValue : data.stopLoss ?? null,
    updatedAt: closedAt,
    // Preserve symbol, right, strike, expiration for winning trades
    ...(data.symbol && { symbol: data.symbol }),
    ...(data.right && { right: data.right }),
    ...(data.strike !== undefined && data.strike !== null && { strike: data.strike }),
    ...(data.expiration && { expiration: data.expiration }),
  };

  await ref.set(updates, { merge: true });
  const finalSnap = await ref.get();
  const finalData = finalSnap.data();

  // Store report document (daily/weekly/monthly buckets)
  const { daily, weekly, monthly } = formatPeriods(new Date());
  await db.collection('reports').add({
    tradeId: id,
    symbol: data.symbol,
    right: data.right,
    strike: data.strike,
    expiration: data.expiration,
    contracts,
    entryPrice: entry,
    closePrice: Number.isFinite(reportClosePrice) ? reportClosePrice : updates.closePrice,
    closePriceActual: updates.closePriceActual,
    highPrice: Number.isFinite(reportHighPrice) ? reportHighPrice : null,
    pnlAmount: reportPnlAmount,
    pnlPercent: reportPnlPercent,
    peakPriceReached,
    peakRisePrice,
    peakRisePercent,
    peakPnlAmount,
    pnlAmountActual: pnlAmount,
    pnlPercentActual: pnlPercent,
    isSuccessful,
    successRule,
    hasReachedProfit50: hasReachedProfitTarget,
    dippedBelowEntryAfterProfit50: dippedBelowEntryAfterProfitTarget,
    usedHighPriceForReport: useHighPriceForReport,
    status: 'CLOSED',
    reason,
    closedAt: getServerTimestamp(),
    periodDaily: daily,
    periodWeekly: weekly,
    periodMonthly: monthly,
  });

  try {
    await upsertAutoAdFromTrade(id, {
      ...finalData,
      symbol: data.symbol,
      right: data.right,
      strike: data.strike,
      expiration: data.expiration,
      entryPrice: Number.isFinite(entry) ? entry : finalData.entryPrice,
      reportClosePrice,
      reportPnlAmount,
      reportPnlPercent,
      openInterest: data.openInterest,
      volume: data.volume,
      autoAdSuppressedAt: data.autoAdSuppressedAt,
    });
  } catch (adErr) {
    console.error(`Auto ad upsert failed on close (${id}):`, adErr.message);
  }

  return { data: { id: finalSnap.id, ...finalData } };
}

async function closeTrade(req, res, next) {
  try {
    const { id } = req.params;
    const closePriceOverride =
      req.body && req.body.closePrice !== undefined ? Number(req.body.closePrice) : undefined;
    const result = await finalizeClose({ id, reason: 'MANUAL_CLOSE', closePriceOverride });
    if (result.notFound) return res.status(404).json({ message: 'Trade not found' });
    res.json(result.data);
  } catch (err) {
    next(err);
  }
}

async function updateStopLoss(req, res, next) {
  try {
    // stopLoss is required and should be the current price when user triggers stop-loss.
    const stopLoss = Number(req.body?.stopLoss);
    if (!Number.isFinite(stopLoss)) {
      const error = new Error('الرجاء إدخال سعر وقف الخسارة');
      error.statusCode = 400;
      throw error;
    }
    const { id } = req.params;
    // Close the trade on stop-loss and persist report.
    const result = await finalizeClose({
      id,
      reason: 'STOP_LOSS',
      closePriceOverride: stopLoss,
      stopLossValue: stopLoss,
    });
    if (result.notFound) return res.status(404).json({ message: 'Trade not found' });
    res.json(result.data);

    // Fire-and-forget Telegram stop-loss alert after closing.
    const symbol = String(result.data.symbol || '').toUpperCase();
    const right = String(result.data.right || '').toUpperCase();
    const stopText =
      `🛑 تنبيه وقف خسارة (Stop Loss) 🛑\n\n` +
      `📉 ${symbol} (${right})\n\n` +
      `⚠️ الخروج للحفاظ على رأس المال.\n` +
      `معوضين خير، والقادم أجمل بإذن الله. 🤲`;
    sendTelegramMessage(stopText, {
      chatId: TELEGRAM_CHAT_ID_TRADES,
      token: TELEGRAM_BOT_TOKEN_TRADES,
    }).catch(() => {});
  } catch (err) {
    next(err);
  }
}

async function getWinningTrades(req, res, next) {
  try {
    const minPnlQuery = Number(req.query?.minPnl);
    const minPnl = Number.isFinite(minPnlQuery) ? minPnlQuery : 50;
    const period = String(req.query?.period || 'daily').toLowerCase();
    const periodStartMillis = getPeriodStartMillis(period);

    // Fetch open/closed trades + reports, then merge so report-only winners are not lost.
    const [closedSnap, openSnap, reportsSnap] = await Promise.all([
      collection.where('status', '==', 'CLOSED').get(),
      collection.where('status', '==', 'OPEN').get(),
      reportsCollection.get(),
    ]);
    const latestReportByTradeId = new Map();
    reportsSnap.forEach((doc) => {
      const report = doc.data() || {};
      const tradeId = String(report.tradeId || '');
      if (!tradeId) return;
      const current = latestReportByTradeId.get(tradeId);
      if (!current || toMillis(report.closedAt) >= toMillis(current.closedAt)) {
        latestReportByTradeId.set(tradeId, report);
      }
    });

    const winnersById = new Map();

    const addWinnerCandidate = (trade) => {
      if (!trade || !trade.id) return;
      // Trade qualifies if marked successful or has positive PnL.
      const isSuccessful = Boolean(trade.isSuccessful);
      const pnlValue = derivePnlAmount(trade);
      if (!Number.isFinite(pnlValue)) return;
      if (!isSuccessful && pnlValue <= 0) return;
      if (pnlValue < minPnl) return;
      trade.pnl = pnlValue;

      // Only include trades with valid symbol and strike
      const symbol = String(trade.symbol || '').trim().toUpperCase();
      const isValidSymbol = /^[A-Z0-9]{1,10}(?:[.\-][A-Z0-9]{1,4})?$/.test(symbol);
      if (!isValidSymbol) return;

      // Only include trades with valid strike
      if (!Number.isFinite(trade.strike) || trade.strike <= 0) return;

      // Only include trades with valid entry price
      if (!Number.isFinite(trade.entryPrice) || trade.entryPrice <= 0) return;

      const currentPrice = trade.closePrice || trade.lastMidPrice || trade.lastNotifiedPrice;
      if (currentPrice && trade.entryPrice) {
        const change = currentPrice - trade.entryPrice;
        trade.priceDirection = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
        trade.priceChange = Number(change.toFixed(2));
      } else {
        trade.priceDirection = null;
        trade.priceChange = 0;
      }

      const existing = winnersById.get(trade.id);
      if (!existing || pnlValue >= Number(existing.pnl || 0)) {
        winnersById.set(trade.id, trade);
      }
    };

    // First: live winners from OPEN trades (current profit reached threshold).
    openSnap.docs.forEach((doc) => {
      const rawTrade = { id: doc.id, ...doc.data() };
      addWinnerCandidate(rawTrade);
    });

    // Second: winners from CLOSED trade documents (hydrated with latest reports when present)
    closedSnap.docs.forEach((doc) => {
      const rawTrade = { id: doc.id, ...doc.data() };
      const trade = hydrateTradeFromReport(rawTrade, latestReportByTradeId.get(doc.id) || null);
      addWinnerCandidate(trade);
    });

    // Third: fallback winners from reports even if the trade document is missing
    latestReportByTradeId.forEach((report, tradeId) => {
      if (winnersById.has(tradeId)) return;
      const reportTrade = {
        id: tradeId,
        status: 'CLOSED',
        symbol: report.symbol,
        right: report.right,
        strike: report.strike,
        expiration: report.expiration,
        entryPrice: Number.isFinite(Number(report.entryPrice)) ? Number(report.entryPrice) : null,
        closePrice: Number.isFinite(Number(report.closePrice)) ? Number(report.closePrice) : null,
        pnl: Number.isFinite(Number(report.pnlAmount)) ? Number(report.pnlAmount) : null,
        pnlPercent: Number.isFinite(Number(report.pnlPercent)) ? Number(report.pnlPercent) : null,
        isSuccessful: Boolean(report.isSuccessful),
        closedAt: report.closedAt || null,
        updatedAt: report.closedAt || null,
      };
      addWinnerCandidate(reportTrade);
    });

    const winners = Array.from(winnersById.values())
      .filter((trade) => resolveWinnerTimestampMillis(trade) >= periodStartMillis)
      .sort((a, b) => (b.pnl || 0) - (a.pnl || 0));
    res.json(winners);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createTrade,
  getTrades,
  getTradesDashboard,
  getHighestHighPrice,
  closeTrade,
  updateStopLoss,
  getWinningTrades,
};

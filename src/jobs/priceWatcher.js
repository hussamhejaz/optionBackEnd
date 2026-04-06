const { db, admin } = require('../database');
const { getOptionQuote, getOptionContractStats, getFpssStatus } = require('../services/thetaClient');
const { sendTelegramMessage, sendTelegramPhoto } = require('../services/telegramService');
const { renderTradeCardPNG } = require('../services/cardRenderer');

const ENABLE_TELEGRAM_IMAGE =
  String(process.env.ENABLE_TELEGRAM_IMAGE || 'false').toLowerCase() === 'true';
const TELEGRAM_CHAT_ID_TRADES = process.env.TELEGRAM_CHAT_ID_TRADES || process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_BOT_TOKEN_TRADES =
  process.env.TELEGRAM_BOT_TOKEN_TRADES || process.env.TELEGRAM_BOT_TOKEN;

const enabled = String(process.env.ENABLE_WATCHER).toLowerCase() === 'true';
const intervalMs = Number(process.env.WATCH_INTERVAL_MS || process.env.PRICE_WATCH_INTERVAL_MS || 800);
const alertStep = Number(process.env.ALERT_STEP || process.env.PRICE_STEP || 0.1);
const highPriceSanityMultiplierRaw = Number(process.env.HIGH_PRICE_SANITY_MULTIPLIER || 8);
const HIGH_PRICE_SANITY_MULTIPLIER =
  Number.isFinite(highPriceSanityMultiplierRaw) && highPriceSanityMultiplierRaw > 1
    ? highPriceSanityMultiplierRaw
    : 8;
const thetaPreflightIntervalRaw = Number(process.env.THETA_PREFLIGHT_INTERVAL_MS || 5000);
const THETA_PREFLIGHT_INTERVAL_MS =
  Number.isFinite(thetaPreflightIntervalRaw) && thetaPreflightIntervalRaw >= 0
    ? thetaPreflightIntervalRaw
    : 5000;
const thetaUnavailableLogIntervalRaw = Number(process.env.THETA_UNAVAILABLE_LOG_INTERVAL_MS || 15000);
const THETA_UNAVAILABLE_LOG_INTERVAL_MS =
  Number.isFinite(thetaUnavailableLogIntervalRaw) && thetaUnavailableLogIntervalRaw >= 0
    ? thetaUnavailableLogIntervalRaw
    : 15000;
const watcherStatsLoggingEnabled =
  String(process.env.WATCHER_STATS_LOGGING || 'false').toLowerCase() === 'true';
const MAX_TRADES = 10000; // Support 100+ trades

let timer = null;
let tickRunning = false;
let lastThetaPreflightAt = 0;
let thetaReady = false;
let thetaStatusLabel = null;
let lastThetaUnavailableLogAt = 0;
let preflightTimer = null;

function roundToStep(value, step) {
  return Number((Math.floor(value / step) * step).toFixed(2));
}

function toFiniteNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// Helper function to get server timestamp (works with both Firestore and local DB)
function getServerTimestamp() {
  if (admin && admin.firestore) {
    return admin.firestore.FieldValue.serverTimestamp();
  }
  // For local DB, return current timestamp
  return new Date().toISOString();
}

function parseThetaStatusLabel(statusPayload) {
  if (!statusPayload) return null;
  if (typeof statusPayload === 'string') return statusPayload.trim().toUpperCase() || null;
  const candidates = [
    statusPayload.status,
    statusPayload.fpssStatus,
    statusPayload.connectionStatus,
    statusPayload.state,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().toUpperCase();
    }
  }
  return null;
}

function shouldLogThetaUnavailable(now = Date.now()) {
  return now - lastThetaUnavailableLogAt >= THETA_UNAVAILABLE_LOG_INTERVAL_MS;
}

function logThetaUnavailable(message) {
  const now = Date.now();
  if (!shouldLogThetaUnavailable(now)) return;
  lastThetaUnavailableLogAt = now;
  console.warn(message);
}

function isThetaSessionInvalid(err) {
  const message = String(err?.message || '').toLowerCase();
  const responseBody = String(err?.responseBody || '').toLowerCase();
  return (
    err?.statusCode === 478 ||
    message.includes('invalid session id') ||
    responseBody.includes('invalid session id')
  );
}

function markThetaUnavailable(message) {
  thetaReady = false;
  thetaStatusLabel = null;
  lastThetaPreflightAt = 0;
  logThetaUnavailable(message);
}

async function ensureThetaReady() {
  const now = Date.now();
  if (thetaReady && now - lastThetaPreflightAt < THETA_PREFLIGHT_INTERVAL_MS) {
    return true;
  }

  lastThetaPreflightAt = now;

  try {
    const statusPayload = await getFpssStatus();
    const statusLabel = parseThetaStatusLabel(statusPayload);
    thetaStatusLabel = statusLabel;
    thetaReady = !statusLabel || statusLabel === 'CONNECTED';

    if (!thetaReady) {
      logThetaUnavailable(`Price watcher paused: Theta status is ${statusLabel}.`);
    }

    return thetaReady;
  } catch (err) {
    markThetaUnavailable(`Price watcher paused: Theta is unavailable (${err.message}).`);
    return false;
  }
}

async function resolveContractStats({ symbol, expiration, right, strike, quote }) {
  let openInterest = toFiniteNumberOrNull(quote?.openInterest);
  let volume = toFiniteNumberOrNull(quote?.volume);
  const contractKey = `${symbol}-${expiration}-${right}-${strike}`;

  if ((openInterest === null || openInterest <= 0) || (volume === null || volume <= 0)) {
    try {
      const stats = await getOptionContractStats({ symbol, expiration, right, strike });
      const oiFromStats = toFiniteNumberOrNull(stats?.openInterest);
      const volFromStats = toFiniteNumberOrNull(stats?.volume);
      if (oiFromStats !== null) openInterest = oiFromStats;
      if (volFromStats !== null) volume = volFromStats;
    } catch (err) {
      console.warn(`watcher stats fetch failed ${contractKey}: ${err.message}`);
    }
  }

  if (watcherStatsLoggingEnabled) {
    console.log(
      `watcher stats ${contractKey} | openInterest=${openInterest ?? 'null'} | volume=${volume ?? 'null'}`
    );
  }

  return { openInterest, volume };
}

function buildAutoAdTitle({ symbol, right, strike }) {
  return `${String(symbol || '').toUpperCase()} ${String(right || '').toUpperCase()} ${strike}`;
}

function getHighPriceReference(trade = {}) {
  const candidates = [trade.entryPrice, trade.lastMidPrice]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

function sanitizeHighCandidate(value, reference) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (!Number.isFinite(reference) || reference <= 0) return numeric;
  if (numeric > (reference * HIGH_PRICE_SANITY_MULTIPLIER)) return reference;
  return numeric;
}

async function processTrade(doc) {
  const data = doc.data();
  const { symbol, expiration, right, strike } = data;

  try {
    const quote = await getOptionQuote({ symbol, expiration, right, strike });
    const { bid, ask, mid } = quote;
    if (!Number.isFinite(mid)) return;
    const stats = await resolveContractStats({ symbol, expiration, right, strike, quote });

    const baseline = Number.isFinite(data.lastNotifiedPrice)
      ? data.lastNotifiedPrice
      : Number.isFinite(data.entryPrice)
        ? data.entryPrice
        : mid;
    const entry = Number.isFinite(data.entryPrice) ? data.entryPrice : mid;
    const contracts = Number.isFinite(data.contracts) ? data.contracts : 1;
    const pnlAmount = (mid - entry) * 100 * contracts;
    const pnlPercent = entry ? ((mid - entry) / entry) * 100 : 0;
    const highReference = getHighPriceReference(data);
    const previousHighPrice = sanitizeHighCandidate(data.highPrice, highReference);
    const midForHighCheck = sanitizeHighCandidate(mid, highReference);
    const highForCheck = Number.isFinite(previousHighPrice)
      ? Math.max(previousHighPrice, Number.isFinite(midForHighCheck) ? midForHighCheck : previousHighPrice)
      : Number.isFinite(midForHighCheck)
        ? midForHighCheck
        : mid;
    const highPnlAmount =
      Number.isFinite(entry) && Number.isFinite(highForCheck)
        ? (highForCheck - entry) * 100 * contracts
        : null;
    const reachedFiftyDollars = pnlAmount >= 50;
    const hadReachedFiftyBefore = Boolean(data.reachedProfit50At || data.hasReachedProfit50);
    const reachedFiftyFromHigh = Number.isFinite(highPnlAmount) && highPnlAmount >= 50;
    const reachedFiftyNow = reachedFiftyDollars && !hadReachedFiftyBefore;
    const hasReachedFifty = hadReachedFiftyBefore || reachedFiftyDollars || reachedFiftyFromHigh;
    const dippedBelowEntryAfter50 = hasReachedFifty && mid < entry;
    const midRounded = Number(mid.toFixed(2));
    const lastAlertMid = toFiniteNumberOrNull(data.lastAlertMid);
    const currentHighPrice = highForCheck;

    const updates = {
      lastMidPrice: mid,
      highPrice: currentHighPrice,
      openInterest: toFiniteNumberOrNull(stats.openInterest),
      volume: toFiniteNumberOrNull(stats.volume),
      statsUpdatedAt: getServerTimestamp(),
      updatedAt: getServerTimestamp(),
      hasReachedProfit50: hasReachedFifty,
      dippedBelowEntryAfterProfit50:
        Boolean(data.dippedBelowEntryAfterProfit50) || dippedBelowEntryAfter50,
    };
    if (reachedFiftyNow) {
      updates.reachedProfit50At = getServerTimestamp();
    }

    const shouldSendStepAlertByStep =
      mid >= baseline + alertStep &&
      (!Number.isFinite(lastAlertMid) || Math.abs(lastAlertMid - midRounded) >= 0.005);
    const shouldSendStepAlert = shouldSendStepAlertByStep || reachedFiftyNow;
    const shouldSendProfit50Alert = hasReachedFifty && !data.milestone50SentAt;
    const shouldCreateAutoAd =
      hasReachedFifty &&
      !data.autoAdSuppressedAt;

    let stepText = '';
    const milestoneText =
      `🎉 كفو! حققنا 50$ 💵\n\n` +
      `💎 العقد: ${String(symbol || '').toUpperCase()} (${String(right).toUpperCase()})\n` +
      `🛡️  (تأمين الصفقة).`;
    let reached = null;
    if (shouldSendStepAlert) {
      reached = roundToStep(mid - baseline, alertStep) + baseline;
      stepText = reachedFiftyNow
        ? `✨ تحديث العقد ✨\n\n${milestoneText}`
        : `✨ <b>تحديث العقد</b> ✨\n\n` +
          `Symbol: ${symbol}\n` +
          `Type: ${String(right).toUpperCase()}\n` +
          `Strike: ${strike}\n` +
          `Exp: ${expiration}\n` +
          `Mid: ${mid.toFixed(2)}\n` +
          `Reached: ${reached.toFixed(2)}\n` +
          `Time: ${new Date().toISOString()}`;

      console.log(
        `UP ALERT => ${symbol} ${String(right).toUpperCase()} ${strike} exp ${expiration} | Mid: ${mid.toFixed(
          2
        )} Reached: ${reached.toFixed(2)}`
      );

      try {
        await db.collection('alerts').add({
          tradeId: doc.id,
          symbol,
          right,
          strike,
          expiration,
          bid,
          ask,
          mid,
          reached,
          step: alertStep,
          createdAt: getServerTimestamp(),
        });
      } catch (err) {
        console.error('Failed to persist alert metadata:', err.message);
      }

      updates.lastNotifiedPrice = reached;
      updates.lastAlertMid = midRounded;
    }

    let stepAlertSent = false;
    if (shouldSendStepAlert) {
      try {
        if (ENABLE_TELEGRAM_IMAGE) {
          try {
            const cardBuffer = await renderTradeCardPNG({
              symbol,
              strike,
              expiration,
              right,
              entryPrice: entry,
              mid,
              openInterest: toFiniteNumberOrNull(stats.openInterest),
              volume: toFiniteNumberOrNull(stats.volume),
              pnlValue: mid - entry,
              pnlPct: entry ? ((mid - entry) / entry) * 100 : 0,
            });
            await sendTelegramPhoto({
              caption: reachedFiftyNow ? stepText : '✨ تحديث العقد ✨',
              imageBuffer: cardBuffer,
              chatId: TELEGRAM_CHAT_ID_TRADES,
              token: TELEGRAM_BOT_TOKEN_TRADES,
            });
            stepAlertSent = true;
          } catch (photoErr) {
            console.error('Telegram image send failed (watcher):', photoErr.message);
            await sendTelegramMessage(stepText, {
              chatId: TELEGRAM_CHAT_ID_TRADES,
              token: TELEGRAM_BOT_TOKEN_TRADES,
            });
            stepAlertSent = true;
          }
        } else {
          await sendTelegramMessage(stepText, {
            chatId: TELEGRAM_CHAT_ID_TRADES,
            token: TELEGRAM_BOT_TOKEN_TRADES,
          });
          stepAlertSent = true;
        }
      } catch (err) {
        console.error('Telegram send failed (step update):', err.message);
      }
    }

    if (shouldSendProfit50Alert) {
      try {
        // If 50$ is reached now, milestone text is already included in step alert caption.
        if (!(reachedFiftyNow && stepAlertSent)) {
          await sendTelegramMessage(milestoneText, {
            chatId: TELEGRAM_CHAT_ID_TRADES,
            token: TELEGRAM_BOT_TOKEN_TRADES,
          });
        }
        updates.milestone50SentAt = getServerTimestamp();
      } catch (err) {
        console.error('Telegram send failed (50$ milestone):', err.message);
      }
    }

    // Auto upsert ad continuously after trade reaches 50$ while still open.
    if (shouldCreateAutoAd) {
      const adId = `auto-${doc.id}`;
      const nowTs = getServerTimestamp();
      const adRef = db.collection('ads').doc(adId);
      try {
        const adSnap = await adRef.get();
        const previous = adSnap.exists ? adSnap.data() || {} : {};
        const adClosePrice = Number.isFinite(currentHighPrice) ? currentHighPrice : mid;
        const adPnlAmount =
          Number.isFinite(entry) && Number.isFinite(adClosePrice)
            ? (adClosePrice - entry) * 100 * contracts
            : null;
        const adPnlPercent =
          Number.isFinite(entry) && Number.isFinite(adClosePrice) && entry !== 0
            ? ((adClosePrice - entry) / entry) * 100
            : null;

        await adRef.set(
          {
            tradeId: doc.id,
            title: buildAutoAdTitle({ symbol, right, strike }),
            status: previous.status || 'ready',
            symbol,
            right,
            strike,
            expiration,
            entryPrice: Number.isFinite(entry) ? Number(entry.toFixed(2)) : null,
            closePrice: Number.isFinite(adClosePrice) ? Number(adClosePrice.toFixed(2)) : null,
            highPrice: Number.isFinite(currentHighPrice) ? Number(currentHighPrice.toFixed(2)) : null,
            pnlAmount: Number.isFinite(adPnlAmount) ? Number(adPnlAmount.toFixed(2)) : null,
            pnlPercent: Number.isFinite(adPnlPercent) ? Number(adPnlPercent.toFixed(2)) : null,
            isSuccessful: true,
            hasReachedProfit50: true,
            openInterest: toFiniteNumberOrNull(stats.openInterest),
            volume: toFiniteNumberOrNull(stats.volume),
            autoGenerated: true,
            source: 'AUTO_PROFIT_50_USD',
            createdAt: previous.createdAt || nowTs,
            updatedAt: nowTs,
          },
          { merge: true }
        );
        if (!data.autoAdCreatedAt) updates.autoAdCreatedAt = nowTs;
        updates.autoAdId = adId;
      } catch (err) {
        console.error(`Auto ad create failed for trade ${doc.id}:`, err.message);
      }
    }

    await doc.ref.set(updates, { merge: true });
  } catch (err) {
    if (isThetaSessionInvalid(err)) {
      markThetaUnavailable(`Price watcher paused: Theta session is invalid (${err.message}).`);
      return;
    }
    const msg = err?.message || '';
    if (msg.includes('No data found')) {
      // Mark invalid contract and stop processing.
      await doc.ref.set(
        {
          lastError: 'NO_DATA',
          status: 'INVALID',
          updatedAt: getServerTimestamp(),
        },
        { merge: true }
      );
      console.warn(`Marked INVALID (no data) for ${symbol} ${right} ${strike} exp ${expiration}`);
      return;
    }
    console.error(`Watcher error for ${symbol} ${right} ${strike} exp ${expiration}:`, msg);
  }
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const snap = await db.collection('trades').where('status', '==', 'OPEN').limit(MAX_TRADES).get();
    const docs = snap.docs;
    if (!docs.length) return;

    const ready = await ensureThetaReady();
    if (!ready) return;

    await Promise.all(docs.map(processTrade));
  } catch (err) {
    console.error('Price watcher tick failed:', err.message);
  } finally {
    tickRunning = false;
  }
}


function startWatcher() {
  if (!enabled) {
    console.log('Price watcher disabled by ENABLE_WATCHER flag.');
    return;
  }
  if (timer || preflightTimer) return;

  // Start a preflight checker that waits for Theta to become ready.
  // Once ready, clear the preflight and start the main watcher interval.
  preflightTimer = setInterval(async () => {
    try {
      const ready = await ensureThetaReady();
      if (ready) {
        clearInterval(preflightTimer);
        preflightTimer = null;
        if (!timer) {
          timer = setInterval(tick, intervalMs);
          tick();
          console.log(`Price watcher started. Interval: ${intervalMs}ms, step: ${alertStep}`);
        }
      } else {
        console.log('Price watcher preflight: Theta not ready, retrying...');
      }
    } catch (err) {
      console.error('Price watcher preflight error:', err.message || err);
    }
  }, THETA_PREFLIGHT_INTERVAL_MS);
  // Run an immediate preflight check without waiting for the first interval tick.
  (async () => {
    try {
      const ready = await ensureThetaReady();
      if (ready) {
        if (preflightTimer) {
          clearInterval(preflightTimer);
          preflightTimer = null;
        }
        if (!timer) {
          timer = setInterval(tick, intervalMs);
          tick();
          console.log(`Price watcher started. Interval: ${intervalMs}ms, step: ${alertStep}`);
        }
      }
    } catch (err) {
      console.error('Price watcher initial preflight error:', err.message || err);
    }
  })();
}

module.exports = { startWatcher };

const { db, admin } = require('../database');
const { requireFields } = require('../utils/validators');
const { renderTradeCardPNG } = require('../services/cardRenderer');
const { sendTelegramPhoto, sendTelegramMessage } = require('../services/telegramService');
const { getOptionContractStats } = require('../services/thetaClient');
const TELEGRAM_CHAT_ID_ADS = process.env.TELEGRAM_CHAT_ID_ADS || process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_BOT_TOKEN_ADS = process.env.TELEGRAM_BOT_TOKEN_ADS || process.env.TELEGRAM_BOT_TOKEN;
const MIN_AD_PROFIT_USD = 50;

const adsCol = db.collection('ads');
const tradesCol = db.collection('trades');
const reportsCol = db.collection('reports');

// Helper function to get server timestamp (works with both Firestore and local DB)
function getServerTimestamp() {
  if (admin && admin.firestore) {
    return admin.firestore.FieldValue.serverTimestamp();
  }
  // For local DB, return current timestamp
  return new Date().toISOString();
}

function toFiniteNumberOrNull(value) {
  const num = Number(value);

  return Number.isFinite(num) ? num : null;
}

function meetsMinAdProfitUsd(ad) {
  return Number(ad?.pnlAmount) >= MIN_AD_PROFIT_USD;
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

function hydrateTradeFromReport(trade = {}, report = null) {
  if (!report) return { ...trade };

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

async function getLatestReportByTradeId(tradeId) {
  const snap = await reportsCol.where('tradeId', '==', tradeId).get();
  if (!snap.size) return null;

  const best = snap.docs.reduce((acc, doc) => {
    const data = doc.data() || {};
    if (!acc) return data;
    return toMillis(data.closedAt) > toMillis(acc.closedAt) ? data : acc;
  }, null);
  return best || null;
}

function buildAdPayloadFromTrade({ tradeId, trade, title, openInterest, volume }) {
  return {
    tradeId,
    title: title || `${trade.symbol} ${String(trade.right).toUpperCase()} ${trade.strike}`,
    status: 'ready',
    symbol: trade.symbol,
    right: trade.right,
    strike: trade.strike,
    expiration: trade.expiration,
    entryPrice: trade.entryPrice ?? null,
    closePrice: trade.closePrice ?? trade.lastMidPrice ?? null,
    pnlAmount: trade.pnl ?? null,
    pnlPercent: trade.pnlPercent ?? null,
    isSuccessful: Boolean(trade.isSuccessful),
    openInterest: openInterest ?? null,
    volume: volume ?? null,
    createdAt: getServerTimestamp(),
    updatedAt: getServerTimestamp(),
  };
}

async function buildWinningAdFromTrade({ tradeId, title }) {
  const tradeDoc = await tradesCol.doc(tradeId).get();
  const report = await getLatestReportByTradeId(tradeId);
  if (!tradeDoc.exists && !report) return { notFound: true };

  const trade = hydrateTradeFromReport(tradeDoc.exists ? tradeDoc.data() : {}, report);
  const qualifiesAsSuccess = Boolean(trade.isSuccessful) || Number(trade.pnl || 0) > 0;
  if (!qualifiesAsSuccess) return { notWinning: true };
  const pnlAmount = Number(trade.pnl);
  if (!Number.isFinite(pnlAmount) || pnlAmount < MIN_AD_PROFIT_USD) {
    return { belowMinProfitUsd: true };
  }
  
  // Validate symbol
  const symbol = String(trade.symbol || '').trim().toUpperCase();
  if (!symbol || !/^[A-Z0-9]{1,10}(?:[.\-][A-Z0-9]{1,4})?$/.test(symbol)) {
    return { invalidSymbol: true, message: 'رمز السهم غير صالح للإرسال إلى تيليجرام' };
  }
  
  // Validate strike
  if (!Number.isFinite(trade.strike) || trade.strike <= 0) {
    return { invalidStrike: true, message: 'سعر التمرين (السترايك) غير صالح' };
  }

  if (tradeDoc.exists && report) {
    const patch = {};
    if (!tradeDoc.data().symbol && trade.symbol) patch.symbol = trade.symbol;
    if (!tradeDoc.data().right && trade.right) patch.right = trade.right;
    if ((tradeDoc.data().strike === undefined || tradeDoc.data().strike === null) && trade.strike !== undefined) {
      patch.strike = trade.strike;
    }
    if (!tradeDoc.data().expiration && trade.expiration) patch.expiration = trade.expiration;
    if (!Number.isFinite(Number(tradeDoc.data().entryPrice)) && Number.isFinite(Number(trade.entryPrice))) {
      patch.entryPrice = trade.entryPrice;
    }
    if (!Number.isFinite(Number(tradeDoc.data().closePrice)) && Number.isFinite(Number(trade.closePrice))) {
      patch.closePrice = trade.closePrice;
    }
    if (!Number.isFinite(Number(tradeDoc.data().pnl)) && Number.isFinite(Number(trade.pnl))) {
      patch.pnl = trade.pnl;
    }
    if (!Number.isFinite(Number(tradeDoc.data().pnlPercent)) && Number.isFinite(Number(trade.pnlPercent))) {
      patch.pnlPercent = trade.pnlPercent;
    }
    if (Object.keys(patch).length) {
      patch.updatedAt = getServerTimestamp();
      await tradesCol.doc(tradeId).set(patch, { merge: true });
    }
  }
  let openInterest = toFiniteNumberOrNull(trade.openInterest);
  let volume = toFiniteNumberOrNull(trade.volume);
  const contractKey = `${trade.symbol}-${trade.expiration}-${trade.right}-${trade.strike}`;

  if ((openInterest === null || openInterest <= 0) || (volume === null || volume <= 0)) {
    try {
      const stats = await getOptionContractStats({
        symbol: String(trade.symbol || '').toUpperCase(),
        expiration: trade.expiration,
        right: trade.right,
        strike: trade.strike,
      });
      openInterest = toFiniteNumberOrNull(stats?.openInterest);
      volume = toFiniteNumberOrNull(stats?.volume);
      await tradesCol.doc(tradeId).set(
        {
          openInterest,
          volume,
          statsUpdatedAt: getServerTimestamp(),
          updatedAt: getServerTimestamp(),
        },
        { merge: true }
      );
    } catch (err) {
      console.warn(`ad stats fetch failed ${contractKey}: ${err.message}`);
      openInterest = null;
      volume = null;
    }
  }

  console.log(
    `ad stats ${contractKey} | openInterest=${openInterest ?? 'null'} | volume=${volume ?? 'null'}`
  );

  return {
    adPayload: buildAdPayloadFromTrade({ tradeId, trade, title, openInterest, volume }),
  };
}

async function sendAdCardToTelegram(ad) {
  const textFallback =
    `🏆 صفقة ناجحة\n` +
    `الرمز: ${ad.symbol}\n` +
    `النوع: ${String(ad.right || '').toUpperCase()}\n` +
    `السترايك: ${ad.strike}\n` +
    `التاريخ: ${ad.expiration}\n` +
    `الدخول: ${ad.entryPrice ?? 'n/a'}\n` +
    `الإغلاق: ${ad.closePrice ?? 'n/a'}\n` +
    `النتيجة: ${ad.pnlAmount ?? 'n/a'} (${ad.pnlPercent ?? 'n/a'}%)`;

  try {
    const card = await renderTradeCardPNG({
      symbol: ad.symbol,
      strike: ad.strike,
      expiration: ad.expiration,
      right: ad.right,
      entryPrice: toFiniteNumberOrNull(ad.entryPrice) ?? 0,
      mid: toFiniteNumberOrNull(ad.closePrice ?? ad.entryPrice) ?? 0,
      openInterest: toFiniteNumberOrNull(ad.openInterest),
      volume: toFiniteNumberOrNull(ad.volume),
      pnlValue: Number.isFinite(Number(ad.pnlAmount)) ? Number(ad.pnlAmount) : 0,
      pnlPct: Number.isFinite(Number(ad.pnlPercent)) ? Number(ad.pnlPercent) : 0,
      variant: 'winning-ad',
    });

    await sendTelegramPhoto({
      caption: null,
      imageBuffer: card,
      chatId: TELEGRAM_CHAT_ID_ADS,
      token: TELEGRAM_BOT_TOKEN_ADS,
    });
  } catch (photoErr) {
    console.error('Telegram image send failed (ads):', photoErr.message);
    await sendTelegramMessage(textFallback, {
      chatId: TELEGRAM_CHAT_ID_ADS,
      token: TELEGRAM_BOT_TOKEN_ADS,
    });
  }
}

function queueAdSend({ adId, adPayload }) {
  // Fire-and-forget: do not block HTTP response on Telegram latency.
  (async () => {
    try {
      await sendAdCardToTelegram(adPayload);
      await adsCol.doc(adId).set(
        {
          status: 'sent',
          lastSentAt: getServerTimestamp(),
          updatedAt: getServerTimestamp(),
        },
        { merge: true }
      );
    } catch (err) {
      console.error(`queued ad send failed (${adId}):`, err.message);
      await adsCol.doc(adId).set(
        {
          status: 'failed',
          sendError: String(err.message || 'unknown error'),
          updatedAt: getServerTimestamp(),
        },
        { merge: true }
      );
    }
  })();
}

async function createAd(req, res, next) {
  try {
    requireFields(req.body, ['title', 'content']);
    const payload = {
      title: req.body.title,
      content: req.body.content,
      status: req.body.status || 'draft',
      createdAt: getServerTimestamp(),
      updatedAt: getServerTimestamp(),
    };
    const docRef = await adsCol.add(payload);
    const snap = await docRef.get();
    res.status(201).json({ id: docRef.id, ...snap.data() });
  } catch (err) {
    next(err);
  }
}

async function listAds(req, res, next) {
  try {
    const snap = await adsCol.orderBy('createdAt', 'desc').get();
    const ads = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((ad) => meetsMinAdProfitUsd(ad));
    res.json(ads);
  } catch (err) {
    next(err);
  }
}

async function getAd(req, res, next) {
  try {
    const doc = await adsCol.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ message: 'Ad not found' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    next(err);
  }
}

async function updateAd(req, res, next) {
  try {
    const updates = { ...req.body, updatedAt: getServerTimestamp() };
    const ref = adsCol.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ message: 'Ad not found' });
    await ref.set(updates, { merge: true });
    const updated = await ref.get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (err) {
    next(err);
  }
}

async function deleteAd(req, res, next) {
  try {
    const ref = adsCol.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ message: 'Ad not found' });
    await ref.delete();
    res.json({ message: 'Deleted' });
  } catch (err) {
    next(err);
  }
}

async function deleteAllAds(req, res, next) {
  try {
    const snap = await adsCol.get();
    if (!snap.size) {
      return res.json({ message: 'No ads to delete', deletedCount: 0 });
    }

    await Promise.all(snap.docs.map((doc) => adsCol.doc(doc.id).delete()));
    return res.json({ message: 'All ads deleted', deletedCount: snap.size });
  } catch (err) {
    next(err);
  }
}

async function createAdFromTrade(req, res, next) {
  try {
    requireFields(req.body, ['tradeId']);
    const { tradeId } = req.body;
    const result = await buildWinningAdFromTrade({ tradeId, title: req.body.title });
    if (result.notFound) {
      return res.status(404).json({ message: 'Trade not found' });
    }
    if (result.notWinning) {
      return res.status(400).json({ message: 'Trade is not successful yet' });
    }
    if (result.belowMinProfitUsd) {
      return res.status(400).json({ message: 'Trade profit amount must be 50$ or higher' });
    }
    if (result.invalidSymbol) {
      return res.status(400).json({ message: result.message });
    }
    if (result.invalidStrike) {
      return res.status(400).json({ message: result.message });
    }
    const docRef = await adsCol.add(result.adPayload);
    const snap = await docRef.get();
    res.status(201).json({ id: docRef.id, ...snap.data() });
  } catch (err) {
    next(err);
  }
}

async function sendAdFromTrade(req, res, next) {
  try {
    requireFields(req.body, ['tradeId']);
    const { tradeId } = req.body;
    const result = await buildWinningAdFromTrade({ tradeId, title: req.body.title });
    if (result.notFound) {
      return res.status(404).json({ message: 'Trade not found' });
    }
    if (result.notWinning) {
      return res.status(400).json({ message: 'Trade is not successful yet' });
    }
    if (result.belowMinProfitUsd) {
      return res.status(400).json({ message: 'Trade profit amount must be 50$ or higher' });
    }
    if (result.invalidSymbol) {
      return res.status(400).json({ message: result.message });
    }
    if (result.invalidStrike) {
      return res.status(400).json({ message: result.message });
    }

    const payload = {
      ...result.adPayload,
      status: 'sending',
    };
    const docRef = await adsCol.add(payload);
    const snap = await docRef.get();
    queueAdSend({ adId: docRef.id, adPayload: payload });
    res.status(202).json({ success: true, queued: true, ad: { id: docRef.id, ...snap.data() } });
  } catch (err) {
    console.error('sendAdFromTrade failed:', err.message);
    next(err);
  }
}

async function sendAdToTelegram(req, res, next) {
  try {
    const { id } = req.params;
    const adDoc = await adsCol.doc(id).get();
    if (!adDoc.exists) return res.status(404).json({ message: 'Ad not found' });
    const ad = adDoc.data();
    if (!meetsMinAdProfitUsd(ad)) {
      return res.status(400).json({ message: 'Ad profit amount must be 50$ or higher' });
    }
    let adForSend = { ...ad };

    if (
      (toFiniteNumberOrNull(ad.openInterest) === null || toFiniteNumberOrNull(ad.openInterest) <= 0) ||
      (toFiniteNumberOrNull(ad.volume) === null || toFiniteNumberOrNull(ad.volume) <= 0)
    ) {
      const contractKey = `${ad.symbol}-${ad.expiration}-${ad.right}-${ad.strike}`;
      try {
        const stats = await getOptionContractStats({
          symbol: String(ad.symbol || '').toUpperCase(),
          expiration: ad.expiration,
          right: ad.right,
          strike: ad.strike,
        });
        const openInterest = toFiniteNumberOrNull(stats?.openInterest);
        const volume = toFiniteNumberOrNull(stats?.volume);
        adForSend = { ...adForSend, openInterest, volume };
        await adsCol.doc(id).set(
          {
            openInterest,
            volume,
            statsUpdatedAt: getServerTimestamp(),
            updatedAt: getServerTimestamp(),
          },
          { merge: true }
        );
        console.log(
          `ad send stats ${contractKey} | openInterest=${openInterest ?? 'null'} | volume=${volume ?? 'null'}`
        );
      } catch (err) {
        console.warn(`ad send stats fetch failed ${contractKey}: ${err.message}`);
      }
    }

    await adsCol.doc(id).set({ status: 'sending', updatedAt: getServerTimestamp() }, { merge: true });
    queueAdSend({ adId: id, adPayload: adForSend });
    res.status(202).json({ success: true, queued: true });
  } catch (err) {
    console.error('sendAdToTelegram failed:', err.message);
    next(err);
  }
}

module.exports = {
  createAd,
  listAds,
  getAd,
  updateAd,
  deleteAd,
  deleteAllAds,
  createAdFromTrade,
  sendAdFromTrade,
  sendAdToTelegram,
};

const { db, admin } = require('../database');

const enabled = String(process.env.ENABLE_ADS_CLEANUP || 'true').toLowerCase() === 'true';
const intervalMs = Number(process.env.ADS_CLEANUP_INTERVAL_MS || 24 * 60 * 60 * 1000);

let timer = null;
let running = false;

function getServerTimestamp() {
  if (admin && admin.firestore) {
    return admin.firestore.FieldValue.serverTimestamp();
  }
  return new Date().toISOString();
}

async function suppressAutoAdForTradeIds(tradeIds = []) {
  const tradesCol = db.collection('trades');
  const uniqueIds = Array.from(
    new Set(
      tradeIds
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    )
  );
  if (!uniqueIds.length) return;
  const ts = getServerTimestamp();
  await Promise.all(
    uniqueIds.map((tradeId) =>
      tradesCol.doc(tradeId).set(
        {
          autoAdSuppressedAt: ts,
          autoAdCreatedAt: ts,
          autoAdDeletedAt: ts,
          updatedAt: ts,
        },
        { merge: true }
      )
    )
  );
}

async function cleanupAdsTick() {
  if (running) return;
  running = true;
  try {
    const adsCol = db.collection('ads');
    const snap = await adsCol.get();
    if (!snap.size) {
      console.log('Ads cleanup: no ads to delete');
      return;
    }

    const tradeIds = snap.docs.map((doc) => (doc.data() || {}).tradeId);
    await Promise.all(snap.docs.map((doc) => adsCol.doc(doc.id).delete()));
    await suppressAutoAdForTradeIds(tradeIds);
    console.log(`Ads cleanup: deleted ${snap.size} ads`);
  } catch (err) {
    console.error('Ads cleanup failed:', err.message);
  } finally {
    running = false;
  }
}

function startAdsCleanup() {
  if (!enabled) {
    console.log('Ads cleanup disabled by ENABLE_ADS_CLEANUP flag.');
    return;
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    console.log('Ads cleanup disabled due to invalid ADS_CLEANUP_INTERVAL_MS value.');
    return;
  }
  if (timer) return;
  timer = setInterval(cleanupAdsTick, intervalMs);
  console.log(`Ads cleanup started. Interval: ${intervalMs}ms`);
}

module.exports = { startAdsCleanup };

const { db } = require('../database');

const enabled = String(process.env.ENABLE_ADS_CLEANUP || 'true').toLowerCase() === 'true';
const intervalMs = Number(process.env.ADS_CLEANUP_INTERVAL_MS || 60 * 60 * 1000);
const retentionMs = Number(process.env.ADS_RETENTION_MS || 24 * 60 * 60 * 1000);

let timer = null;
let running = false;

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

    const now = Date.now();
    const idsToDelete = snap.docs
      .filter((doc) => {
        const ad = doc.data() || {};
        const createdMs = toMillis(ad.createdAt) || toMillis(ad.updatedAt);
        if (!Number.isFinite(createdMs) || createdMs <= 0) return false;
        return (now - createdMs) >= retentionMs;
      })
      .map((doc) => doc.id);

    if (!idsToDelete.length) {
      console.log('Ads cleanup: no expired ads');
      return;
    }

    await Promise.all(idsToDelete.map((id) => adsCol.doc(id).delete()));
    console.log(`Ads cleanup: deleted ${idsToDelete.length} expired ads`);
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
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
    console.log('Ads cleanup disabled due to invalid ADS_RETENTION_MS value.');
    return;
  }
  if (timer) return;
  timer = setInterval(cleanupAdsTick, intervalMs);
  console.log(`Ads cleanup started. Interval: ${intervalMs}ms | retention: ${retentionMs}ms`);
}

module.exports = { startAdsCleanup };

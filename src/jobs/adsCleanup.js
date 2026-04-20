const { db } = require('../database');

const enabled = String(process.env.ENABLE_ADS_CLEANUP || 'true').toLowerCase() === 'true';
const cleanupHour = Number(process.env.ADS_CLEANUP_HOUR ?? 1);
const cleanupMinute = Number(process.env.ADS_CLEANUP_MINUTE ?? 0);

let timer = null;
let running = false;

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

    const idsToDelete = snap.docs.map((doc) => doc.id);

    await Promise.all(idsToDelete.map((id) => adsCol.doc(id).delete()));
    console.log(`Ads cleanup: deleted ${idsToDelete.length} ads`);
  } catch (err) {
    console.error('Ads cleanup failed:', err.message);
  } finally {
    running = false;
  }
}

function getMsUntilNextRun(hour, minute) {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(hour, minute, 0, 0);
  if (nextRun.getTime() <= now.getTime()) {
    nextRun.setDate(nextRun.getDate() + 1);
  }
  return nextRun.getTime() - now.getTime();
}

function scheduleNextCleanupRun() {
  const delayMs = getMsUntilNextRun(cleanupHour, cleanupMinute);
  timer = setTimeout(async () => {
    await cleanupAdsTick();
    scheduleNextCleanupRun();
  }, delayMs);
}

function startAdsCleanup() {
  if (!enabled) {
    console.log('Ads cleanup disabled by ENABLE_ADS_CLEANUP flag.');
    return;
  }
  if (!Number.isInteger(cleanupHour) || cleanupHour < 0 || cleanupHour > 23) {
    console.log('Ads cleanup disabled due to invalid ADS_CLEANUP_HOUR value.');
    return;
  }
  if (!Number.isInteger(cleanupMinute) || cleanupMinute < 0 || cleanupMinute > 59) {
    console.log('Ads cleanup disabled due to invalid ADS_CLEANUP_MINUTE value.');
    return;
  }
  if (timer) return;
  scheduleNextCleanupRun();
  console.log(`Ads cleanup started. Daily full cleanup at ${String(cleanupHour).padStart(2, '0')}:${String(cleanupMinute).padStart(2, '0')}`);
}

module.exports = { startAdsCleanup };

const { db } = require('../database');

const enabled = String(process.env.ENABLE_ADS_CLEANUP || 'true').toLowerCase() === 'true';
const cleanupHour = Number(process.env.ADS_CLEANUP_HOUR || 1);
const cleanupMinute = Number(process.env.ADS_CLEANUP_MINUTE || 0);

let timer = null;
let running = false;

function getNextCleanupDelayMs(now = new Date()) {
  const nextRun = new Date(now);
  nextRun.setHours(cleanupHour, cleanupMinute, 0, 0);
  if (nextRun <= now) {
    nextRun.setDate(nextRun.getDate() + 1);
  }
  return nextRun.getTime() - now.getTime();
}

function scheduleNextCleanup() {
  const delayMs = getNextCleanupDelayMs();
  timer = setTimeout(async () => {
    await cleanupAdsTick();
    scheduleNextCleanup();
  }, delayMs);
  const nextRun = new Date(Date.now() + delayMs);
  console.log(`Ads cleanup scheduled for ${nextRun.toLocaleString()}`);
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

    await Promise.all(snap.docs.map((doc) => adsCol.doc(doc.id).delete()));
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
  if (
    !Number.isInteger(cleanupHour) ||
    cleanupHour < 0 ||
    cleanupHour > 23 ||
    !Number.isInteger(cleanupMinute) ||
    cleanupMinute < 0 ||
    cleanupMinute > 59
  ) {
    console.log('Ads cleanup disabled due to invalid ADS_CLEANUP_HOUR or ADS_CLEANUP_MINUTE value.');
    return;
  }
  if (timer) return;
  scheduleNextCleanup();
  console.log(
    `Ads cleanup started. Daily delete time: ${String(cleanupHour).padStart(2, '0')}:${String(
      cleanupMinute
    ).padStart(2, '0')}`
  );
}

module.exports = { startAdsCleanup };

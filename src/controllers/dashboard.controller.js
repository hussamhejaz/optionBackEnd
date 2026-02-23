const { db, admin } = require('../database');

const tradesCol = db.collection('trades');
const reportsCol = db.collection('reports');
const OPTION_MULTIPLIER = 100;

function toFiniteNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeReportMetrics(report = {}) {
  const entry = toFiniteNumberOrNull(report.entryPrice);
  const close = toFiniteNumberOrNull(report.closePrice);
  const high = toFiniteNumberOrNull(report.highPrice);
  const contractsRaw = Number(report.contracts);
  const contracts = Number.isFinite(contractsRaw) && contractsRaw > 0 ? contractsRaw : 1;
  const peakPnlAmount =
    Number.isFinite(entry) && Number.isFinite(high)
      ? (high - entry) * OPTION_MULTIPLIER * contracts
      : null;

  const useHighPriceForReport =
    (Boolean(report.hasReachedProfit50) ||
      (Number.isFinite(peakPnlAmount) && peakPnlAmount >= 50)) &&
    Number.isFinite(entry) &&
    Number.isFinite(high) &&
    high > entry;
  const effectiveClose = useHighPriceForReport ? high : close;
  const effectivePnlAmount =
    Number.isFinite(entry) && Number.isFinite(effectiveClose)
      ? Number(((effectiveClose - entry) * OPTION_MULTIPLIER * contracts).toFixed(2))
      : Number.isFinite(Number(report.pnlAmount))
        ? Number(report.pnlAmount)
        : 0;
  const effectivePnlPercent =
    Number.isFinite(entry) && Number.isFinite(effectiveClose) && entry !== 0
      ? Number((((effectiveClose - entry) / entry) * 100).toFixed(2))
      : Number.isFinite(Number(report.pnlPercent))
        ? Number(report.pnlPercent)
        : 0;
  const effectiveSuccess =
    Boolean(report.hasReachedProfit50) ||
    report.successRule === 'PROFIT_TARGET_50_REACHED' ||
    (Number.isFinite(peakPnlAmount) && peakPnlAmount >= 50);

  return {
    pnlAmount: effectivePnlAmount,
    pnlPercent: effectivePnlPercent,
    isSuccessful: effectiveSuccess,
  };
}

// Helper function to create timestamp from date (works with both Firestore and local DB)
function createTimestampFromDate(date) {
  if (admin && admin.firestore) {
    return admin.firestore.Timestamp.fromDate(date);
  }
  // For local DB, return a simple timestamp object
  return {
    toDate: () => date,
    toMillis: () => date.getTime(),
    seconds: Math.floor(date.getTime() / 1000),
    nanoseconds: 0
  };
}

function startOfDayUTC(date) {
  return createTimestampFromDate(
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  );
}

async function dashboardSummary(req, res, next) {
  try {
    // Open / closed counts
    const [openSnap, closedSnap] = await Promise.all([
      tradesCol.where('status', '==', 'OPEN').get(),
      tradesCol.where('status', '==', 'CLOSED').get(),
    ]);

    const openCount = openSnap.size;
    const closedCount = closedSnap.size;

    // P&L + win/loss from reports (closed trades)
    const reports = await reportsCol.get();
    let netProfit = 0;
    let wins = 0;
    let losses = 0;
    let winRateSumPercent = 0;
    reports.forEach((doc) => {
      const d = doc.data();
      const normalized = normalizeReportMetrics(d);
      const pnl = normalized.pnlAmount;
      netProfit += pnl;
      // Prefer explicit success flag from report (new logic),
      // fall back to pnl sign for older records.
      if (normalized.isSuccessful !== undefined) {
        if (Boolean(normalized.isSuccessful)) {
          wins += 1;
          winRateSumPercent += Number(normalized.pnlPercent) || 0;
        }
        else losses += 1;
      } else if (pnl > 0) {
        wins += 1;
      } else if (pnl < 0) {
        losses += 1;
      }
    });
    const totalClosed = wins + losses;
    // User-defined metric: sum of winning rise percentages (can exceed 100%).
    const winRate = Number(winRateSumPercent.toFixed(2));

    // Weekly profit trend (last 7 days, inclusive)
    const now = new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(now.getUTCDate() - i);
      const dayStart = startOfDayUTC(d);
      const dayEnd = startOfDayUTC(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)));
      days.push({ label: d.toLocaleDateString('en-US', { weekday: 'short' }), start: dayStart, end: dayEnd });
    }

    const weeklyBuckets = days.map((d) => ({ label: d.label, value: 0 }));
    const reportDocs = reports.docs;
    reportDocs.forEach((doc) => {
      const data = doc.data();
      const normalized = normalizeReportMetrics(data);
      const ts = data.closedAt;
      if (!ts?.toDate) return;
      const date = ts.toDate();
      const utc = date.getTime();
      weeklyBuckets.forEach((bucket, idx) => {
        const { start, end } = days[idx];
        if (utc >= start.toMillis() && utc < end.toMillis()) {
          bucket.value += normalized.pnlAmount;
        }
      });
    });

    res.json({
      netProfit,
      winRate,
      openCount,
      closedCount,
      winCount: wins,
      lossCount: losses,
      weeklyProfit: weeklyBuckets,
    });
  } catch (err) {
    next(err);
  }
}

// Placeholder reset endpoint (no-op, kept for future cache invalidation)
async function resetDashboard(req, res, next) {
  try {
    res.json({ success: true, message: 'Dashboard reset (no cached state to clear).' });
  } catch (err) {
    next(err);
  }
}

module.exports = { dashboardSummary, resetDashboard };

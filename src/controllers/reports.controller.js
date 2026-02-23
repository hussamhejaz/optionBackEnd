const { db } = require('../database');

const reportsCollection = db.collection('reports');
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
      : toFiniteNumberOrNull(report.pnlPercent);
  const isWinOver50 =
    Boolean(report.hasReachedProfit50) ||
    report.successRule === 'PROFIT_TARGET_50_REACHED' ||
    effectivePnlAmount >= 50;

  return {
    ...report,
    closePrice: Number.isFinite(effectiveClose) ? effectiveClose : report.closePrice,
    pnlAmount: effectivePnlAmount,
    pnlPercent: Number.isFinite(effectivePnlPercent) ? effectivePnlPercent : report.pnlPercent,
    isSuccessful:
      report.isSuccessful !== undefined
        ? Boolean(report.isSuccessful)
        : effectivePnlAmount > 0,
    usedHighPriceForReport: Boolean(report.usedHighPriceForReport) || useHighPriceForReport,
    isWinOver50,
  };
}

function periodsFromDate(date) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');

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

async function reportForField(field, value) {
  const snap = await reportsCollection.where(field, '==', value).get();
  const reports = snap.docs.map((d) => normalizeReportMetrics({ id: d.id, ...d.data() }));
  const totalPnL = reports.reduce((sum, r) => sum + Number(r.pnlAmount || 0), 0);
  const tradeCount = reports.length;
  const winCount = reports.filter((r) => Boolean(r.isWinOver50)).length;
  // User-defined metric: net percent = winners% - losers%.
  const winRate = Number(
    reports
      .reduce((sum, r) => sum + (Number(r.pnlPercent) || 0), 0)
      .toFixed(2)
  );
  return { totalPnL, reports, tradeCount, winCount, winRate };
}

async function dailyReport(req, res, next) {
  try {
    const target = req.query.date ? new Date(req.query.date) : new Date();
    const { daily } = periodsFromDate(target);
    const result = await reportForField('periodDaily', daily);
    res.json({ period: daily, ...result });
  } catch (err) {
    next(err);
  }
}

async function weeklyReport(req, res, next) {
  try {
    const target = req.query.date ? new Date(req.query.date) : new Date();
    const { weekly } = periodsFromDate(target);
    const result = await reportForField('periodWeekly', weekly);
    res.json({ period: weekly, ...result });
  } catch (err) {
    next(err);
  }
}

async function monthlyReport(req, res, next) {
  try {
    const target = req.query.date ? new Date(req.query.date) : new Date();
    const { monthly } = periodsFromDate(target);
    const result = await reportForField('periodMonthly', monthly);
    res.json({ period: monthly, ...result });
  } catch (err) {
    next(err);
  }
}

async function deleteReport(req, res, next) {
  try {
    const { id } = req.params;
    const ref = reportsCollection.doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ message: 'Report not found' });
    await ref.delete();
    return res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports = { dailyReport, weeklyReport, monthlyReport, deleteReport };

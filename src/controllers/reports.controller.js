const { db } = require('../database');

const reportsCollection = db.collection('reports');

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
  const reports = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const totalPnL = reports.reduce((sum, r) => sum + Number(r.pnlAmount || 0), 0);
  return { totalPnL, reports };
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

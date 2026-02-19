require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { db, admin } = require('./database');

const tradesRoutes = require('./routes/trades.routes');
const settingsRoutes = require('./routes/settings.routes');
const telegramRoutes = require('./routes/telegram.routes');
const thetaRoutes = require('./routes/theta.routes');
const adsRoutes = require('./routes/ads.routes');
const reportsRoutes = require('./routes/reports.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const FIRESTORE_TEST_TIMEOUT_MS = Number(process.env.FIRESTORE_TEST_TIMEOUT_MS || 10000);
const GOOGLEAPIS_PING_TIMEOUT_MS = Number(process.env.GOOGLEAPIS_PING_TIMEOUT_MS || 5000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 70000);
const FIRESTORE_REST_TIMEOUT_MS = Number(process.env.FIRESTORE_REST_TIMEOUT_MS || 20000);

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});
app.use((req, res, next) => {
  if (!Number.isFinite(REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS <= 0) return next();
  const timeoutId = setTimeout(() => {
    if (res.headersSent || res.writableEnded) return;
    console.error(
      `REQUEST TIMEOUT: ${req.method} ${req.originalUrl} exceeded ${REQUEST_TIMEOUT_MS}ms`
    );
    res.status(504).json({ message: `Request timed out after ${REQUEST_TIMEOUT_MS}ms` });
  }, REQUEST_TIMEOUT_MS);
  res.on('finish', () => clearTimeout(timeoutId));
  res.on('close', () => clearTimeout(timeoutId));
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/_firestore_test', async (req, res) => {
  const startedAt = Date.now();
  const writePromise = db.collection('_health').doc('ping').set({ ok: true, at: new Date().toISOString() });
  try {
    await Promise.race([
      writePromise,
      new Promise((_, reject) =>
        setTimeout(() => {
          const err = new Error(`firestore test timed out after ${FIRESTORE_TEST_TIMEOUT_MS}ms`);
          err.statusCode = 504;
          reject(err);
        }, FIRESTORE_TEST_TIMEOUT_MS)
      ),
    ]);
    res.json({ ok: true, durationMs: Date.now() - startedAt });
  } catch (e) {
    res
      .status(e.statusCode || 500)
      .json({ ok: false, error: e.message, durationMs: Date.now() - startedAt });
  }
});

app.get('/_firestore_diag', async (req, res) => {
  const startedAt = Date.now();
  const projectId = process.env.FIREBASE_PROJECT_ID || null;

  async function runWithTimeout(label, ms, fn) {
    const t0 = Date.now();
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(() => {
            const err = new Error(`${label} timed out after ${ms}ms`);
            err.statusCode = 504;
            reject(err);
          }, ms)
        ),
      ]);
      return { ok: true, durationMs: Date.now() - t0 };
    } catch (err) {
      return {
        ok: false,
        durationMs: Date.now() - t0,
        error: err?.message || 'unknown error',
        statusCode: err?.statusCode || 500,
      };
    }
  }

  const googleapis = await runWithTimeout('googleapis ping', GOOGLEAPIS_PING_TIMEOUT_MS, async () => {
    // 401/403 is still a successful connectivity signal.
    await fetch('https://firestore.googleapis.com/v1/projects', { timeout: GOOGLEAPIS_PING_TIMEOUT_MS });
  });

  const write = await runWithTimeout('firestore sdk write', FIRESTORE_TEST_TIMEOUT_MS, async () => {
    await db
      .collection('_health')
      .doc(`diag_${Date.now()}`)
      .set({ ok: true, at: new Date().toISOString(), source: '_firestore_diag' });
  });

  const restWrite = await runWithTimeout('firestore rest write', FIRESTORE_REST_TIMEOUT_MS, async () => {
    const credential = admin.app().options.credential;
    if (!credential || typeof credential.getAccessToken !== 'function') {
      throw new Error('firebase credential does not support getAccessToken()');
    }
    const tokenResp = await credential.getAccessToken();
    const accessToken = tokenResp?.access_token;
    if (!accessToken) throw new Error('failed to obtain access token for firestore REST');

    const docId = `rest_diag_${Date.now()}`;
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/_health`;
    const url = `${base}?documentId=${encodeURIComponent(docId)}`;
    const body = {
      fields: {
        ok: { booleanValue: true },
        source: { stringValue: '_firestore_rest_diag' },
        at: { timestampValue: new Date().toISOString() },
      },
    };

    const resp = await fetch(url, {
      method: 'POST',
      timeout: FIRESTORE_REST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      const err = new Error(`firestore REST write failed ${resp.status}: ${txt}`);
      err.statusCode = resp.status;
      throw err;
    }
  });

  const payload = {
    ok: googleapis.ok && write.ok && restWrite.ok,
    projectId,
    totalDurationMs: Date.now() - startedAt,
    tests: {
      googleapis,
      write,
      restWrite,
    },
  };

  res.status(payload.ok ? 200 : 500).json(payload);
});

app.use('/api/trades', tradesRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/theta', thetaRoutes);
app.use('/api/ads', adsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/dashboard', dashboardRoutes);

app.use((err, req, res, next) => {
  console.error('ERROR:', err?.message);
  console.error(err);
  const status = err.statusCode || 500;
  res.status(status).json({ message: err.message || 'Internal Server Error' });
});

module.exports = app;

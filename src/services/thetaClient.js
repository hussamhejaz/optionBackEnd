const fetch = require('node-fetch');
const { URL } = require('node:url');

const RAW_BASE = process.env.THETA_BASE_URL || 'http://127.0.0.1:25503/v3';
// Remove trailing slashes to avoid double //
const BASE = String(RAW_BASE).replace(/\/+$/, '');

const THETA_REQUEST_TIMEOUT_MS = Number(process.env.THETA_REQUEST_TIMEOUT_MS || 10000);

function toFiniteNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function buildParams({ symbol, expiration, right, strike }) {
  return new URLSearchParams({
    symbol,
    expiration,
    right,
    strike: String(strike),
    format: 'json',
  });
}

async function fetchSnapshotRow({ type, symbol, expiration, right, strike }) {
  const params = buildParams({ symbol, expiration, right, strike });

  // NOTE: BASE already includes /v3 (from .env)
  // Example: http://127.0.0.1:25503/v3/option/snapshot/ohlc?...
  const url = `${BASE}/option/snapshot/${type}?${params.toString()}`;

  const res = await fetchTheta(url, `theta ${type}`);
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`theta ${type} failed ${res.status}: ${body}`);
    err.statusCode = res.status;
    err.responseBody = body;
    throw err;
  }
  const json = await res.json();
  return json?.response?.[0]?.data?.[0] || null;
}

async function getFpssStatus() {
  // NOTE: BASE already includes /v3
  const url = `${BASE}/terminal/fpss/status`;

  const res = await fetchTheta(url, 'theta fpss status');
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`theta fpss status failed ${res.status}: ${body}`);
    err.statusCode = res.status;
    err.responseBody = body;
    throw err;
  }
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    return { status: String(body || '').trim() || null };
  }
}

async function getOptionQuote({ symbol, expiration, right, strike }) {
  const params = new URLSearchParams({
    symbol,
    expiration,
    right,
    strike: String(strike),
    format: 'json',
  });

  // NOTE: BASE already includes /v3
  const url = `${BASE}/option/snapshot/quote?${params.toString()}`;

  const res = await fetchTheta(url, 'theta quote');
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`theta quote failed ${res.status}: ${body}`);
    err.statusCode = res.status;
    err.responseBody = body;
    throw err;
  }

  const json = await res.json();
  const row = json?.response?.[0]?.data?.[0];

  const bid = Number(row?.bid);
  const ask = Number(row?.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    throw new Error('theta quote missing bid/ask');
  }

  const mid = Number(((bid + ask) / 2).toFixed(2));
  const openInterest = toFiniteNumberOrNull(row?.open_interest);
  const volume = toFiniteNumberOrNull(row?.volume);
  return { bid, ask, mid, openInterest, volume };
}

async function fetchTheta(url, label) {
  const timeoutMs = Number.isFinite(THETA_REQUEST_TIMEOUT_MS) ? THETA_REQUEST_TIMEOUT_MS : 10000;
  const options = timeoutMs > 0 ? { timeout: timeoutMs } : undefined;
  const candidates = buildLoopbackCandidates(url);
  let lastErr = null;

  for (const candidate of candidates) {
    try {
      return await fetch(candidate, options);
    } catch (err) {
      if (isTimeoutErr(err)) {
        const timeoutErr = new Error(`${label} timed out after ${timeoutMs}ms`);
        timeoutErr.statusCode = 504;
        throw timeoutErr;
      }
      lastErr = err;
      if (!isConnRefused(err)) throw err;
    }
  }

  if (lastErr) {
    const code = lastErr && typeof lastErr === 'object' ? lastErr.code : undefined;
    const hint = candidates.length > 1 ? ` (tried ${candidates.join(', ')})` : '';
    const wrapped = new Error(`${label} failed: ${lastErr.message || 'connect error'}${hint}`);
    wrapped.statusCode = code === 'ECONNREFUSED' ? 503 : undefined;
    throw wrapped;
  }
  throw new Error(`${label} failed: no candidate URLs to fetch`);
}

function buildLoopbackCandidates(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = String(parsed.hostname || '').toLowerCase();
    const loopbackHosts = ['127.0.0.1', 'localhost', '::1'];
    if (!loopbackHosts.includes(host)) return [rawUrl];

    const ordered = [host, ...loopbackHosts.filter((h) => h !== host)];
    return ordered.map((h) => {
      const next = new URL(rawUrl);
      next.hostname = h;
      return next.toString();
    });
  } catch {
    return [rawUrl];
  }
}

function isConnRefused(err) {
  const msg = String(err?.message || '').toLowerCase();
  return err?.code === 'ECONNREFUSED' || msg.includes('econnrefused');
}

function isTimeoutErr(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('network timeout');
}

async function getOptionContractStats({ symbol, expiration, right, strike }) {
  const [oiRes, ohlcRes] = await Promise.allSettled([
    fetchSnapshotRow({ type: 'open_interest', symbol, expiration, right, strike }),
    fetchSnapshotRow({ type: 'ohlc', symbol, expiration, right, strike }),
  ]);

  const oiRow = oiRes.status === 'fulfilled' ? oiRes.value : null;
  const ohlcRow = ohlcRes.status === 'fulfilled' ? ohlcRes.value : null;
  return {
    openInterest: toFiniteNumberOrNull(oiRow?.open_interest),
    volume: toFiniteNumberOrNull(ohlcRow?.volume),
  };
}

module.exports = { getOptionQuote, getOptionContractStats, getFpssStatus };
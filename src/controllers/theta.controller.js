const thetaClient = require('../services/thetaClient');
const { getFpssStatus, getOptionQuote } = thetaClient;

async function status(req, res, next) {
  try {
    const fpss = await getFpssStatus();
    res.json({ ok: true, fpss });
  } catch (err) {
    next(err);
  }
}

async function optionQuote(req, res, next) {
  try {
    const { symbol, expiration, right, strike } = req.query;
    if (!symbol || !expiration || !right || !strike) {
      const error = new Error('symbol, expiration, right, strike are required');
      error.statusCode = 400;
      throw error;
    }
    const quote = await getOptionQuote({ symbol, expiration, right, strike });
    res.json({
      symbol,
      expiration,
      right,
      strike,
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      openInterest: quote.openInterest,
      volume: quote.volume,
    });
  } catch (err) {
    // Bubble Theta "no data" as a clean 404 instead of a 500
    if (err.statusCode === 472 || err.statusCode === 404) {
      return res.status(404).json({
        message: 'Quote not available',
        detail: err.responseBody || err.message,
      });
    }
    next(err);
  }
}

module.exports = { status, optionQuote };

const router = require('express').Router();
const {
  createTrade,
  getTrades,
  getTradesDashboard,
  getHighestHighPrice,
  getWinningTrades,
  closeTrade,
  updateStopLoss,
} = require('../controllers/trades.controller');

router.post('/', createTrade);
router.get('/', getTrades);
router.get('/dashboard', getTradesDashboard);
router.get('/highest', getHighestHighPrice);
router.get('/winners', getWinningTrades);
router.patch('/:id/close', closeTrade);
router.patch('/:id/stoploss', updateStopLoss);

module.exports = router;


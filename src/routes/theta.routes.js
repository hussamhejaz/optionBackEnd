const router = require('express').Router();
const { status, optionQuote, indexPrice } = require('../controllers/theta.controller');

router.get('/status', status);
router.get('/option-quote', optionQuote);
router.get('/index-price', indexPrice);

module.exports = router;

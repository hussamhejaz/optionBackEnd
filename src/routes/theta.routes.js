const router = require('express').Router();
const { status, optionQuote } = require('../controllers/theta.controller');

router.get('/status', status);
router.get('/option-quote', optionQuote);

module.exports = router;

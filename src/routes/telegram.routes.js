const router = require('express').Router();
const { testTelegram, sendCard } = require('../controllers/telegram.controller');

router.post('/test', testTelegram);
router.post('/send-card', sendCard);

module.exports = router;

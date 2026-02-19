const router = require('express').Router();
const { updateTelegram, getSettings } = require('../controllers/settings.controller');

router.get('/', getSettings);
router.patch('/telegram', updateTelegram);

module.exports = router;

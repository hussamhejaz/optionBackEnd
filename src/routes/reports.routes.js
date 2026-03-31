const router = require('express').Router();
const { dailyReport, weeklyReport, monthlyReport, deleteReport } = require('../controllers/reports.controller');

router.get('/daily', dailyReport);
router.get('/weekly', weeklyReport);
router.get('/monthly', monthlyReport);
router.delete('/:id', deleteReport);

module.exports = router;

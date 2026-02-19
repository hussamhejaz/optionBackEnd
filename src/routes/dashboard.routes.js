const router = require('express').Router();
const { dashboardSummary, resetDashboard } = require('../controllers/dashboard.controller');

router.get('/summary', dashboardSummary);
router.post('/reset', resetDashboard);

module.exports = router;





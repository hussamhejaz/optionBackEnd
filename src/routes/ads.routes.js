const router = require('express').Router();
const {
  createAd,
  createAdFromTrade,
  listAds,
  getAd,
  updateAd,
  deleteAd,
  deleteAllAds,
  sendAdFromTrade,
  sendAdToTelegram,
} = require('../controllers/ads.controller');

router.post('/', createAd);
router.post('/from-trade', createAdFromTrade);
router.post('/send-from-trade', sendAdFromTrade);
router.get('/', listAds);
router.get('/:id', getAd);
router.patch('/:id', updateAd);
router.delete('/all', deleteAllAds);
router.delete('/:id', deleteAd);
router.post('/:id/send', sendAdToTelegram);

module.exports = router;



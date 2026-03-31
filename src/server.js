require('dotenv').config();
const dns = require('node:dns');
const forceIpv4First = String(process.env.FORCE_IPV4_FIRST || 'false').toLowerCase() === 'true';

if (forceIpv4First) {
  dns.setDefaultResultOrder('ipv4first');
  console.log('DNS result order forced to ipv4first');
} else {
  console.log('DNS result order: system default');
}

const app = require('./app');
const { startWatcher } = require('./jobs/priceWatcher');
const { startAdsCleanup } = require('./jobs/adsCleanup');

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

startWatcher();
startAdsCleanup();

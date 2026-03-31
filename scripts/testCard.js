const fs = require('fs');
const path = require('path');
const { renderTradeCardPNG } = require('../src/services/cardRenderer');

async function main() {
  const variant = process.argv.includes('--winning') ? 'winning-ad' : 'default';
  const buffer = await renderTradeCardPNG({
    symbol: 'SPY',
    strike: 686,
    expiration: '20260219',
    right: 'call',
    entryPrice: 1.04,
    mid: 1.12,
    openInterest: 5954,
    volume: 205990,
    pnlValue: 0.08,
    pnlPct: 7.69,
    variant,
  });

  const outputPath = path.join('/tmp', 'card.png');
  fs.writeFileSync(outputPath, buffer);
  console.log(`Card PNG (${variant}): ${outputPath}`);
  console.log(`Size: ${buffer.length} bytes`);
}

main().catch((err) => {
  console.error('Card render test failed:', err.message);
  process.exit(1);
});

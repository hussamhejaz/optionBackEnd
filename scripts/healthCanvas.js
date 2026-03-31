const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

function main() {
  const canvas = createCanvas(400, 200);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0f1018';
  ctx.fillRect(0, 0, 400, 200);
  ctx.fillStyle = '#35c46c';
  ctx.font = 'bold 34px Sans';
  ctx.fillText('canvas ok', 20, 80);
  ctx.fillStyle = '#f8fafc';
  ctx.font = '500 20px Sans';
  ctx.fillText(new Date().toISOString(), 20, 120);

  const outputPath = path.join('/tmp', 'canvas_health.png');
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
  console.log(`Canvas health PNG: ${outputPath}`);
  console.log(`Size: ${buffer.length} bytes`);
}

try {
  main();
} catch (err) {
  console.error('Canvas health check failed:', err.message);
  process.exit(1);
}

const { createCanvas, loadImage } = require('canvas');
const path = require('path');

const green = '#35c46c';
const red = '#e55454';
const bg = '#06070e';
const panel = '#0f1018';
const accent = '#7c3aed';
const text = '#f8fafc';
const dim = '#d1d5db';

function formatDate(expiration) {
  if (!expiration) return '';
  const y = expiration.slice(0, 4);
  const m = expiration.slice(4, 6);
  const d = expiration.slice(6, 8);
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = date.toLocaleString('en-US', { month: 'short' });
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${day} ${month} ${year}`;
}

function formatNum(n, decimals = 2) {
  if (!Number.isFinite(n)) return '--';
  return Number(n).toFixed(decimals);
}

function formatCompactCount(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return '--';
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
  return String(Math.round(num));
}

function drawCandleIcon(ctx, x, y, scale = 1) {
  const redBodyW = 28 * scale;
  const redBodyH = 90 * scale;
  const redWickX = x + redBodyW / 2 - 2 * scale;

  ctx.fillStyle = red;
  ctx.fillRect(x, y, redBodyW, redBodyH);
  ctx.fillRect(redWickX, y - 20 * scale, 4 * scale, 20 * scale);
  ctx.fillRect(redWickX, y + redBodyH, 4 * scale, 20 * scale);

  const greenBodyW = 28 * scale;
  const greenBodyH = 120 * scale;
  const greenX = x + 60 * scale;
  const greenY = y - 10 * scale;
  const greenWickX = greenX + greenBodyW / 2 - 2 * scale;

  ctx.fillStyle = green;
  ctx.fillRect(greenX, greenY, greenBodyW, greenBodyH);
  ctx.fillRect(greenWickX, greenY - 30 * scale, 4 * scale, 30 * scale);
  ctx.fillRect(greenWickX, greenY + greenBodyH, 4 * scale, 20 * scale);
}

function drawUsFlag(ctx, x, y, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();

  const stripeH = (r * 2) / 13;
  for (let i = 0; i < 13; i += 1) {
    ctx.fillStyle = i % 2 === 0 ? '#b22234' : '#ffffff';
    ctx.fillRect(x - r, y - r + i * stripeH, r * 2, stripeH);
  }

  ctx.fillStyle = '#3c3b6e';
  ctx.fillRect(x - r, y - r, r * 1.05, stripeH * 7);
  ctx.restore();
}

function drawSaudiFlag(ctx, x, y, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();

  ctx.fillStyle = '#006c35';
  ctx.fillRect(x - r, y - r, r * 2, r * 2);

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.max(9, Math.floor(r * 0.62))}px Sans`;
  ctx.fillText('SAUDI', x - r * 0.75, y - r * 0.05);
  ctx.fillRect(x - r * 0.45, y + r * 0.28, r * 0.9, Math.max(2, r * 0.08));
  ctx.restore();
}

async function tryLoadLogo(logoBuffer) {
  try {
    if (logoBuffer) return loadImage(logoBuffer);
    const logoPath = path.join(__dirname, '..', '..', 'logo', 'logo.jpeg');
    return loadImage(logoPath);
  } catch (_) {
    return null;
  }
}

function drawWordmarkFallback(ctx, x, y) {
  ctx.fillStyle = accent;
  ctx.font = 'bold 56px Sans';
  ctx.fillText('TRADER', x, y);
}

function drawHeader(ctx, { x, y, width, symbol, strike, expiration, right, logo }) {
  const headerH = 150;

  ctx.fillStyle = panel;
  ctx.fillRect(x, y, width, headerH);

  ctx.fillStyle = text;
  ctx.font = '600 46px Sans';
  ctx.fillText(`${symbol || ''} (${formatNum(strike, 1)})`, x + 56, y + 65);

  ctx.font = '500 36px Sans';
  ctx.fillStyle = dim;

  const dateText = formatDate(expiration);
  const rightText = String(right || '').toLowerCase();
  const dateWidth = ctx.measureText(`${dateText} `).width;

  const baseX = x + 56;
  const baseY = y + 118;

  ctx.fillText(`${dateText} `, baseX, baseY);
  ctx.fillStyle = rightText === 'put' ? red : green;
  ctx.fillText(rightText, baseX + dateWidth, baseY);

  drawCandleIcon(ctx, x + width / 2 - 48, y + 45, 0.75);

  if (logo) {
    const logoW = 250;
    const logoH = (logo.height / logo.width) * logoW;
    ctx.drawImage(logo, x + width - logoW - 60, y + 16, logoW, logoH);
  } else {
    drawWordmarkFallback(ctx, x + width - 280, y + 80);
  }

  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x, y + headerH);
  ctx.lineTo(x + width, y + headerH);
  ctx.stroke();
}

function drawBodyPanel(ctx, {
  x,
  y,
  width,
  height,
  price,
  pnlValue,
  pnlPct,
  mid,
  openInterest,
  volume,
  profitMode,
  compact = true,
  flagsStyle = 'raised', // ✅ raised | bottom
}) {
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, width, height);

  const priceColor = profitMode ? green : text;
  const deltaColor = profitMode ? green : dim;

  const leftCenterX = x + Math.floor(width * 0.27);

  // ✅ نسبية لتطلع متناسقة
  const priceY = compact ? (y + Math.round(height * 0.38)) : (y + Math.floor(height / 2) - 10);
  const pnlY = priceY + Math.round(height * 0.12);

  ctx.fillStyle = priceColor;
  ctx.font = '700 92px Sans';
  ctx.textAlign = 'center';
  ctx.fillText(formatNum(price), leftCenterX, priceY);

  ctx.fillStyle = deltaColor;
  ctx.font = '600 32px Sans';
  ctx.fillText(`${formatNum(pnlValue)} $  ${formatNum(pnlPct)}%`, leftCenterX, pnlY);
  ctx.textAlign = 'left';

  // ===== Right stats =====
  ctx.fillStyle = text;
  ctx.font = '500 38px Sans';

  const rightPadding = 50;
  const colGap = 260;
  const valueX = x + width - rightPadding;
  const labelX = valueX - colGap;

  const gap = 52;
  const rowY = compact ? (y + Math.round(height * 0.35)) : (y + Math.floor(height / 2) - gap);

  ctx.fillText('Mid :', labelX, rowY);
  ctx.fillText('Open Int :', labelX, rowY + gap);
  ctx.fillText('Vol :', labelX, rowY + gap * 2);

  // ✅ يدعم string رقمية مثل "350"
  const oi = Number(openInterest);
  const volNum = Number(volume);

  ctx.textAlign = 'right';
  ctx.fillText(formatNum(mid), valueX, rowY);
  ctx.fillText(Number.isFinite(oi) && oi > 0 ? String(oi) : '--', valueX, rowY + gap);
  ctx.fillText(formatCompactCount(volNum), valueX, rowY + gap * 2);
  ctx.textAlign = 'left';

  // ===== Flags =====
  const isRaised = flagsStyle === 'raised';
  const flagR = compact ? (isRaised ? 20 : 22) : 24;
  const gapX = compact ? (isRaised ? 30 : 32) : 34;

  // ✅ raised للصفقة الجديدة / bottom لكرت الدخول بالإعلان
  const fy = compact
    ? (isRaised ? (y + height - 120) : (y + height - 55))
    : (y + height - 55);

  drawUsFlag(ctx, leftCenterX - gapX, fy, flagR);
  drawSaudiFlag(ctx, leftCenterX + gapX, fy, flagR);
}

function drawFooter(ctx, { x, y, width, pnlValue, pnlPct, expiration, right, logo }) {
  const footerH = 125;
  const leftCenterX = x + Math.floor(width * 0.27);

  ctx.fillStyle = panel;
  ctx.fillRect(x, y, width, footerH);

  ctx.fillStyle = green;
  ctx.font = '700 50px Sans';
  ctx.textAlign = 'center';
  ctx.fillText(`${formatNum(pnlValue, 0)}$| ${formatNum(pnlPct)}%`, leftCenterX, y + 66);

  ctx.fillStyle = dim;
  ctx.font = '500 36px Sans';

  const dateText = formatDate(expiration);
  const rightText = String(right || '').toLowerCase();
  const datePart = `${dateText} `;
  const dateWidth = ctx.measureText(datePart).width;
  const totalWidth = dateWidth + ctx.measureText(rightText).width;

  const startX = leftCenterX - totalWidth / 2;
  const ty = y + 112;

  ctx.textAlign = 'left';
  ctx.fillText(datePart, startX, ty);
  ctx.fillStyle = rightText === 'put' ? red : green;
  ctx.fillText(rightText, startX + dateWidth, ty);

  drawCandleIcon(ctx, x + width / 2 - 48, y + 26, 0.75);

  if (logo) {
    const logoW = 250;
    const logoH = (logo.height / logo.width) * logoW;
    ctx.drawImage(logo, x + width - logoW - 60, y + 8, logoW, logoH);
  } else {
    ctx.fillStyle = accent;
    ctx.font = 'bold 56px Sans';
    ctx.fillText('TRADER', x + width - 280, y + 70);
  }

  ctx.textAlign = 'left';
}

function renderDefaultCard(ctx, {
  width,
  height,
  symbol,
  strike,
  expiration,
  right,
  mid,
  openInterest,
  volume,
  pnlValue,
  pnlPct,
  logo,
}) {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const cardPad = 20;
  const cardX = cardPad;
  const cardY = cardPad;
  const cardW = width - cardPad * 2;

  const headerH = 150;
  const bodyH = height - cardPad * 2 - headerH;

  drawHeader(ctx, { x: cardX, y: cardY, width: cardW, symbol, strike, expiration, right, logo });

  drawBodyPanel(ctx, {
    x: cardX,
    y: cardY + headerH,
    width: cardW,
    height: bodyH,
    price: mid,
    pnlValue,
    pnlPct,
    mid,
    openInterest,
    volume,
    profitMode: Number(pnlValue) > 0,
    compact: true,
    flagsStyle: 'raised', // ✅ للصفقة الجديدة
  });
}

function renderWinningAdCard(ctx, {
  width,
  height,
  symbol,
  strike,
  expiration,
  right,
  entryPrice,
  mid,
  openInterest,
  volume,
  pnlValue,
  pnlPct,
  logo,
}) {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const cardPad = 20;
  const cardX = cardPad;
  const cardY = cardPad;
  const cardW = width - cardPad * 2;

  const headerH = 150;
  const bodyEntryH = 300;
  const bodyCurrentH = 360;
  const dividerH = 4;

  let y = cardY;

  // Header 1
  drawHeader(ctx, { x: cardX, y, width: cardW, symbol, strike, expiration, right, logo });
  y += headerH;

  // Body 1 (Entry) ✅ flags bottom حتى ما يخرب
  drawBodyPanel(ctx, {
    x: cardX,
    y,
    width: cardW,
    height: bodyEntryH,
    price: entryPrice,
    pnlValue: 0,
    pnlPct: 0,
    mid: entryPrice,
    openInterest,
    volume,
    profitMode: false,
    compact: true,
    flagsStyle: 'bottom', // ✅ هذا هو الإصلاح
  });
  y += bodyEntryH;

  // Divider
  ctx.strokeStyle = accent;
  ctx.lineWidth = dividerH;
  ctx.beginPath();
  ctx.moveTo(cardX, y);
  ctx.lineTo(cardX + cardW, y);
  ctx.stroke();

  // Header 2
  drawHeader(ctx, { x: cardX, y, width: cardW, symbol, strike, expiration, right, logo });
  y += headerH;

  // Body 2 (Current) ✅ flags raised
  drawBodyPanel(ctx, {
    x: cardX,
    y,
    width: cardW,
    height: bodyCurrentH,
    price: mid,
    pnlValue,
    pnlPct,
    mid,
    openInterest,
    volume,
    profitMode: true,
    compact: true,
    flagsStyle: 'raised',
  });
  y += bodyCurrentH;

  // Divider
  ctx.strokeStyle = accent;
  ctx.lineWidth = dividerH;
  ctx.beginPath();
  ctx.moveTo(cardX, y);
  ctx.lineTo(cardX + cardW, y);
  ctx.stroke();

  drawFooter(ctx, { x: cardX, y, width: cardW, pnlValue, pnlPct, expiration, right, logo });
}

async function renderTradeCardPNG({
  symbol,
  strike,
  expiration,
  right,
  entryPrice,
  mid,
  openInterest,
  volume,
  pnlValue,
  pnlPct,
  logoBuffer,
  variant = 'default',
}) {
  try {
    const isWinningAd = variant === 'winning-ad';
    const width = 1080;

    const defaultHeight = 600; // ✅ أصغر للصفقة الجديدة
    const winningHeight = 1140; // ✅ إعلان مضغوط

    const height = isWinningAd ? winningHeight : defaultHeight;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const logo = await tryLoadLogo(logoBuffer);

    if (isWinningAd) {
      renderWinningAdCard(ctx, {
        width,
        height,
        symbol,
        strike,
        expiration,
        right,
        entryPrice,
        mid,
        openInterest,
        volume,
        pnlValue,
        pnlPct,
        logo,
      });
    } else {
      renderDefaultCard(ctx, {
        width,
        height,
        symbol,
        strike,
        expiration,
        right,
        mid,
        openInterest,
        volume,
        pnlValue,
        pnlPct,
        
        logo,
      });
    }

    const buffer = canvas.toBuffer('image/png');
    console.log(`[CARD_RENDER] PNG size: ${buffer.length} bytes (${variant})`);
    if (buffer.length < 5000) {
      console.warn('[CARD_RENDER] PNG too small; canvas dependencies likely missing');
    }
    return buffer;
  } catch (err) {
    console.error('[CARD_RENDER] Failed to render card PNG:', err.message);
    throw err;
  }
}

module.exports = { renderTradeCardPNG };

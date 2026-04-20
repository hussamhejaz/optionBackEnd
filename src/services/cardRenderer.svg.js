const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

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

function trimTrailingZeros(numText) {
  return String(numText).replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '');
}

function formatPriceAdaptive(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '--';
  const abs = Math.abs(num);
  let decimals = 2;
  if (abs >= 1000) decimals = 0;
  else if (abs >= 100) decimals = 1;
  return trimTrailingZeros(num.toFixed(decimals));
}

function formatPercentAdaptive(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '--';
  return trimTrailingZeros(num.toFixed(2));
}

function formatCompactCount(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return '--';
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
  return String(Math.round(num));
}

function fitFontSizeByLength(value, baseSize, minSize, targetLen) {
  const textValue = String(value ?? '');
  if (!textValue) return baseSize;
  const ratio = targetLen / Math.max(textValue.length, 1);
  const nextSize = Math.floor(baseSize * Math.min(1, ratio));
  return Math.max(minSize, nextSize);
}

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getLogoDataUrl(logoBuffer) {
  try {
    const buf = logoBuffer || fs.readFileSync(path.join(__dirname, '..', '..', 'logo', 'logo.jpeg'));
    return `data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}`;
  } catch (_) {
    return null;
  }
}

function candleSvg(x, y, scale = 1) {
  const wickW = Math.max(3, 4 * scale);
  const redBodyW = 24 * scale;
  const redBodyH = 84 * scale;
  const redWickX = x + redBodyW / 2 - wickW / 2;
  const greenBodyW = 24 * scale;
  const greenBodyH = 110 * scale;
  const greenX = x + 54 * scale;
  const greenY = y - 8 * scale;
  const greenWickX = greenX + greenBodyW / 2 - wickW / 2;
  return `
    <rect x="${x}" y="${y}" width="${redBodyW}" height="${redBodyH}" fill="${red}"/>
    <rect x="${redWickX}" y="${y - 18 * scale}" width="${wickW}" height="${18 * scale}" fill="${red}"/>
    <rect x="${redWickX}" y="${y + redBodyH}" width="${wickW}" height="${18 * scale}" fill="${red}"/>
    <rect x="${greenX}" y="${greenY}" width="${greenBodyW}" height="${greenBodyH}" fill="${green}"/>
    <rect x="${greenWickX}" y="${greenY - 24 * scale}" width="${wickW}" height="${24 * scale}" fill="${green}"/>
    <rect x="${greenWickX}" y="${greenY + greenBodyH}" width="${wickW}" height="${18 * scale}" fill="${green}"/>
  `;
}

function usFlagSvg(cx, cy, r, id) {
  const stripeH = (r * 2) / 13;
  const x = cx - r;
  const y = cy - r;
  const stripes = Array.from({ length: 13 }).map((_, i) => (
    `<rect x="${x}" y="${y + i * stripeH}" width="${r * 2}" height="${stripeH}" fill="${i % 2 === 0 ? '#b22234' : '#ffffff'}"/>`
  )).join('');
  return `
    <clipPath id="us-${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
    <g clip-path="url(#us-${id})">
      ${stripes}
      <rect x="${x}" y="${y}" width="${r * 1.05}" height="${stripeH * 7}" fill="#3c3b6e"/>
    </g>
  `;
}

function saFlagSvg(cx, cy, r, id) {
  const x = cx - r;
  const y = cy - r;
  return `
    <clipPath id="sa-${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
    <g clip-path="url(#sa-${id})">
      <rect x="${x}" y="${y}" width="${r * 2}" height="${r * 2}" fill="#006c35"/>
      <text x="${x + r * 0.25}" y="${y + r * 0.92}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.max(9, Math.floor(r * 0.62))}" font-weight="700" fill="#ffffff">SAUDI</text>
      <rect x="${x + r * 0.55}" y="${y + r * 1.28}" width="${r * 0.9}" height="${Math.max(2, r * 0.08)}" fill="#ffffff"/>
    </g>
  `;
}

function headerSvg({ x, y, width, symbol, strike, expiration, right, logoDataUrl }) {
  const dateText = formatDate(expiration);
  const rightText = String(right || '').toLowerCase();
  const rightColor = rightText === 'put' ? red : green;
  const headerTitle = `${symbol || ''} (${formatPriceAdaptive(strike)})`;
  const headerTitleFontSize = fitFontSizeByLength(headerTitle, 46, 28, 18);
  return `
    <rect x="${x}" y="${y}" width="${width}" height="150" fill="${panel}"/>
    <text x="${x + 56}" y="${y + 65}" fill="${text}" font-size="${headerTitleFontSize}" font-weight="600" font-family="DejaVu Sans, Arial, sans-serif">${escapeXml(headerTitle)}</text>
    <text x="${x + 56}" y="${y + 118}" fill="${dim}" font-size="36" font-weight="500" font-family="DejaVu Sans, Arial, sans-serif">${escapeXml(dateText)} </text>
    <text x="${x + 56 + Math.max(0, dateText.length * 20)}" y="${y + 118}" fill="${rightColor}" font-size="36" font-weight="500" font-family="DejaVu Sans, Arial, sans-serif">${escapeXml(rightText)}</text>
    ${candleSvg(x + width / 2 - 48, y + 45, 0.75)}
    ${logoDataUrl
      ? `<image href="${logoDataUrl}" x="${x + width - 250 - 60}" y="${y + 16}" width="250" height="118" preserveAspectRatio="xMidYMid meet"/>`
      : `<text x="${x + width - 280}" y="${y + 80}" fill="${accent}" font-size="56" font-weight="700" font-family="DejaVu Sans, Arial, sans-serif">TRADER</text>`}
    <line x1="${x}" y1="${y + 150}" x2="${x + width}" y2="${y + 150}" stroke="${accent}" stroke-width="4"/>
  `;
}

function bodySvg({
  x, y, width, height, price, pnlValue, pnlPct, mid, openInterest, volume, profitMode, flagsStyle = 'raised', flagId,
}) {
  const priceColor = profitMode ? green : text;
  const deltaColor = profitMode ? green : dim;
  const leftCenterX = x + Math.floor(width * 0.27);
  const priceY = y + Math.round(height * 0.38);
  const pnlY = priceY + Math.round(height * 0.12);
  const rightPadding = 50;
  const colGap = 310;
  const valueX = x + width - rightPadding;
  const labelX = valueX - colGap;
  const gap = 52;
  const rowY = y + Math.round(height * 0.35);
  const oi = Number(openInterest);
  const volNum = Number(volume);
  const isRaised = flagsStyle === 'raised';
  const flagR = isRaised ? 20 : 22;
  const gapX = isRaised ? 30 : 32;
  const fy = isRaised ? (y + height - 120) : (y + height - 55);
  const priceText = formatPriceAdaptive(price);
  const pnlText = `${formatPriceAdaptive(pnlValue)} $  ${formatPercentAdaptive(pnlPct)}%`;
  const priceFontSize = fitFontSizeByLength(priceText, 92, 52, 7);
  const pnlFontSize = fitFontSizeByLength(pnlText, 32, 20, 18);
  const midText = formatPriceAdaptive(mid);
  return `
    <rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${bg}"/>
    <text x="${leftCenterX}" y="${priceY}" fill="${priceColor}" font-size="${priceFontSize}" font-weight="700" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif">${priceText}</text>
    <text x="${leftCenterX}" y="${pnlY}" fill="${deltaColor}" font-size="${pnlFontSize}" font-weight="600" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif">${pnlText}</text>
    <text x="${labelX}" y="${rowY}" fill="${text}" font-size="38" font-weight="500" font-family="DejaVu Sans, Arial, sans-serif">Mid :</text>
    <text x="${labelX}" y="${rowY + gap}" fill="${text}" font-size="38" font-weight="500" font-family="DejaVu Sans, Arial, sans-serif">Open Int :</text>
    <text x="${labelX}" y="${rowY + gap * 2}" fill="${text}" font-size="38" font-weight="500" font-family="DejaVu Sans, Arial, sans-serif">Vol :</text>
    <text x="${valueX}" y="${rowY}" fill="${text}" font-size="38" font-weight="500" text-anchor="end" font-family="DejaVu Sans, Arial, sans-serif">${midText}</text>
    <text x="${valueX}" y="${rowY + gap}" fill="${text}" font-size="38" font-weight="500" text-anchor="end" font-family="DejaVu Sans, Arial, sans-serif">${formatCompactCount(oi)}</text>
    <text x="${valueX}" y="${rowY + gap * 2}" fill="${text}" font-size="38" font-weight="500" text-anchor="end" font-family="DejaVu Sans, Arial, sans-serif">${formatCompactCount(volNum)}</text>
    ${usFlagSvg(leftCenterX - gapX, fy, flagR, `${flagId}-us`)}
    ${saFlagSvg(leftCenterX + gapX, fy, flagR, `${flagId}-sa`)}
  `;
}

function footerSvg({ x, y, width, pnlValue, pnlPct, expiration, right, logoDataUrl }) {
  const leftCenterX = x + Math.floor(width * 0.27);
  const dateText = formatDate(expiration);
  const rightText = String(right || '').toLowerCase();
  const rightColor = rightText === 'put' ? red : green;
  const footerPnlText = `${formatPriceAdaptive(pnlValue)}$| ${formatPercentAdaptive(pnlPct)}%`;
  const footerPnlFontSize = fitFontSizeByLength(footerPnlText, 50, 28, 16);
  return `
    <rect x="${x}" y="${y}" width="${width}" height="125" fill="${panel}"/>
    <text x="${leftCenterX}" y="${y + 66}" fill="${green}" font-size="${footerPnlFontSize}" font-weight="700" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif">${footerPnlText}</text>
    <text x="${leftCenterX - 20}" y="${y + 112}" fill="${dim}" font-size="36" font-weight="500" text-anchor="end" font-family="DejaVu Sans, Arial, sans-serif">${escapeXml(dateText)} </text>
    <text x="${leftCenterX - 18}" y="${y + 112}" fill="${rightColor}" font-size="36" font-weight="500" text-anchor="start" font-family="DejaVu Sans, Arial, sans-serif">${escapeXml(rightText)}</text>
    ${candleSvg(x + width / 2 - 42, y + 32, 0.72)}
    ${logoDataUrl
      ? `<image href="${logoDataUrl}" x="${x + width - 250 - 60}" y="${y + 8}" width="250" height="109" preserveAspectRatio="xMidYMid meet"/>`
      : `<text x="${x + width - 280}" y="${y + 70}" fill="${accent}" font-size="56" font-weight="700" font-family="DejaVu Sans, Arial, sans-serif">TRADER</text>`}
  `;
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
  const isWinningAd = variant === 'winning-ad';
  const width = 1080;
  const height = isWinningAd ? 1140 : 600;
  const cardPad = 20;
  const cardX = cardPad;
  const cardY = cardPad;
  const cardW = width - cardPad * 2;
  const logoDataUrl = getLogoDataUrl(logoBuffer);

  let body = '';
  if (isWinningAd) {
    let y = cardY;
    body += headerSvg({ x: cardX, y, width: cardW, symbol, strike, expiration, right, logoDataUrl });
    y += 150;
    body += bodySvg({
      x: cardX, y, width: cardW, height: 300, price: entryPrice, pnlValue: 0, pnlPct: 0, mid: entryPrice,
      openInterest, volume, profitMode: false, flagsStyle: 'bottom', flagId: 'entry',
    });
    y += 300;
    body += `<line x1="${cardX}" y1="${y}" x2="${cardX + cardW}" y2="${y}" stroke="${accent}" stroke-width="4"/>`;
    body += headerSvg({ x: cardX, y, width: cardW, symbol, strike, expiration, right, logoDataUrl });
    y += 150;
    body += bodySvg({
      x: cardX, y, width: cardW, height: 360, price: mid, pnlValue, pnlPct, mid,
      openInterest, volume, profitMode: true, flagsStyle: 'raised', flagId: 'current',
    });
    y += 360;
    body += `<line x1="${cardX}" y1="${y}" x2="${cardX + cardW}" y2="${y}" stroke="${accent}" stroke-width="4"/>`;
    body += footerSvg({ x: cardX, y, width: cardW, pnlValue, pnlPct, expiration, right, logoDataUrl });
  } else {
    const headerH = 150;
    const bodyH = height - cardPad * 2 - headerH;
    body += headerSvg({ x: cardX, y: cardY, width: cardW, symbol, strike, expiration, right, logoDataUrl });
    body += bodySvg({
      x: cardX, y: cardY + headerH, width: cardW, height: bodyH, price: mid, pnlValue, pnlPct, mid,
      openInterest, volume, profitMode: Number(pnlValue) > 0, flagsStyle: 'raised', flagId: 'default',
    });
  }

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect x="0" y="0" width="${width}" height="${height}" fill="${bg}"/>
      ${body}
    </svg>
  `;

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(
    `<!DOCTYPE html><html><body style="margin:0;background:${bg};"><div id="card">${svg}</div></body></html>`,
    { waitUntil: 'networkidle0' }
  );
  const card = await page.$('#card');
  const buffer = await card.screenshot({ type: 'png' });
  await browser.close();
  console.log(`[SVG_RENDER] PNG size: ${buffer.length} bytes (${variant})`);
  return buffer;
}

module.exports = { renderTradeCardPNG };

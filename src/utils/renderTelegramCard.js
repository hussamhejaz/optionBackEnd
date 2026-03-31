let puppeteer;
let browserPromise = null;

const ACCENT = '#34d399';
const BG = '#0b1220';

function buildHtml({ title, lines, footer, rtl }) {
  const direction = rtl ? 'rtl' : 'ltr';
  const align = rtl ? 'right' : 'left';
  const safeLines = Array.isArray(lines) ? lines : [];
  return `
<!DOCTYPE html>
<html lang="en" dir="${direction}">
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: transparent;
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 24px;
    }
    .card {
      width: 900px;
      background: ${BG};
      color: #e5e7eb;
      border-radius: 18px;
      border: 1px solid #111827;
      box-shadow: 0 18px 45px rgba(0,0,0,0.45);
      padding: 28px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      direction: ${direction};
      text-align: ${align};
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .title {
      font-size: 28px;
      font-weight: 700;
      color: #f9fafb;
    }
    .badge {
      background: ${ACCENT}22;
      color: ${ACCENT};
      border: 1px solid ${ACCENT}55;
      border-radius: 999px;
      padding: 8px 14px;
      font-size: 14px;
      font-weight: 600;
    }
    .line {
      font-size: 18px;
      line-height: 1.6;
      color: #d1d5db;
    }
    .footer {
      margin-top: 6px;
      font-size: 15px;
      color: #9ca3af;
    }
    .divider {
      height: 2px;
      background: linear-gradient(90deg, transparent, ${ACCENT}, transparent);
      border-radius: 999px;
    }
  </style>
</head>
<body>
  <div class="card" id="card">
    <div class="header">
      <div class="title">${title || 'Alert'}</div>
      <div class="badge">Trading Alert</div>
    </div>
    <div class="divider"></div>
    <div class="content">
      ${safeLines.map(l => `<div class="line">${l}</div>`).join('')}
    </div>
    ${footer ? `<div class="divider"></div><div class="footer">${footer}</div>` : ''}
  </div>
</body>
</html>`;
}

async function getBrowser() {
  if (!puppeteer) {
    try {
      puppeteer = require('puppeteer');
    } catch (err) {
      const e = new Error('puppeteer is not installed; run npm install puppeteer or disable image sending');
      e.statusCode = 503;
      throw e;
    }
  }
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

async function renderTelegramCardToPng({ title, lines, footer, rtl }) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 960, height: 600, deviceScaleFactor: 2 });
    const html = buildHtml({ title, lines, footer, rtl });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const card = await page.$('#card');
    const buffer = await card.screenshot({ omitBackground: true, type: 'png' });
    return buffer;
  } finally {
    await page.close().catch(() => {});
  }
}

// Clean shutdown
process.on('exit', async () => {
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      await browser.close();
    } catch (_) {}
  }
});

module.exports = { renderTelegramCardToPng };

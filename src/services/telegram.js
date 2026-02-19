const fetch = require('node-fetch');
const FormData = require('form-data');
const { renderTelegramCardToPng } = require('../utils/renderTelegramCard');

const token = process.env.TELEGRAM_BOT_TOKEN;

async function sendTelegramCardImage(chatId, cardPayload) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');
  if (!chatId) throw new Error('chatId is required');

  let buffer;
  try {
    buffer = await renderTelegramCardToPng(cardPayload);
  } catch (err) {
    // propagate meaningful message for missing puppeteer
    throw err;
  }
  

  const url = `https://api.telegram.org/bot${token}/sendPhoto`;
  const form = new FormData();
  form.append('chat_id', chatId);
  if (cardPayload.caption) form.append('caption', cardPayload.caption);
  form.append('photo', buffer, { filename: 'card.png', contentType: 'image/png' });

  const res = await fetch(url, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    const err = new Error(`Telegram sendPhoto failed: ${res.status} ${JSON.stringify(body)}`);
    err.statusCode = 502;
    throw err;
  }
  return body;
}

module.exports = { sendTelegramCardImage };

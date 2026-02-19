const fetch = require('node-fetch');
const FormData = require('form-data');

const defaultToken = process.env.TELEGRAM_BOT_TOKEN;
const defaultChatId = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramMessage(text, options = {}) {
  const token = options.token || defaultToken;
  const chatId = options.chatId || defaultChatId;
  if (!token || !chatId) {
    console.warn('Telegram not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.ok) {
      return body;
    } else {
      console.error('Telegram send failed:', body || res.statusText);
    }
  } catch (err) {
    console.error('Telegram send failed:', err.message);
  }
}

async function sendTelegramPhoto({ caption, imageBuffer, chatId: chatIdOverride, token: tokenOverride }) {
  const token = tokenOverride || defaultToken;
  const chatId = chatIdOverride || defaultChatId;
  if (!token || !chatId) {
    console.warn('Telegram not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendPhoto`;
  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption) form.append('caption', caption);
  form.append('photo', imageBuffer, { filename: 'card.png', contentType: 'image/png' });

  try {
    const res = await fetch(url, { method: 'POST', body: form });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.ok) {
      return body;
    } else {
      console.error('Telegram photo failed:', body || res.statusText);
    }
  } catch (err) {
    console.error('Telegram photo failed:', err.message);
  }
}

module.exports = { sendTelegramMessage, sendTelegramPhoto };

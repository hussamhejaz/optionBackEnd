const fetch = require('node-fetch');
const FormData = require('form-data');

const defaultToken = process.env.TELEGRAM_BOT_TOKEN;
const defaultChatId = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramMessage(text, options = {}) {
  const token = options.token || defaultToken;
  const chatId = options.chatId || defaultChatId;
  if (!token || !chatId) {
    throw new Error('Telegram not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
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
    }
    throw new Error(`Telegram send failed (${res.status}): ${JSON.stringify(body || res.statusText)}`);
  } catch (err) {
    throw err;
  }
}

async function sendTelegramPhoto({
  botToken,
  chatId,
  photoBuffer,
  caption,
  // Backward-compatible aliases used by existing callers in this codebase:
  imageBuffer,
  token: tokenOverride,
} = {}) {
  const token = botToken || tokenOverride || defaultToken;
  const resolvedChatId = chatId || defaultChatId;
  const resolvedPhotoBuffer = photoBuffer || imageBuffer;

  if (!token || !resolvedChatId) {
    throw new Error('Telegram not configured (missing bot token or chat id)');
  }
  if (!resolvedPhotoBuffer || !Buffer.isBuffer(resolvedPhotoBuffer)) {
    throw new Error('sendTelegramPhoto requires a valid PNG buffer');
  }

  const url = `https://api.telegram.org/bot${token}/sendPhoto`;
  const form = new FormData();
  form.append('chat_id', resolvedChatId);
  if (caption) form.append('caption', caption);
  form.append('photo', resolvedPhotoBuffer, { filename: 'card.png', contentType: 'image/png' });

  const res = await fetch(url, {
    method: 'POST',
    headers: form.getHeaders(),
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body?.ok) return body;

  throw new Error(
    `Telegram sendPhoto failed (${res.status}): ${JSON.stringify(body || res.statusText)}`
  );
}

module.exports = { sendTelegramMessage, sendTelegramPhoto };

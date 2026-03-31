const { sendTelegramMessage } = require('../services/telegramService');
const { logNotification } = require('../utils/notifications');
const { sendTelegramCardImage } = require('../services/telegram');

async function testTelegram(req, res, next) {
  try {
    const message = '✅ Telegram connected from backend';
    await sendTelegramMessage(message);
    logNotification({ type: 'TELEGRAM', message, status: 'SENT' }).catch((err) =>
      console.error('logNotification failed', err)
    );
    res.json({ ok: true });
  } catch (err) {
    logNotification({ type: 'TELEGRAM', message: err.message, status: 'FAILED' }).catch((e) =>
      console.error('logNotification failed', e)
    );
    next(err);
  }
}

async function sendCard(req, res, next) {
  try {
    const { chatId: bodyChatId, title, message, footer, rtl } = req.body || {};
    const chatId = bodyChatId || process.env.TELEGRAM_CHAT_ID;
    if (!message || !String(message).trim()) {
      const err = new Error('message is required');
      err.statusCode = 400;
      throw err;
    }
    if (!chatId) {
      const err = new Error('chatId is required (in body or TELEGRAM_CHAT_ID)');
      err.statusCode = 400;
      throw err;
    }

    const lines = String(message)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    await sendTelegramCardImage(chatId, {
      title: title || 'Trade Alert',
      lines,
      footer,
      rtl: !!rtl,
      caption: title || 'Alert',
    });

    res.json({ success: true });
  } catch (err) {
    console.error('sendCard failed:', err.message);
    if (!err.statusCode) err.statusCode = 500;
    res.status(err.statusCode).json({ success: false, error: err.message });
  }
}

module.exports = { testTelegram, sendTelegramMessage, sendCard };

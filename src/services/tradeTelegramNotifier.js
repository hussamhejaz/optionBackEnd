const { sendTelegramMessage, sendTelegramPhoto } = require('./telegramService');
const { renderTradeCardPNG } = require('./cardRenderer');

const ENABLE_TELEGRAM_IMAGE =
  String(process.env.ENABLE_TELEGRAM_IMAGE || 'false').toLowerCase() === 'true';
const TELEGRAM_CHAT_ID_TRADES = process.env.TELEGRAM_CHAT_ID_TRADES || process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_BOT_TOKEN_TRADES =
  process.env.TELEGRAM_BOT_TOKEN_TRADES || process.env.TELEGRAM_BOT_TOKEN;

function toFiniteNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function extractTelegramMeta(response, fallbackChatId = null) {
  const result = response?.result || {};
  const messageIdRaw = Number(result.message_id);
  const sentAtUnixRaw = Number(result.date);
  const chatIdFromApi = result?.chat?.id;
  return {
    telegramMessageId: Number.isInteger(messageIdRaw) ? messageIdRaw : null,
    telegramChatId:
      chatIdFromApi !== undefined && chatIdFromApi !== null
        ? String(chatIdFromApi)
        : fallbackChatId
          ? String(fallbackChatId)
          : null,
    telegramSentAtUnix: Number.isFinite(sentAtUnixRaw) ? sentAtUnixRaw : null,
  };
}

function buildTradeCardPayload(trade = {}) {
  const entryPrice = Number(trade.entryPrice);
  const midRaw = Number(trade.mid ?? trade.lastMidPrice ?? trade.entryPrice);
  const mid = Number.isFinite(midRaw) ? midRaw : entryPrice;
  return {
    symbol: trade.symbol,
    strike: trade.strike,
    expiration: trade.expiration,
    right: trade.right,
    entryPrice,
    mid,
    openInterest: toFiniteNumberOrNull(trade.openInterest),
    volume: toFiniteNumberOrNull(trade.volume),
    pnlValue:
      Number.isFinite(entryPrice) && Number.isFinite(mid)
        ? mid - entryPrice
        : 0,
    pnlPct:
      Number.isFinite(entryPrice) && Number.isFinite(mid) && entryPrice !== 0
        ? ((mid - entryPrice) / entryPrice) * 100
        : 0,
  };
}

function resolveTradeChatId(trade = {}) {
  const fromTrade = String(trade.telegramChatId || '').trim();
  if (fromTrade) return fromTrade;
  return TELEGRAM_CHAT_ID_TRADES;
}

async function sendNewTradeCard({ tradeId, trade, caption }) {
  try {
    const chatId = resolveTradeChatId(trade);
    if (ENABLE_TELEGRAM_IMAGE) {
      try {
        const cardBuffer = await renderTradeCardPNG(buildTradeCardPayload(trade));
        const response = await sendTelegramPhoto({
          caption,
          imageBuffer: cardBuffer,
          chatId,
          token: TELEGRAM_BOT_TOKEN_TRADES,
        });
        return { ok: true, ...extractTelegramMeta(response, chatId) };
      } catch (photoErr) {
        console.error(`Telegram image send failed (new trade ${tradeId}):`, photoErr.message);
      }
    }

    const response = await sendTelegramMessage(caption, {
      chatId,
      token: TELEGRAM_BOT_TOKEN_TRADES,
    });
    return { ok: true, ...extractTelegramMeta(response, chatId) };
  } catch (err) {
    console.error(`Telegram send failed (new trade ${tradeId}):`, err.message);
    return { ok: false, error: err.message };
  }
}

async function sendTradeUpdateReply({
  tradeId,
  trade,
  text,
  preferImage = false,
  imageCaption = null,
  imagePayload = null,
}) {
  const replyToRaw = Number(trade?.telegramMessageId);
  const replyToMessageId = Number.isInteger(replyToRaw) ? replyToRaw : null;
  const chatId = resolveTradeChatId(trade);

  async function sendOnce(replyTo) {
    if (preferImage && ENABLE_TELEGRAM_IMAGE) {
      const cardBuffer = await renderTradeCardPNG(imagePayload || buildTradeCardPayload(trade));
      return sendTelegramPhoto({
        caption: imageCaption || text,
        imageBuffer: cardBuffer,
        chatId,
        token: TELEGRAM_BOT_TOKEN_TRADES,
        replyToMessageId: replyTo,
      });
    }

    return sendTelegramMessage(text, {
      chatId,
      token: TELEGRAM_BOT_TOKEN_TRADES,
      replyToMessageId: replyTo,
    });
  }

  try {
    const response = await sendOnce(replyToMessageId);
    return { ok: true, replied: replyToMessageId !== null, ...extractTelegramMeta(response, chatId) };
  } catch (err) {
    const hasReplyTarget = replyToMessageId !== null;
    const contextMessage = hasReplyTarget
      ? `Telegram reply send failed (trade ${tradeId}, reply_to_message_id=${replyToMessageId}). Retrying as plain message:`
      : `Telegram update send failed (trade ${tradeId}). Retrying as plain message:`;
    console.error(contextMessage, err.message);
    try {
      const fallbackResponse = await sendTelegramMessage(text, {
        chatId,
        token: TELEGRAM_BOT_TOKEN_TRADES,
      });
      return { ok: true, replied: false, fallbackUsed: true, ...extractTelegramMeta(fallbackResponse, chatId) };
    } catch (fallbackErr) {
      console.error(`Telegram fallback send failed (trade ${tradeId}):`, fallbackErr.message);
      return { ok: false, error: fallbackErr.message };
    }
  }
}

module.exports = {
  sendNewTradeCard,
  sendTradeUpdateReply,
};

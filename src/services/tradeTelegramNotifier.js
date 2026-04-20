const { sendTelegramMessage, sendTelegramPhoto } = require('./telegramService');
const { renderTradeCardPNG } = require('./cardRenderer');
const { db } = require('../database');

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

async function persistTradeTelegramRootMeta(tradeId, meta = {}) {
  if (!tradeId) return;
  const messageId = Number(meta.telegramMessageId);
  const chatId = String(meta.telegramChatId || '').trim();
  if (!Number.isInteger(messageId)) return;
  try {
    await db.collection('trades').doc(tradeId).set(
      {
        telegramMessageId: messageId,
        ...(chatId ? { telegramChatId: chatId } : {}),
        telegramSentAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (err) {
    console.error(`Failed to persist telegram root metadata (${tradeId}):`, err.message);
  }
}

function buildTradeRootText(tradeId, trade = {}) {
  return (
    `📌 Trade Thread Root\n` +
    `Symbol: ${String(trade.symbol || '').toUpperCase()}\n` +
    `Type: ${String(trade.right || '').toUpperCase()}\n` +
    `Strike: ${trade.strike ?? '-'}\n` +
    `Exp: ${trade.expiration ?? '-'}\n` +
    `TradeId: ${tradeId}`
  );
}

async function ensureTradeTelegramRootMessage({ tradeId, trade = {}, chatId }) {
  const existingMessageId = Number(trade.telegramMessageId);
  if (Number.isInteger(existingMessageId)) {
    return {
      ok: true,
      telegramMessageId: existingMessageId,
      telegramChatId: String(trade.telegramChatId || chatId || ''),
      reused: true,
    };
  }
  if (!tradeId) return { ok: false, error: 'missing tradeId' };

  try {
    const response = await sendTelegramMessage(buildTradeRootText(tradeId, trade), {
      chatId,
      token: TELEGRAM_BOT_TOKEN_TRADES,
    });
    const meta = extractTelegramMeta(response, chatId);
    await persistTradeTelegramRootMeta(tradeId, meta);
    return { ok: true, ...meta, reused: false };
  } catch (err) {
    console.error(`Failed to create Telegram root message (${tradeId}):`, err.message);
    return { ok: false, error: err.message };
  }
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
  let resolvedTrade = trade || {};
  const initialReplyToRaw = Number(resolvedTrade?.telegramMessageId);
  const hasInitialReplyTarget = Number.isInteger(initialReplyToRaw);

  // Guard against stale in-memory trade snapshots (common in watcher ticks).
  // If reply metadata is missing in the snapshot, fetch the latest trade doc once.
  if (!hasInitialReplyTarget && tradeId) {
    try {
      const latest = await db.collection('trades').doc(tradeId).get();
      if (latest.exists) {
        // Prefer the newest persisted values (telegramMessageId/chatId) from DB.
        resolvedTrade = { ...resolvedTrade, ...latest.data() };
      }
    } catch (readErr) {
      console.error(`Failed to fetch latest trade for Telegram reply (${tradeId}):`, readErr.message);
    }
  }

  const chatId = resolveTradeChatId(resolvedTrade);
  let replyToRaw = Number(resolvedTrade?.telegramMessageId);
  let replyToMessageId = Number.isInteger(replyToRaw) ? replyToRaw : null;

  // Auto-heal legacy/open trades that never stored a root Telegram message.
  // We create one root message, persist its message_id, then reply to it.
  if (replyToMessageId === null && tradeId) {
    const rootResult = await ensureTradeTelegramRootMessage({
      tradeId,
      trade: resolvedTrade,
      chatId,
    });
    const seededReplyRaw = Number(rootResult?.telegramMessageId);
    if (Number.isInteger(seededReplyRaw)) {
      replyToRaw = seededReplyRaw;
      replyToMessageId = seededReplyRaw;
      resolvedTrade = {
        ...resolvedTrade,
        telegramMessageId: seededReplyRaw,
        telegramChatId: rootResult.telegramChatId || resolvedTrade.telegramChatId || chatId,
      };
    }
  }

  async function sendOnce(replyTo) {
    if (preferImage && ENABLE_TELEGRAM_IMAGE) {
      const cardBuffer = await renderTradeCardPNG(imagePayload || buildTradeCardPayload(resolvedTrade));
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
    const meta = extractTelegramMeta(response, chatId);
    if (replyToMessageId === null) {
      await persistTradeTelegramRootMeta(tradeId, meta);
    }
    return { ok: true, replied: replyToMessageId !== null, ...meta };
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
      const fallbackMeta = extractTelegramMeta(fallbackResponse, chatId);
      // Reply target may be stale/missing; adopt fallback message as new root for future replies.
      await persistTradeTelegramRootMeta(tradeId, fallbackMeta);
      return { ok: true, replied: false, fallbackUsed: true, ...fallbackMeta };
    } catch (fallbackErr) {
      console.error(`Telegram fallback send failed (trade ${tradeId}):`, fallbackErr.message);
      return { ok: false, error: fallbackErr.message };
    }
  }
}

module.exports = {
  ensureTradeTelegramRootMessage,
  sendNewTradeCard,
  sendTradeUpdateReply,
};

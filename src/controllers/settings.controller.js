const { db, admin } = require('../database');
const { requireFields } = require('../utils/validators');
const { encrypt } = require('../utils/crypto');

// Helper function to get server timestamp (works with both Firestore and local DB)
function getServerTimestamp() {
  if (admin && admin.firestore) {
    return admin.firestore.FieldValue.serverTimestamp();
  }
  // For local DB, return current timestamp
  return new Date().toISOString();
}

const docRef = db.collection('settings').doc('telegram');

async function getSettings(req, res, next) {
  try {
    // If env overrides exist, surface them as masked
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      return res.json({
        chatId: process.env.TELEGRAM_CHAT_ID,
        botToken: '********',
        updatedAt: null,
      });
    }

    const snap = await docRef.get();
    if (!snap.exists) return res.json({});
    const data = snap.data();
    res.json({
      chatId: data.chatId || null,
      botToken: data.botToken ? '********' : null,
      updatedAt: data.updatedAt || null,
    });
  } catch (err) {
    next(err);
  }
}

async function updateTelegram(req, res, next) {
  try {
    requireFields(req.body, ['botToken', 'chatId']);
    const encryptedToken = encrypt(req.body.botToken);
    const updates = {
      botToken: encryptedToken,
      chatId: req.body.chatId,
      updatedAt: getServerTimestamp(),
    };
    await docRef.set(updates, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { getSettings, updateTelegram };

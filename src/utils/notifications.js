const { db, admin } = require('../database');

// Helper function to get server timestamp (works with both Firestore and local DB)
function getServerTimestamp() {
  if (admin && admin.firestore) {
    return admin.firestore.FieldValue.serverTimestamp();
  }
  // For local DB, return current timestamp
  return new Date().toISOString();
}

async function logNotification({ type, message, status, meta = {} }) {
  try {
    const payload = {
      type,
      message,
      status,
      meta,
      createdAt: getServerTimestamp(),
    };
    await db.collection('notifications').add(payload);
  } catch (err) {
    console.error('Failed to log notification', err);
  }
}

module.exports = { logNotification };

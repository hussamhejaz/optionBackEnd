const crypto = require('crypto');

const algorithm = 'aes-256-gcm';
const ivLength = 12; // recommended for GCM

function getKey(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest();
}

function encrypt(text) {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error('APP_SECRET is not set');
  const iv = crypto.randomBytes(ivLength);
  const key = getKey(secret);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, authTag, encrypted]).toString('base64');
  return payload;
}

function decrypt(payload) {
  try {
    const secret = process.env.APP_SECRET;
    if (!secret) throw new Error('APP_SECRET is not set');
    const raw = Buffer.from(payload, 'base64');
    const iv = raw.subarray(0, ivLength);
    const authTag = raw.subarray(ivLength, ivLength + 16);
    const data = raw.subarray(ivLength + 16);
    if (iv.length !== ivLength || authTag.length !== 16 || data.length === 0) {
      throw new Error('Invalid encrypted payload');
    }
    const key = getKey(secret);
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error('Failed to decrypt payload');
  }
}

module.exports = { encrypt, decrypt };

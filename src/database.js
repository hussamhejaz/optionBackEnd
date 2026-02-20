const fs = require('fs');
const path = require('path');
const { LocalDatabase } = require('./localDb');

const useLocalDb = String(process.env.USE_LOCAL_DB || 'false').toLowerCase() === 'true';

if (useLocalDb) {
  console.log('Using local database for development');
  const db = new LocalDatabase();
  module.exports = { admin: null, db };
  return;
}

// Firebase initialization (only when not using local DB)
const admin = require('firebase-admin');
const { getFirestore, initializeFirestore } = require('firebase-admin/firestore');

const useEmulator = String(process.env.USE_FIRESTORE_EMULATOR).toLowerCase() === 'true';
const preferRest = String(process.env.FIRESTORE_PREFER_REST || 'false').toLowerCase() === 'true';
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;

if (preferRest && !process.env.GOOGLE_CLOUD_DISABLE_GRPC) {
  process.env.GOOGLE_CLOUD_DISABLE_GRPC = 'true';
}

if (!projectId) {
  // Without a project id Firestore cannot route requests; surface a clear error early.
  throw new Error('FIREBASE_PROJECT_ID (or GCLOUD_PROJECT/GOOGLE_CLOUD_PROJECT) is required');
}

function isValidServiceAccount(obj) {
  return obj && typeof obj.private_key === 'string' && obj.private_key.trim().startsWith('-----BEGIN');
}

function loadServiceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (isValidServiceAccount(parsed)) return parsed;
    console.warn('FIREBASE_SERVICE_ACCOUNT is present but missing private_key; ignoring.');
  } catch (err) {
    console.warn('FIREBASE_SERVICE_ACCOUNT is set but could not be parsed; ignoring.', err.message);
  }
  return null;
}

function loadServiceAccountFromFile() {
  const fileEnv = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
  const resolvedFileEnv = fileEnv ? path.resolve(process.cwd(), fileEnv) : null;
  const candidatePaths = [
    resolvedFileEnv,
    fileEnv,
    path.join(__dirname, 'serviceAccountKey.json'),
  ].filter(Boolean);

  for (const p of candidatePaths) {
    try {
      const data = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(data);
      if (isValidServiceAccount(parsed)) return parsed;
      console.warn(`Service account at ${p} is missing private_key; skipping.`);
    } catch (err) {
      // Keep trying other candidates.
    }
  }
  return null;
}

const appOptions = {};

if (useEmulator) {
  // For the emulator we only need the project id and host; no credentials required.
  process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
  appOptions.projectId = projectId;
} else {
  // Ensure we don't accidentally point to emulator if FIRESTORE_EMULATOR_HOST is set in env.
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.warn(
      'FIRESTORE_EMULATOR_HOST is set but USE_FIRESTORE_EMULATOR is not true; ignoring emulator host.'
    );
    delete process.env.FIRESTORE_EMULATOR_HOST;
  }
  // Prefer a JSON service account provided via env, otherwise fall back to ADC.
  const sa = loadServiceAccountFromEnv() || loadServiceAccountFromFile();
  if (sa) {
    appOptions.credential = admin.credential.cert(sa);
  } else {
    appOptions.credential = admin.credential.applicationDefault();
  }

  appOptions.projectId = projectId;
}


if (!admin.apps.length) {
  admin.initializeApp(appOptions);
}

const runStartupWriteCheck =
  String(process.env.FIRESTORE_STARTUP_WRITE_CHECK || 'false').toLowerCase() === 'true';

const dbSettings = {};
if (useEmulator) {
  dbSettings.host = emulatorHost;
  dbSettings.ssl = false;
}
if (preferRest) {
  dbSettings.preferRest = true;
}
const db = Object.keys(dbSettings).length
  ? initializeFirestore(admin.app(), dbSettings)
  : getFirestore(admin.app());

const configuredServicePath = process.env.FIREBASE_SERVICE_ACCOUNT_FILE
  ? path.resolve(process.cwd(), process.env.FIREBASE_SERVICE_ACCOUNT_FILE)
  : null;

console.log('Firestore mode:', useEmulator ? 'EMULATOR' : 'PRODUCTION', 'project:', projectId);
if (preferRest) {
  console.log('Firestore transport: REST preferred');
}
if (process.env.GOOGLE_CLOUD_DISABLE_GRPC === 'true') {
  console.log('Firestore gRPC disabled via GOOGLE_CLOUD_DISABLE_GRPC=true');
}
if (configuredServicePath) {
  console.log(
    'Service account file exists:',
    fs.existsSync(configuredServicePath),
    'path:',
    configuredServicePath
  );
}

if (runStartupWriteCheck) {
  db.collection('_health')
    .doc('ping')
    .set({ ok: true, at: new Date().toISOString() })
    .then(() => console.log('Firestore startup write check: OK'))
    .catch((e) => console.error('Firestore startup write check: FAILED', e.message));
}

module.exports = { admin, db };

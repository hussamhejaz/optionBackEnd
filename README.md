# options-trading-backend

Node.js + Express backend with Firebase Admin (Firestore), Telegram, ThetaData polling watcher.

## Run
1. Install deps: `npm install`
2. Configure `.env` (see below).
3. Provide Firebase credentials (`FIREBASE_SERVICE_ACCOUNT` base64/JSON or `src/serviceAccountKey.json`).
4. Start Theta Terminal v3 locally (REST at `http://127.0.0.1:25503`):
   - Ensure `GET /v3/terminal/fpss/status` returns `CONNECTED`.
5. Start dev server: `npm run dev`

## Environment
```
PORT=5000
APP_SECRET=strong_secret_used_for_crypto
TELEGRAM_API_BASE=https://api.telegram.org
THETA_BASE_URL=http://127.0.0.1:25503
ENABLE_WATCHER=true
PRICE_WATCH_INTERVAL_MS=2000
PRICE_STEP=0.10
USE_FIRESTORE_EMULATOR=false
FIREBASE_PROJECT_ID=options-dashboard-5092a
FIREBASE_SERVICE_ACCOUNT=
FIREBASE_PRIVATE_KEY=
```

## Telegram settings
- `PATCH /api/settings/telegram` with `{ "botToken": "...", "chatId": "..." }` (botToken encrypted at `settings/telegram`).
- `POST /api/telegram/test` sends “✅ Telegram connected from backend”.

## Theta test endpoints
- `GET /api/theta/status`
- `GET /api/theta/option-quote?symbol=AAPL&expiration=20250220&right=call&strike=200`

## Trades
- `POST /api/trades` body: `{ symbol, right, strike, expiration, entryPrice?, stopLoss? }`
- `GET /api/trades?status=OPEN|CLOSED`
- `PATCH /api/trades/:id/close`
- `PATCH /api/trades/:id/stoploss`

## Price Watcher
- Enabled when `ENABLE_WATCHER=true`.
- Polls Theta every `PRICE_WATCH_INTERVAL_MS`.
- Sends Telegram alerts on upward price steps of `PRICE_STEP`.

## Firestore collections
- Settings doc: `settings/telegram`
- Trades: `trades`
- Notifications: `notifications`

## Warning
- Do **not** commit `src/serviceAccountKey.json` or any real secrets to git.
# optionBackEnd

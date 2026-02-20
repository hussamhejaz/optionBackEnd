# Deploy node-canvas on Ubuntu VPS

This project uses `node-canvas` to generate PNG cards. On Ubuntu, missing native libraries/fonts can cause blank or tiny PNG output.

## 1) Install required Ubuntu packages

```bash
sudo apt update
sudo apt install -y \
  build-essential \
  libcairo2-dev \
  libpango1.0-dev \
  libjpeg-dev \
  libgif-dev \
  librsvg2-dev \
  fontconfig \
  fonts-dejavu-core
```

## 2) Clean Node install

```bash
rm -rf node_modules package-lock.json && npm ci
```

If `npm ci` fails because `package-lock.json` was removed, restore it from git and re-run:

```bash
git checkout -- package-lock.json
npm ci
```

## 3) Canvas health checks

Quick health image:

```bash
npm run health:canvas
ls -lh /tmp/canvas_health.png
file /tmp/canvas_health.png
```

Real card render check:

```bash
npm run test:card
ls -lh /tmp/card.png
file /tmp/card.png
```

Winning-ad variant check:

```bash
npm run test:card -- --winning
```

## 4) HTTP binary check

Run the server and verify binary-safe response:

```bash
curl -i http://127.0.0.1:5001/debug/card.png -o /tmp/debug_card_response.png
file /tmp/debug_card_response.png
```

Expected result:
- `Content-Type: image/png`
- non-trivial file size (usually much larger than a few KB)

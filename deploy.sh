#!/bin/bash
# UWR Diary — deploy Firebase Hostingiin
# Käyttö: ./deploy.sh
# Refreshaa firebase-tools OAuth-tokenin automaattisesti ennen deployta.

set -e

PROJECT_DIR="/Users/janne.lind/Documents/My Apps/Uppis"
FIREBASE_CONFIG="$HOME/.config/configstore/firebase-tools.json"

cd "$PROJECT_DIR"

# ── Refresh OAuth-token ────────────────────────────────────────
node - <<'EOF'
const fs   = require('fs');
const https = require('https');

const configPath = process.env.HOME + '/.config/configstore/firebase-tools.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const refreshToken = config?.tokens?.refresh_token;
if (!refreshToken) { console.log('⚠️  Ei refresh_tokenia — ohitetaan token-refresh'); process.exit(0); }

// Tarkista onko access_token vielä voimassa (5 min buffer)
const expiresAt = config?.tokens?.expires_at || 0;
if (Date.now() < expiresAt - 5 * 60 * 1000) {
  console.log('✅ Token voimassa, ei tarvetta refreshata');
  process.exit(0);
}

console.log('🔄 Refreshataan Firebase-token...');

const body = new URLSearchParams({
  client_id:     '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
  client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
  grant_type:    'refresh_token',
  refresh_token: refreshToken,
}).toString();

const req = https.request({
  hostname: 'oauth2.googleapis.com',
  path:     '/token',
  method:   'POST',
  headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    if (!json.access_token) {
      console.error('❌ Token-refresh epäonnistui:', data);
      process.exit(1);
    }
    config.tokens.access_token = json.access_token;
    config.tokens.expires_at   = Date.now() + json.expires_in * 1000;
    if (json.refresh_token) config.tokens.refresh_token = json.refresh_token;
    fs.writeFileSync(configPath, JSON.stringify(config, null, '\t'));
    console.log('✅ Token refreshattu onnistuneesti');
  });
});

req.on('error', (e) => { console.error('❌ Verkkovirhe:', e.message); process.exit(1); });
req.write(body);
req.end();
EOF

# ── Git: commit, tag, push ─────────────────────────────────────
# Luetaan SW-versio (esim. "v177" → git tag "deploy-v177")
SW_VERSION=$(grep -m1 'CACHE_NAME' sw.js | grep -o 'v[0-9]*' | head -1)
DEPLOY_TAG="deploy-${SW_VERSION}"

echo "📦 Commitataan muutokset (${DEPLOY_TAG})..."
git add -A
git commit -m "deploy: ${DEPLOY_TAG}" || echo "ℹ️  Ei uusia muutoksia commitoitavaksi"

# Tagi (force: päivitetään jos sama versio deployataan uudelleen)
git tag -f "${DEPLOY_TAG}"
echo "🏷️  Tagi asetettu: ${DEPLOY_TAG}"

# Push (ei blokkaa deployta jos GitHub ei tavoitettavissa)
echo "⬆️  Pushataan GitHubiin..."
if git push origin main --tags --force-with-lease 2>/dev/null; then
  echo "✅ GitHub-push onnistui"
else
  echo "⚠️  GitHub-push epäonnistui — deploy jatkuu silti"
fi

# ── Deploy ─────────────────────────────────────────────────────
echo "🚀 Deployataan Firebase Hostingiin..."
firebase deploy --only hosting

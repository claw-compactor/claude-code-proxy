#\!/usr/bin/env bash
set -euo pipefail

# ── AIMM Dashboard Deployment Script ──────────────────────────────────────────
# Builds the Next.js app locally, rsyncs to aimm-prod, and starts with PM2.
#
# Usage:
#   ./deploy.sh          # Full build + deploy
#   ./deploy.sh --skip-build   # rsync + restart only (if already built)

REMOTE_USER="ubuntu"
REMOTE_HOST="172.31.33.149"
SSH_KEY="$HOME/.ssh/id_ed25519_clawdbot"
REMOTE_DIR="/home/ubuntu/aimm-dashboard"
APP_NAME="aimm-dashboard"
PORT=3000

SKIP_BUILD=false
if [[ "${1:-}" == "--skip-build" ]]; then
  SKIP_BUILD=true
fi

echo "=== AIMM Dashboard Deploy ==="
echo "Target: ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}"
echo ""

# ── Step 1: Build ──
if [[ "$SKIP_BUILD" == false ]]; then
  echo "[1/4] Building Next.js app..."
  npm run build
  echo "Build complete."
else
  echo "[1/4] Skipping build (--skip-build)"
fi

# ── Step 2: rsync to aimm-prod ──
echo "[2/4] Syncing to aimm-prod..."
rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.github' \
  --exclude='out' \
  --exclude='.env.local' \
  -e "ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no" \
  ./ "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"

# Copy .env.local separately (not deleted by --delete)
echo "  Syncing .env.local..."
scp -i "${SSH_KEY}" -o StrictHostKeyChecking=no \
  .env.local "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/.env.local"

echo "Sync complete."

# ── Step 3: Install dependencies on remote ──
echo "[3/4] Installing dependencies on remote..."
ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no "${REMOTE_USER}@${REMOTE_HOST}" << REMOTECMD
  cd ${REMOTE_DIR}
  export PATH="\$HOME/.nvm/versions/node/*/bin:\$PATH:/usr/local/bin"
  
  # Install node if not present
  if \! command -v node &>/dev/null; then
    echo "Node.js not found. Installing via nvm..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="\$HOME/.nvm"
    [ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
    nvm install 20
  fi
  
  npm install --production
  echo "Dependencies installed."
REMOTECMD

# ── Step 4: Start/restart with PM2 ──
echo "[4/4] Starting app with PM2..."
ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no "${REMOTE_USER}@${REMOTE_HOST}" << REMOTECMD
  cd ${REMOTE_DIR}
  export PATH="\$HOME/.nvm/versions/node/*/bin:\$PATH:/usr/local/bin"
  export NVM_DIR="\$HOME/.nvm"
  [ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
  
  # Install PM2 if not present
  if \! command -v pm2 &>/dev/null; then
    npm install -g pm2
  fi
  
  # Stop existing instance if running
  pm2 delete ${APP_NAME} 2>/dev/null || true
  
  # Start with PM2
  pm2 start npm --name "${APP_NAME}" -- start -- -p ${PORT}
  pm2 save
  
  echo ""
  echo "=== Dashboard is live ==="
  echo "  URL: http://${REMOTE_HOST}:${PORT}"
  echo "  PM2: pm2 logs ${APP_NAME}"
  echo ""
  pm2 status
REMOTECMD

echo ""
echo "Deploy complete\! Dashboard: http://${REMOTE_HOST}:${PORT}"

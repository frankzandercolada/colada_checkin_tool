#!/usr/bin/env bash
# =============================================================================
#  Colada365 Check-in Tool — Automated Deployment Script
#  Source: https://github.com/frankzandercolada/colada_checkin_tool
#
#  Usage — two options:
#
#  A) One-liner (no prior download needed):
#     curl -fsSL https://raw.githubusercontent.com/frankzandercolada/colada_checkin_tool/main/deploy.sh | bash
#
#  B) Clone first, then run:
#     git clone https://github.com/frankzandercolada/colada_checkin_tool.git
#     cd colada_checkin_tool
#     chmod +x deploy.sh && ./deploy.sh
#
#  Environment overrides (set before running):
#     HOSTNAME=c365ci.local   ./deploy.sh
#     INSTALL_DIR=~/myapp     ./deploy.sh
#
#  Supported OS: Raspberry Pi OS (Bookworm/Bullseye), Ubuntu 22.04+, Debian 12+
# =============================================================================
set -euo pipefail

REPO_URL="https://github.com/frankzandercolada/colada_checkin_tool.git"

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()      { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
section() { echo -e "\n${BOLD}${BLUE}══ $* ══${NC}"; }

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e "${BOLD}"
echo "  ╔═══════════════════════════════════════════════╗"
echo "  ║     Colada365 Check-in Tool — Deployment      ║"
echo "  ╚═══════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Sanity checks ─────────────────────────────────────────────────────────────
if [ "$EUID" -eq 0 ]; then
  error "Do not run this script as root. Run as your regular user (sudo will be called when needed)."
  exit 1
fi
if ! command -v sudo &>/dev/null; then
  error "sudo is required but not found."
  exit 1
fi

# ── Configuration ─────────────────────────────────────────────────────────────
section "Configuration"

INSTALL_DIR="${INSTALL_DIR:-/home/$(whoami)/colada_checkin_tool}"
HOSTNAME="${HOSTNAME:-checkin.local}"
GIT_BRANCH="${GIT_BRANCH:-main}"
APP_PORT="${APP_PORT:-3000}"
PM2_NAME="${PM2_NAME:-colada365}"

# Auto-detect fresh install vs update
if [ -d "$INSTALL_DIR/.git" ]; then
  IS_FRESH=false
else
  IS_FRESH=true
fi

echo "  Repo              : ${BOLD}$REPO_URL${NC}"
echo "  Branch            : ${BOLD}$GIT_BRANCH${NC}"
echo "  Install directory : ${BOLD}$INSTALL_DIR${NC}"
echo "  Hostname          : ${BOLD}$HOSTNAME${NC}"
echo "  App port          : ${BOLD}$APP_PORT${NC}"
echo "  PM2 name          : ${BOLD}$PM2_NAME${NC}"
echo "  Mode              : ${BOLD}$( [ "$IS_FRESH" = true ] && echo 'Fresh install' || echo 'Update existing' )${NC}"
echo ""
read -rp "$(echo -e "${YELLOW}Continue? [y/N]${NC} ")" CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { info "Aborted."; exit 0; }

# ── System packages ───────────────────────────────────────────────────────────
section "Updating system packages"
sudo apt-get update -qq
ok "Package list updated"

# ── Git ───────────────────────────────────────────────────────────────────────
section "Git"
if ! command -v git &>/dev/null; then
  info "Installing git..."
  sudo apt-get install -y git 2>/dev/null
fi
ok "git $(git --version | awk '{print $3}') available"

# ── Node.js ───────────────────────────────────────────────────────────────────
section "Node.js"
NODE_MIN=20
INSTALL_NODE=false
if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.stdout.write(String(process.version.split('.')[0].slice(1)))")
  if [ "$NODE_VER" -ge "$NODE_MIN" ]; then
    ok "Node.js $(node -v) already installed"
  else
    warn "Node.js $(node -v) too old (need v${NODE_MIN}+). Upgrading..."
    INSTALL_NODE=true
  fi
else
  info "Node.js not found. Installing v${NODE_MIN}..."
  INSTALL_NODE=true
fi
if [ "$INSTALL_NODE" = true ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN}.x" | sudo -E bash - 2>/dev/null
  sudo apt-get install -y nodejs 2>/dev/null
  ok "Node.js $(node -v) installed"
fi

# ── PM2 ───────────────────────────────────────────────────────────────────────
section "PM2"
if command -v pm2 &>/dev/null; then
  ok "PM2 $(pm2 -v) already installed"
else
  info "Installing PM2..."
  sudo npm install -g pm2 2>/dev/null
  ok "PM2 $(pm2 -v) installed"
fi

# ── Caddy ─────────────────────────────────────────────────────────────────────
section "Caddy (HTTPS)"
if command -v caddy &>/dev/null; then
  ok "Caddy $(caddy version 2>/dev/null | head -1) already installed"
else
  info "Installing Caddy..."
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl 2>/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq 2>/dev/null
  sudo apt-get install -y caddy 2>/dev/null
  ok "Caddy installed"
fi

# ── OpenSSL ───────────────────────────────────────────────────────────────────
if ! command -v openssl &>/dev/null; then
  sudo apt-get install -y openssl 2>/dev/null
fi

# ── Clone or update repository ────────────────────────────────────────────────
section "Application code"

if [ "$IS_FRESH" = true ]; then
  info "Cloning $REPO_URL (branch: $GIT_BRANCH)..."
  [ -d "$INSTALL_DIR" ] && rm -rf "$INSTALL_DIR"
  git clone --branch "$GIT_BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  ok "Repository cloned to $INSTALL_DIR"
else
  info "Pulling latest $GIT_BRANCH from origin..."
  cd "$INSTALL_DIR"
  git fetch origin "$GIT_BRANCH"
  git reset --hard "origin/$GIT_BRANCH"
  ok "Repository updated"
fi

cd "$INSTALL_DIR"

# ── Preserve data directory ───────────────────────────────────────────────────
# data/ is in .gitignore — git never modifies it
mkdir -p "$INSTALL_DIR/data/projects"

# ── .env ──────────────────────────────────────────────────────────────────────
section "Environment"
ENV_FILE="$INSTALL_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  ok ".env already exists — leaving untouched"
else
  if [ -f "$INSTALL_DIR/.env.example" ]; then
    cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
  else
    cat > "$ENV_FILE" << 'ENVEOF'
# Uncomment and set to enable basic auth on the admin UI
# APP_USER=admin
# APP_PASSWORD=change-me
# PORT=3000
ENVEOF
  fi
  warn ".env created. Edit $ENV_FILE to set a password before going live."
fi

# ── data/config.json ─────────────────────────────────────────────────────────
CONFIG_FILE="$INSTALL_DIR/data/config.json"
if [ -f "$CONFIG_FILE" ]; then
  ok "data/config.json exists — leaving untouched"
else
  cat > "$CONFIG_FILE" << 'CFGEOF'
{
  "clientId": "",
  "clientSecret": "",
  "tokenUrl": "https://auth.colada365.com/oauth/token",
  "apiBase": "https://admin.colada365.com",
  "activeProjectId": null
}
CFGEOF
  warn "data/config.json created with empty credentials."
  warn "Enter your Colada365 API credentials in the admin UI → Settings."
fi

# ── npm install ───────────────────────────────────────────────────────────────
section "npm install"
cd "$INSTALL_DIR"
npm install --omit=dev 2>/dev/null
ok "Dependencies installed"

# ── Caddy config ─────────────────────────────────────────────────────────────
section "Caddy configuration"
CADDYFILE="/etc/caddy/Caddyfile"
if sudo grep -q "$HOSTNAME" "$CADDYFILE" 2>/dev/null; then
  ok "Caddyfile already references $HOSTNAME — leaving untouched"
else
  sudo tee "$CADDYFILE" > /dev/null << CADDYEOF
${HOSTNAME} {
    reverse_proxy localhost:${APP_PORT}
    tls internal
}
CADDYEOF
  ok "Caddyfile written"
fi

sudo systemctl enable caddy 2>/dev/null
sudo systemctl restart caddy
info "Waiting for Caddy TLS cert generation..."
sleep 4

# ── Export iOS root CA cert ───────────────────────────────────────────────────
section "iOS root CA certificate"
CERT_PATH=""
for TRY in \
  "/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt" \
  "/root/.local/share/caddy/pki/authorities/local/root.crt" \
  "/data/caddy/pki/authorities/local/root.crt"; do
  if sudo test -f "$TRY" 2>/dev/null; then
    CERT_PATH="$TRY"
    break
  fi
done

if [ -n "$CERT_PATH" ]; then
  # iOS needs DER binary format (.cer), not PEM text
  sudo openssl x509 -in "$CERT_PATH" -outform DER \
    -out "$INSTALL_DIR/public/caddy-root.cer"
  sudo cp "$CERT_PATH" "$INSTALL_DIR/public/caddy-root.crt"
  sudo chown "$(whoami):$(whoami)" \
    "$INSTALL_DIR/public/caddy-root.cer" \
    "$INSTALL_DIR/public/caddy-root.crt"
  sudo chmod 644 \
    "$INSTALL_DIR/public/caddy-root.cer" \
    "$INSTALL_DIR/public/caddy-root.crt"
  ok "Root CA exported → $INSTALL_DIR/public/caddy-root.cer"
else
  warn "Caddy root cert not found yet — try again in a few seconds:"
  warn "  sudo find /var/lib/caddy -name 'root.crt' -exec \\"
  warn "    openssl x509 -in {} -outform DER -out $INSTALL_DIR/public/caddy-root.cer \\;"
fi

# ── PM2 start / reload ───────────────────────────────────────────────────────
section "PM2"
cd "$INSTALL_DIR"
if pm2 list 2>/dev/null | grep -q "$PM2_NAME"; then
  pm2 reload "$PM2_NAME"
  ok "PM2 process '$PM2_NAME' reloaded"
else
  pm2 start server/index.js --name "$PM2_NAME" --cwd "$INSTALL_DIR" \
    --node-args="--max-old-space-size=256"
  ok "PM2 process '$PM2_NAME' started"
fi
pm2 save

if [ "$IS_FRESH" = true ]; then
  STARTUP_CMD=$(pm2 startup 2>&1 | grep "sudo env" | head -1)
  if [ -n "$STARTUP_CMD" ]; then
    eval "$STARTUP_CMD"
    ok "PM2 startup on boot configured"

    # ── Patch PM2 systemd unit to wait for NTP time sync ─────────────────────
    # Raspberry Pi has no hardware RTC — without this, the app starts before
    # the clock is set, causing TLS cert validation failures (SEC_ERROR_UNKNOWN_ISSUER).
    PM2_SERVICE=$(systemctl list-unit-files 'pm2-*.service' 2>/dev/null | awk '/pm2-/{print $1}' | head -1)
    if [ -n "$PM2_SERVICE" ]; then
      PM2_SERVICE_FILE="/etc/systemd/system/${PM2_SERVICE}"
      if [ -f "$PM2_SERVICE_FILE" ]; then
        # Add time-sync.target and network-online.target to After= if not already present
        if ! grep -q "time-sync.target" "$PM2_SERVICE_FILE"; then
          sudo sed -i 's/^After=\(.*\)/After=\1 time-sync.target network-online.target/' "$PM2_SERVICE_FILE"
          sudo sed -i '/^\[Unit\]/a Wants=time-sync.target network-online.target' "$PM2_SERVICE_FILE"
          sudo systemctl daemon-reload
          ok "PM2 service patched to wait for NTP time sync before starting"
        else
          ok "PM2 service already waits for time-sync.target"
        fi
      fi
    else
      warn "Could not find PM2 systemd service — run manually after reboot if clock issues persist"
    fi
  else
    warn "Run 'pm2 startup' manually to enable start-on-boot."
  fi
fi

# ── Health check ──────────────────────────────────────────────────────────────
section "Health check"

# Ensure PM2 systemd unit waits for NTP on every deploy (idempotent patch).
# Raspberry Pi has no RTC — without this, cold boots fail with TLS cert errors.
PM2_SERVICE=$(systemctl list-unit-files 'pm2-*.service' 2>/dev/null | awk '/pm2-/{print $1}' | head -1)
if [ -n "$PM2_SERVICE" ]; then
  PM2_SERVICE_FILE="/etc/systemd/system/${PM2_SERVICE}"
  if [ -f "$PM2_SERVICE_FILE" ] && ! grep -q "time-sync.target" "$PM2_SERVICE_FILE"; then
    sudo sed -i 's/^After=\(.*\)/After=\1 time-sync.target network-online.target/' "$PM2_SERVICE_FILE"
    sudo sed -i '/^\[Unit\]/a Wants=time-sync.target network-online.target' "$PM2_SERVICE_FILE"
    sudo systemctl daemon-reload
    ok "PM2 service patched to wait for NTP time sync"
  fi
fi
sleep 2
if curl -sf "http://localhost:${APP_PORT}/api/config" > /dev/null 2>&1; then
  ok "App responding on http://localhost:${APP_PORT}"
else
  warn "App not responding yet. Check: pm2 logs $PM2_NAME"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║                 Deployment complete!                      ║${NC}"
echo -e "${BOLD}${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Admin UI   ${NC}→  https://${HOSTNAME}"
echo -e "  ${BOLD}Kiosk      ${NC}→  https://${HOSTNAME}/kiosk"
echo -e "  ${BOLD}Logs       ${NC}→  pm2 logs ${PM2_NAME}"
echo -e "  ${BOLD}Status     ${NC}→  pm2 status"
echo ""

if [ -f "$INSTALL_DIR/public/caddy-root.cer" ]; then
echo -e "  ${BOLD}${YELLOW}iOS Camera — one-time cert trust per device:${NC}"
echo -e "  1. Open Safari → ${CYAN}https://${HOSTNAME}/caddy-root.cer${NC}"
echo -e "  2. Allow → Settings → VPN & Device Management → Install"
echo -e "  3. Settings → About → Certificate Trust Settings → Enable"
echo -e "  4. After all devices enrolled, remove the cert files:"
echo -e "     ${YELLOW}rm $INSTALL_DIR/public/caddy-root.{cer,crt} && pm2 reload $PM2_NAME${NC}"
echo ""
fi

echo -e "  ${BOLD}First-time setup:${NC}"
echo -e "  1. Open Settings in the admin UI"
echo -e "  2. Enter Colada365 OAuth2 credentials"
echo -e "  3. Create a project + set Event ID"
echo ""
echo -e "  ${BOLD}To update later:${NC}"
echo -e "  ${CYAN}curl -fsSL https://raw.githubusercontent.com/frankzandercolada/colada_checkin_tool/main/deploy.sh | bash${NC}"
echo ""

echo -e "  ${BOLD}Raspberry Pi kiosk autostart${NC} (/etc/xdg/autostart/kiosk.desktop):"
echo -e "  ${CYAN}[Desktop Entry]"
echo -e "  Type=Application"
echo -e "  Name=Kiosk"
echo -e "  Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars \\"
echo -e "    --ignore-certificate-errors --ignore-ssl-errors \\"
echo -e "    https://${HOSTNAME}/kiosk/YOUR_STATION_ID${NC}"
echo ""

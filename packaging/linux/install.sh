#!/usr/bin/env bash
# colada365 Check-in — Linux installer
# Installs the self-contained binary as a systemd service.
# Usage: sudo ./install.sh          (install or upgrade)
#        sudo ./install.sh --port 8080
set -euo pipefail

BIN_DIR=/opt/colada-checkin
DATA_DIR=/var/lib/colada-checkin
ENV_FILE=/etc/default/colada-checkin
UNIT_FILE=/etc/systemd/system/colada-checkin.service
SVC_USER=colada-checkin
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT=3000

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root:  sudo $0"
  exit 1
fi
if [ ! -f "$HERE/colada-checkin" ]; then
  echo "colada-checkin binary not found next to install.sh"
  exit 1
fi

echo "→ Installing binary to $BIN_DIR"
mkdir -p "$BIN_DIR"
# Stop a running service before replacing the binary (upgrade path)
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet colada-checkin 2>/dev/null; then
  systemctl stop colada-checkin
fi
install -m 0755 "$HERE/colada-checkin" "$BIN_DIR/colada-checkin"

echo "→ Creating service user + data dir ($DATA_DIR)"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$DATA_DIR" "$SVC_USER"
mkdir -p "$DATA_DIR"
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"

# Port config — created once, preserved on upgrades
if [ ! -f "$ENV_FILE" ]; then
  echo "PORT=$PORT" > "$ENV_FILE"
  echo "→ Wrote $ENV_FILE (PORT=$PORT)"
else
  echo "→ Keeping existing $ENV_FILE"
fi

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  echo "→ Installing systemd service"
  install -m 0644 "$HERE/colada-checkin.service" "$UNIT_FILE"
  systemctl daemon-reload
  systemctl enable --now colada-checkin
  sleep 1
  systemctl --no-pager --lines=3 status colada-checkin || true
  echo ""
  echo "✅ Installed. Open http://$(hostname -I 2>/dev/null | awk '{print $1}'):$(grep -oP 'PORT=\K.*' "$ENV_FILE" 2>/dev/null || echo "$PORT")"
  echo "   Data lives in $DATA_DIR (backups: export projects from the app, or copy this dir)"
  echo "   Logs:    journalctl -u colada-checkin -f"
  echo "   Upgrade: re-run this installer from a newer package"
else
  echo ""
  echo "⚠ systemd not available — service not registered."
  echo "  Run manually with:"
  echo "  CHECKIN_DATA_DIR=$DATA_DIR PORT=$PORT $BIN_DIR/colada-checkin"
fi

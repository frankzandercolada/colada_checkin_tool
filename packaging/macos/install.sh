#!/usr/bin/env bash
# colada365 Check-in — macOS installer (per-user, no sudo needed)
# Installs the binary + a LaunchAgent so the server starts at login.
# Usage: ./install.sh [--port 3000]
set -euo pipefail

APP_DIR="$HOME/Library/Application Support/colada-checkin"
BIN="$APP_DIR/colada-checkin"
DATA_DIR="$APP_DIR/data"
PLIST="$HOME/Library/LaunchAgents/com.colada.checkin.plist"
LABEL=com.colada.checkin
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT=3000

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

if [ ! -f "$HERE/colada-checkin" ]; then
  echo "colada-checkin binary not found next to install.sh"; exit 1
fi

echo "→ Installing to $APP_DIR"
mkdir -p "$DATA_DIR" "$HOME/Library/LaunchAgents"
# Stop a running instance before replacing the binary (upgrade path)
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
install -m 0755 "$HERE/colada-checkin" "$BIN"
# Strip the quarantine flag Safari puts on downloaded archives
xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CHECKIN_DATA_DIR</key><string>$DATA_DIR</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP_DIR/colada-checkin.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/colada-checkin.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
echo ""
echo "✅ Installed and started."
echo "   App:  http://localhost:$PORT"
echo "   Data: $DATA_DIR"
echo "   Log:  $APP_DIR/colada-checkin.log"
echo "   The server starts automatically at login. Uninstall with ./uninstall.sh"

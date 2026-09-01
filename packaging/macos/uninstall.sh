#!/usr/bin/env bash
# colada365 Check-in — macOS uninstaller. Data is KEPT unless you pass --purge.
set -euo pipefail
APP_DIR="$HOME/Library/Application Support/colada-checkin"
PLIST="$HOME/Library/LaunchAgents/com.colada.checkin.plist"
launchctl bootout "gui/$(id -u)/com.colada.checkin" 2>/dev/null || true
rm -f "$PLIST" "$APP_DIR/colada-checkin" "$APP_DIR/colada-checkin.log"
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$APP_DIR"
  echo "✅ Uninstalled (including data)."
else
  echo "✅ Uninstalled. Data kept in $APP_DIR/data (remove with --purge)."
fi

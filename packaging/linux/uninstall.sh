#!/usr/bin/env bash
# colada365 Check-in — Linux uninstaller.
# Removes binary + service. Data in /var/lib/colada-checkin is KEPT unless
# you pass --purge.
set -euo pipefail
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root:  sudo $0"
  exit 1
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now colada-checkin 2>/dev/null || true
  rm -f /etc/systemd/system/colada-checkin.service
  systemctl daemon-reload
fi
rm -rf /opt/colada-checkin
rm -f /etc/default/colada-checkin
if [ "$PURGE" -eq 1 ]; then
  rm -rf /var/lib/colada-checkin
  userdel colada-checkin 2>/dev/null || true
  echo "✅ Uninstalled (including data)."
else
  echo "✅ Uninstalled. Data kept in /var/lib/colada-checkin (remove with --purge)."
fi

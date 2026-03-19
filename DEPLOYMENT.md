# Colada365 Check-in Tool — Deployment Guide

## Overview

The deployment script (`deploy.sh`) fully automates installation of the Colada365 Check-in Tool on any fresh Raspberry Pi OS, Ubuntu 22.04+, or Debian 12+ host. It clones the application directly from GitHub, installs all required components, configures HTTPS via Caddy, starts the app under PM2, and exports the root CA certificate needed for iOS camera scanning.

---

## Device Overview

| Device | URL | Why |
|--------|-----|-----|
| **Raspberry Pi kiosk** (hardware scanner) | `http://c365ci.local:3000/kiosk/...` | HTTP on port 3000 — no cert needed, no flags, works out of the box |
| **iPhone / iPad** (camera mode) | `https://c365ci.local/kiosk/...` | HTTPS via Caddy required for `getUserMedia` camera access |
| **Admin UI** (any browser) | `https://c365ci.local` | HTTPS via Caddy |

Raspberry Pi kiosks use hardware barcode scanners so they don't need camera access — plain HTTP on port 3000 works perfectly. iPhones and iPads use the camera and must go through HTTPS.

---

## What the Script Does

| Step | Action |
|------|--------|
| 1 | Installs git, Node.js 20, PM2, Caddy, and OpenSSL if not already present |
| 2 | Clones the repo from GitHub (or pulls latest on re-run) |
| 3 | Creates `.env` and `data/config.json` if they don't exist |
| 4 | Runs `npm install` |
| 5 | Writes the Caddyfile and starts Caddy with a local HTTPS cert |
| 6 | Converts the Caddy root cert to DER format for iOS enrollment |
| 7 | Starts the app under PM2 and configures start-on-boot |

On re-runs the script is safe — it never overwrites `.env`, `data/config.json`, or the `data/` directory. It pulls the latest code and does a zero-downtime PM2 reload.

---

## Prerequisites

- A machine running **Raspberry Pi OS**, **Ubuntu 22.04+**, or **Debian 12+**
- A user account with **sudo** rights (do not run as root)
- **Internet access** during installation

That's all — git, Node.js, PM2, and Caddy are installed by the script if missing.

---

## Option A — One-liner (recommended)

No prior download needed. Run this on the host machine:

```bash
curl -fsSL https://raw.githubusercontent.com/frankzandercolada/colada_checkin_tool/main/deploy.sh | bash
```

This downloads and runs the script in a single command.

> **Note:** When piping to bash, you can't interactively set variables. To use a custom hostname, set it inline:
> ```bash
> curl -fsSL https://raw.githubusercontent.com/frankzandercolada/colada_checkin_tool/main/deploy.sh \
>   | HOSTNAME=c365ci.local bash
> ```

---

## Option B — Clone then run

```bash
git clone https://github.com/frankzandercolada/colada_checkin_tool.git
cd colada_checkin_tool
chmod +x deploy.sh
./deploy.sh
```

This gives you an interactive prompt before anything is installed.

---

## Configuration Options

Override any of these with environment variables before running:

| Variable | Default | Description |
|----------|---------|-------------|
| `HOSTNAME` | `checkin.local` | The mDNS / DNS hostname Caddy serves on |
| `INSTALL_DIR` | `~/colada_checkin_tool` | Where the app is installed |
| `GIT_BRANCH` | `main` | Branch or tag to deploy |
| `APP_PORT` | `3000` | Internal Node.js port (Caddy proxies to this) |
| `PM2_NAME` | `colada365` | PM2 process name |

Examples:

```bash
# Custom hostname
HOSTNAME=c365ci.local ./deploy.sh

# Custom install directory and branch
INSTALL_DIR=/opt/checkin GIT_BRANCH=v2.0 ./deploy.sh
```

---

## Raspberry Pi Kiosk Setup

Raspberry Pi kiosks use a hardware barcode scanner, not the camera, so they don't need HTTPS. Point Chromium directly at port 3000 over plain HTTP — no certificate installation, no special flags.

Create `/etc/xdg/autostart/kiosk.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=Kiosk
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars \
  --check-for-update-interval=31536000 \
  http://c365ci.local:3000/kiosk/YOUR_STATION_ID
```

Replace `c365ci.local` with your server hostname and `YOUR_STATION_ID` with the station UUID from the admin UI.

> **Why port 3000 and not 443?** Chromium blocks HTTPS pages with self-signed certificates by default. Routing the Pi kiosks through plain HTTP on port 3000 avoids the cert issue entirely. iPhones and iPads (camera mode) still use HTTPS via Caddy on port 443.

---

## iOS Camera Setup (one-time per device)

For iPhone and iPad camera scanning to work, each device must trust Caddy's root certificate. Do this once per device — it survives app updates.

### Step 1 — Open the cert in Safari

On the iPhone or iPad open **Safari** (not Chrome) and navigate to:

```
https://checkin.local/caddy-root.cer
```

> Replace `checkin.local` with your actual hostname if you changed it.

### Step 2 — Install the profile

Tap **Allow** when Safari asks to download a configuration profile.

### Step 3 — Install in Settings

1. Open **Settings**
2. Tap the banner at the top: **Profile Downloaded**
3. Tap **Install** (top right)
4. Enter your device passcode
5. Tap **Install** again to confirm

### Step 4 — Enable full trust

1. **Settings → General → About**
2. Scroll to bottom → **Certificate Trust Settings**
3. Find **Caddy Local Authority** → toggle **on**
4. Tap **Continue**

Camera scanning now works on this device.

### Step 5 — Remove the cert file after enrollment

```bash
rm ~/colada_checkin_tool/public/caddy-root.cer
rm ~/colada_checkin_tool/public/caddy-root.crt
pm2 reload colada365
```

---

## First-time App Setup

After deployment, open the admin UI in a browser:

```
https://checkin.local
```

Go to **Settings** and enter your Colada365 OAuth2 credentials:

- Client ID
- Client Secret
- Token URL
- API Base URL
- Event ID

Then create a project, configure badge templates, and set up kiosk stations.

---

## Updating to a Newer Version

Simply re-run the deploy script — it detects the existing installation, pulls the latest code, and does a zero-downtime reload:

```bash
# One-liner update
curl -fsSL https://raw.githubusercontent.com/frankzandercolada/colada_checkin_tool/main/deploy.sh | bash
```

Or if you have the repo already cloned:

```bash
cd ~/colada_checkin_tool
git pull
pm2 reload colada365
```

Your credentials, badge templates, kiosk stations, and background images in `data/` are never touched.

---

## Useful Commands

```bash
# Live logs
pm2 logs colada365

# Last 100 log lines
pm2 logs colada365 --lines 100

# Process status
pm2 status

# Restart app
pm2 restart colada365

# Zero-downtime reload (after code update)
pm2 reload colada365

# Caddy status
sudo systemctl status caddy
sudo journalctl -u caddy -f

# Reload Caddy config
sudo systemctl reload caddy
```

---

## Directory Structure After Deployment

```
~/colada_checkin_tool/        ← cloned from GitHub
├── server/
│   └── index.js              # Application server
├── public/
│   ├── index.html            # Admin UI
│   ├── kiosk.html            # Kiosk display
│   └── styles.css            # Shared styles
├── data/                     # Persistent data — NOT in git, never overwritten
│   ├── config.json           # Global credentials + active project
│   ├── projects.json         # Project list
│   └── projects/{id}/
│       ├── badge-config.json
│       ├── kiosk-stations.json
│       └── badge-images/
├── .env                      # Secrets — NOT in git, never overwritten
├── deploy.sh                 # This script
└── package.json
```

---

## Troubleshooting

### "Page not found" for caddy-root.cer

The cert file wasn't exported. Find and convert it manually:

```bash
sudo find /var/lib/caddy -name "root.crt"
# Then (replace path with the result above):
sudo openssl x509 \
  -in /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt \
  -outform DER \
  -out ~/colada_checkin_tool/public/caddy-root.cer
sudo chmod 644 ~/colada_checkin_tool/public/caddy-root.cer
```

### "Invalid profile" on iOS

Make sure you're using `/caddy-root.cer` (DER format), not `/caddy-root.crt` (PEM). iOS Safari requires DER.

### App not starting

```bash
pm2 logs colada365 --lines 50
```

Common causes:
- Port 3000 already in use → set `APP_PORT=3001` before running the script
- Missing `node_modules` → run `npm install` in `~/colada_checkin_tool`

### Caddy not starting

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo journalctl -u caddy --no-pager -n 30
```

### Camera not working on iOS after cert trust

- Confirm you're on **HTTPS** (`https://` not `http://`)
- Confirm you completed the full trust step in Certificate Trust Settings (toggle must be ON)
- Try a hard reload: hold the reload button in Safari → **Reload Without Content Blockers**

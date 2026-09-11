# Colada365 Check-in Tool

A self-hosted event check-in and badge printing system for Colada365 events. It provides an admin web UI for operators and a full-screen kiosk mode for self-service guest check-in at event entrances.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Projects](#projects)
5. [Badge Templates & Routing Rules](#badge-templates--routing-rules)
6. [Kiosk Stations](#kiosk-stations)
7. [API Reference](#api-reference)
8. [Deployment](#deployment)

---

## Quick Start

# clone repository

git clone https://github.com/frankzandercolada/colada_checkin_tool.git

cd colada_checkin_tool/
```bash
# 1. Install dependencies
cd server
npm install

# 2. Copy and edit environment file (optional)
cp .env.example .env
# Set APP_USER and APP_PASSWORD for basic auth

# 3. Start the server
node index.js
# → Listening on http://localhost:3000

# 4. Open the admin UI
open http://localhost:3000
```

# 1. Install PM2 globally
npm install -g pm2

# 2. Start the app
pm2 start /path/to/server/index.js --name colada365

# 3. Save the process list
pm2 save

# 4. Register PM2 to start on boot (run the command it outputs)
pm2 startup

pm2 status          # see if it's running
pm2 logs colada365  # live logs
pm2 restart colada365
pm2 stop colada365

---

## Folder Structure

```
project-root/
├── server/
│   └── index.js              # Express backend — all API routes
│
├── public/
│   ├── index.html            # Admin SPA (single-page app)
│   └── kiosk.html            # Kiosk display (full-screen, portrait)
│
├── data/
│   ├── config.json           # Global/fallback API credentials + active project ID
│   ├── projects.json         # List of all project records (id, name, eventId, creds…)
│   └── projects/
│       └── {projectId}/
│           ├── badge-config.json     # Templates, routing rules, fallback key
│           ├── kiosk-stations.json   # Kiosk station configs for this project
│           └── badge-images/
│               └── {templateKey}.txt # Base64-encoded background image per template
│
├── .env                      # Runtime secrets (not committed)
├── .env.example              # Template for .env
└── package.json
```

### Key Files

| File | Purpose |
|------|---------|
| `server/index.js` | Backend: auth middleware, project management, badge config, guest API proxy, kiosk routes |
| `public/index.html` | Admin UI: guest list, badge editor, routing rules, kiosk station management |
| `public/kiosk.html` | Kiosk display: full-screen check-in interface for Raspberry Pi / TV |
| `data/config.json` | Global fallback credentials and active project pointer |
| `data/projects.json` | All project metadata |
| `data/projects/{id}/badge-config.json` | Badge templates and routing rules |
| `data/projects/{id}/kiosk-stations.json` | Kiosk station definitions |

---

## Configuration

### Environment Variables (`.env`)

```env
APP_USER=admin
APP_PASSWORD=change-me-before-deploying
# PORT=3000   (optional, default 3000)
```

Leave `APP_PASSWORD` empty to disable basic auth (local use only).

### API Credentials

Credentials are configured in **Settings → OAuth2 / API Credentials**. They can be set globally (fallback) or per-project.

| Field | Description |
|-------|-------------|
| Client ID | OAuth2 client ID from Colada365 |
| Client Secret | OAuth2 client secret |
| Token URL | OAuth2 token endpoint |
| API Base URL | Colada365 API base (default: `https://admin.colada365.com`) |
| Event ID | The UUID of the Colada365 event |

Per-project credentials override global defaults. Leave a project field blank to inherit the global value.

---

## Projects

Projects allow you to manage multiple events from one server instance. Each project has its own:
- API credentials (or inherits global)
- Event ID
- Badge templates and routing rules
- Kiosk station configs

**Switching projects** triggers a full reload of badge config, guest schema, and option labels.

### Editing project vs. live project (multi-admin)

Multiple admins can work in the backoffice at the same time without stepping on each other:

- The project dropdown selects the project **this browser edits** (pinned per device via localStorage). Switching it does not affect other admins or the kiosks.
- The **live project** — the one all kiosk stations run — is set explicitly via **Go live** in the project manager. The sidebar shows a warning when you are editing a project that is not live.
- Every backoffice API call carries `?projectId=` for the pinned project; kiosk pages send nothing and always follow the live project.

### Companions

Colada365 guests can reference other guests in their top-level `companions` array. Per project (Settings → Companions), with an optional per-station override in the station editor:

- **Check-in behaviour** — `Separate` (default): every guest checks in individually. `Together`: scanning the main guest also checks in every companion (eligible `REGISTERED`/`PENDING` only; already-checked-in and cancelled companions are skipped, and a companion failure never blocks the main guest). Undo from the backoffice un-checks the companions again.
- **Ticket printing** (together mode) — `Main guest only`: one ticket whose seat field carries the comma-separated seat values of the whole party. `Ticket per guest`: the combined main ticket plus one ticket per companion with their own seat, each routed through the normal badge rules.
- **Seat field** — the attribute that is combined, default `guest_x_designer_seat`.
- **Search results** — optionally list each guest's companions ("👥 +2: …") in the kiosk guest search and the backoffice scan-page search, so staff see the whole party before checking in. Project setting with per-station override.

Reprints (station behaviour "reprint") reproduce the combined ticket(s). Works with both check-in field schemas.

### Conflict protection

- Badge config is saved **per section** (templates, rules, event groups, fallback, self-registration), each with its own version counter. A save based on a stale version is rejected (HTTP 409); the backoffice then reloads the other admin's state and asks you to re-apply your change. Edits to *different* sections never conflict.
- Kiosk stations carry a `_version` that works the same way per station.
- Each backoffice session polls `/api/sync-state` every 10 s and refreshes its view when another admin changed something (skipped while you have an editor open or are typing).

---

### Export / Import

Every project can be exported as a single JSON file (⬇ in the project manager): settings, check-in schema, companion options, badge templates/rules, badge images, and kiosk stations. API credentials are included only when you confirm it — exports without credentials are safe to share. **Import project…** restores such a file as a *new* project (never overwriting an existing one); kiosk station IDs are preserved so existing kiosk URLs keep working after moving to another install.

## Badge Templates & Routing Rules

### Templates

Each template defines a badge layout:
- **Name** and unique **key** (e.g. `gv_gast`, `vip`)
- Physical **dimensions** (width × height in cm)
- Optional **background image** (PNG/JPG, uploaded per template)
- **Content rows** — each row maps a guest attribute to a text line:
  - Field name from guest attributes (e.g. `contact_x_companyName`)
  - Multiple space-separated fields merge into one line
  - `text:Fixed Text` renders static text
  - Font size (pt), bold, margin-top (cm), alignment

### Routing Rules

Rules are evaluated top-to-bottom. The first matching rule determines which template is printed for a guest.

**Condition operators:**

| Operator | Meaning |
|----------|---------|
| `= equals` | Attribute exactly matches value |
| `≠ not equals` | Attribute does not match |
| `∋ contains` | Attribute contains substring |
| `∃ exists` | Attribute is set (non-empty) |
| `= true / = false` | Boolean attribute check |

Multiple conditions per rule can require **ALL** (AND) or **ANY** (OR) to match.

Choice fields (stored as UUIDs in Colada365) display real option labels once the guest schema is loaded.

### Fallback Template

If no rule matches a guest, the **fallback template** is used. Configure it in the Routing Rules section.

---

## Device Setup (HTTPS certificate)

When `caddy-root.cer` / `caddy-root.crt` are present in `public/`, the backoffice sidebar shows a **Device Setup → HTTPS Certificate** entry. Opening the main app URL on an iPad and tapping it gives a guided download of the root certificate (`.cer`, iOS DER format) with the install steps (profile install + Certificate Trust Settings). A PEM version (`.crt`) is linked for Android/desktop. Without the deployed cert files the entry stays hidden.

---

## Kiosk Stations

Kiosk stations provide a self-service check-in experience, designed for display on a Raspberry Pi with a large touchscreen or TV.

### What the Kiosk Does

1. Guest scans their QR code (or a staff member types the guest code)
2. The kiosk looks up the guest via the Colada365 API
3. If found and eligible (REGISTERED or PENDING status), the guest is checked in and a badge is triggered
4. The screen shows a confirmation card with the guest's name and company
5. After a configurable delay, the screen returns to the welcome state

### Setting Up a Kiosk Station

**In the Admin UI → Kiosk Stations:**

1. Click **+ New Station**
2. Give it a name (e.g. "Entrance A")
3. Configure branding and screen content (see below)
4. Click **Save**
5. The station appears in the list with a **URL** like: `http://your-server/kiosk/{stationId}`

**On the Kiosk Device:**

Open the station URL in a browser in full-screen / kiosk mode:

```bash
# Chromium on Raspberry Pi (kiosk mode, no cursor)
chromium-browser --kiosk --noerrdialogs --disable-infobars \
  --check-for-update-interval=31536000 \
  http://your-server/kiosk/{stationId}
```

The kiosk will auto-reload its config from the server and display the welcome screen.

### Station Configuration

Each station can be customised independently:

#### Global Branding

| Setting | Description |
|---------|-------------|
| Station Name | Internal label (admin only) |
| Logo / Event Text | Text shown at the top of all screens |
| Accent Color | Primary highlight colour (hex, e.g. `#d3222a`) |
| Background Color | Screen background (hex, e.g. `#0a0a0a`) |

#### Per-Screen Settings

The same options are available for all four screens:

| Screen | Shown When |
|--------|------------|
| **Welcome** | Idle / waiting for scan |
| **Success** | Guest checked in successfully |
| **Not Found** | QR code not found in the event |
| **Already Checked In** | Guest was previously checked in |

Each screen supports:

| Option | Description |
|--------|-------------|
| Heading | Main title text (leave blank for default) |
| Subtitle | Secondary text below the heading |
| Heading Size (px) | Override the title font size |
| Subtitle Size (px) | Override the subtitle font size |
| Background Image | Full-bleed background (PNG/JPG) |
| Auto-return Delay (seconds) | How long before returning to Welcome screen |
| Hide Guest Card | (Success / Already Checked In only) Hide the name/company card |

### Kiosk Screens

```
┌─────────────────────────┐
│  Logo / Event Text       │  ← logoText
│                         │
│       [ icon ]          │
│                         │
│   Welcome               │  ← screen title
│   Please scan your      │  ← screen subtitle
│   QR code to check in.  │
│                         │
│   ▌ [QR code input]     │  ← hidden input, auto-focused
└─────────────────────────┘
        Welcome Screen

┌─────────────────────────┐
│  Logo / Event Text       │
│                         │
│       ✓                 │
│                         │
│   Checked In!           │
│   Welcome!              │
│                         │
│  ┌──────────────────┐   │
│  │ Firstname Last   │   │  ← guest card (hideable)
│  │ Company Name     │   │
│  └──────────────────┘   │
└─────────────────────────┘
        Success Screen
```

### Kiosk Heartbeat

Each active kiosk station sends a heartbeat to the server every 30 seconds. The admin **Kiosk Stations** page shows live status:

- 🟢 **Online** — heartbeat received within the last 60 seconds
- 🔴 **Offline** — no heartbeat in the last 60 seconds
- **Last seen** timestamp

### Multiple Stations

You can run any number of stations simultaneously — different entrance doors, different events (by switching the active project), or different languages by customising per-screen text.

---

### Station appearance options

Per kiosk station (station editor):

- **Custom font** (General → Branding): upload a `.ttf` — applied to all kiosk screen text *and* embedded into the printed ticket PDFs. Cleared with ✕; copied along on station duplicate; travels with project export/import.
- **Hide heading & subtitle** (per screen tab): blank out the text when the background image already carries the wording. Icon, guest card, and logo keep their own toggles.
- **Text position (% from top)** (per screen tab): anchor the screen content at a vertical position instead of centering, so text lands in the free area of the background image. Empty = centered (default).
- **Heading/Subtitle color & size** (per screen tab): color pickers (↺ resets to the theme default) and pixel sizes for heading and subtitle, per screen.
- **Hide icon** (per screen tab): hide that screen's icon (QR symbol, check mark, warning, info) individually — e.g. when the background image replaces it. The General-tab "Hide QR Code Icon" toggle still covers the welcome icon globally.

## Monitor & Connection Watch

- **Direct link**: `/monitor` opens the Monitor page directly (bookmarkable); `/monitor?full=1` boots it chrome-less for a wall display, and the ⛶ button toggles fullscreen at any time.
- **Internet connection monitoring**: the server probes the Colada API host every 15 s (any HTTP response counts; 10 s timeout) and keeps an hour of samples. State is `ok` / `degraded` / `down` with human-readable warnings — degraded on ≥2 failed checks in 5 min, a 5-min median above 1.5 s, or latency rising to 3× the 15-min median; down after two consecutive failures.
- The Monitor page shows a connection card (status, latency now/median, failed-check rate, warnings, 60-min latency chart with failures marked red). A warning pill appears in the topbar on **every** backoffice page when the state is degraded or down — clicking it jumps to the Monitor; if the backoffice device itself loses its link to the check-in server, the pill turns red too.
- `GET /api/netstatus` exposes everything for external monitoring.

---

## API Reference

### Projects

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects` | List all projects |
| `POST` | `/api/projects` | Create a project |
| `PATCH` | `/api/projects/:id` | Update project metadata/credentials |
| `DELETE` | `/api/projects/:id` | Delete a project |
| `POST` | `/api/projects/:id/duplicate` | Duplicate a project |
| `POST` | `/api/projects/active` | Switch active project |

### Badge Config

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/badge-config` | Load templates, rules, fallback |
| `POST` | `/api/badge-config` | Save badge config |
| `GET` | `/api/badge-images` | List template background images |
| `GET` | `/api/badge-images/:key` | Get a background image (base64) |
| `DELETE` | `/api/badge-images/:key` | Delete a background image |
| `POST` | `/api/badge-images/rename` | Rename a background image key |

### Guests

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/guests/:eventId` | List/search guests (proxied from Colada365) |
| `GET` | `/api/guests/:eventId/schema` | Inferred field schema (types + value counts) |
| `GET` | `/api/guests/:eventId/optionlabels` | UUID → label map from Colada365 guestschema |
| `POST` | `/api/guests/:eventId/:guestId/checkin` | Check in a guest |
| `POST` | `/api/guests/:eventId/:guestId/badge` | Print badge for a guest |

### Kiosk

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/kiosk/stations` | List stations for active project |
| `POST` | `/api/kiosk/stations` | Create a station |
| `DELETE` | `/api/kiosk/stations/:stationId` | Delete a station |
| `GET` | `/api/kiosk/stations/status` | Live online/offline status |
| `POST` | `/api/kiosk/scan` | Process a scan (check-in logic) |
| `POST` | `/api/kiosk/heartbeat` | Station heartbeat |
| `GET` | `/api/kiosk/badge-image/:key` | Background image for kiosk |
| `GET` | `/kiosk/:stationId` | Serve kiosk.html for a station |

---

## Distributable Packages

`npm run build:dist` (or `bash packaging/build-dist.sh [linux|macos|windows]`) builds self-contained packages into `dist/` — the binary embeds the Node runtime, so target machines need nothing installed:

| Package | Installer | Runs as |
|---|---|---|
| `…-linux-x64.tar.gz` / `…-linux-arm64.tar.gz` (Raspberry Pi 64-bit) | `sudo ./install.sh [--port N]` | systemd service `colada-checkin`, dedicated user, auto-restart, data in `/var/lib/colada-checkin` |
| `…-macos-arm64.tar.gz` / `…-macos-x64.tar.gz` | `./install.sh [--port N]` (no sudo) | LaunchAgent at login, data in `~/Library/Application Support/colada-checkin/data` |
| `…-windows-x64.zip` | `powershell -ExecutionPolicy Bypass -File install.ps1 [-Port N]` | Scheduled Task at logon, data in `%LOCALAPPDATA%\ColadaCheckin\data` |

Re-running an installer upgrades in place (binary replaced, data and port config preserved). `uninstall.sh` / `uninstall.ps1` removes the app but keeps the data unless `--purge` / `-Purge` is passed. Packaged installs read/write everything under the data dir (`CHECKIN_DATA_DIR`), including `config.json` and optional `caddy-root.cer`/`.crt` files for the certificate download page.

---

## Deployment

### Recommended Stack

```
Internet → Cloudflare Access (auth) → Caddy (HTTPS reverse proxy) → Node.js (PM2)
```

### PM2

```bash
npm install -g pm2
pm2 start server/index.js --name colada365-checkin
pm2 save
pm2 startup
```

### Caddy (HTTPS)

```caddyfile
checkin.yourdomain.com {
  reverse_proxy localhost:3000
}
```

### Cloudflare Access (optional)

For events with sensitive guest data, Cloudflare Access can enforce SSO in front of the entire app without any changes to the Node.js server.

### Security Notes

- Set `APP_PASSWORD` in `.env` before deploying
- Badge images and guest data are stored in `data/` — back this directory up
- The `data/config.json` file contains API credentials in plain text — restrict file permissions accordingly
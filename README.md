# Colada365 Self-Service Check-in App

A deployable Node.js app translated from the Node-RED flow, with a React/HTML dashboard UI.

## Features

- **OAuth2 token management** — client credentials flow with auto-refresh (same as the `get Token c365 GF` node)
- **Guest lookup by UID/barcode** — fetches from the Colada365 guests API
- **QWERTY↔QWERTZ correction** — the `compensate for qwerty` node logic is built in
- **AWF permission check** — mirrors the `AWF Permission check` subflow (checks `guest_x_awf_teilnehmer` and `guest_x_Stimmberechtigt`)
- **Check-in** — PATCHes the guest with `guest_x_checkedinat = today`
- **Badge metadata** — computes font sizes and badge template (Swissrail/Swissmem, member/non-member)
- **Web UI** with:
  - Scan & Check-in page (barcode/keyboard input)
  - Dashboard with live stats
  - Settings page (all parameters configurable via UI)
  - Connection tester + event browser

## Quick Start

```bash
npm install
npm start
# Open http://localhost:3000
```

## Configuration

All settings are editable in the **Settings** tab of the UI, or directly in `config.json`:

| Parameter | Description |
|---|---|
| `clientId` | OAuth2 Client ID (default: `external_client_s-ge`) |
| `clientSecret` | OAuth2 Client Secret |
| `tokenUrl` | Keycloak token endpoint |
| `apiBase` | Colada365 API base URL |
| `eventId` | The UUID of the event to operate on |
| `tokenRefreshInterval` | Token refresh every N seconds (default: 240) |
| `qwertyCorrection` | Enable y↔z keyboard layout correction |

Use the **Connection** tab to:
1. Test if your credentials work
2. Browse all available events and copy an Event ID into settings

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/config` | Get current config (secret masked) |
| POST | `/api/config` | Update config |
| GET | `/api/token/test` | Test OAuth2 token fetch |
| GET | `/api/events` | List all events |
| GET | `/api/event/:id` | Get one event |
| GET | `/api/guests/:eventId?scan=UID` | Look up guest by UID |
| POST | `/api/guests/:eventId/:guestId/checkin` | Mark guest as checked in |
| POST | `/api/guests/:eventId/:guestId/badge` | Compute badge layout metadata |

## Flow → App Mapping

| Node-RED Node | App equivalent |
|---|---|
| `get Token c365 GF` (oauth2) | `server/index.js` → `getToken()` |
| `compensate for querty` (function) | `compensateQwerty()` |
| `AWF Permission check` (subflow) | `checkPermissions()` |
| `request guests` (http request) | `GET /api/guests/:eventId` |
| `set guest checked in` (http request) | `POST /api/guests/:eventId/:guestId/checkin` |
| `request event` (http request) | `GET /api/event/:id` |
| `define fontSize` (function) | `getNameFontSize()`, `getCompanyFontSize()` |
| `function 34 Stimmkarte` (function) | `POST /api/guests/:eventId/:guestId/badge` |
| Home / Confirm / Deny tabs (ui_tab) | Scan page confirm/deny overlay |

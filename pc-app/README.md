# SwiftSync PC App

## Run in development

```powershell
cd pc-app
npm install
npm start
```

The relay starts automatically on port **4000** (no separate `npm run relay` needed).

## Restart SwiftSync (PC + mobile relay)

Mobile UI is served from the relay on port **4000**. After code changes, restart so phones load the latest `mobile.js` / CSS.

**Quick restart (PowerShell):**

```powershell
cd pc-app
.\scripts\restart-swiftsync.ps1
```

**Manual:**

1. Close every SwiftSync / Electron window.
2. Free port 4000:

```powershell
Get-NetTCPConnection -LocalPort 4000 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
```

3. Start again: `npm start`

**On your phone:** hard-refresh the mobile page (pull to refresh, or close the tab and scan the QR again). Safari: hold reload → **Reload Without Content Blockers** if needed.

---

## Troubleshooting

### "Something is already running on port 4000"

1. Close **all** SwiftSync / Electron windows.
2. Do **not** run `npm run relay` while the app is open — `npm start` starts the relay for you.
3. If the error persists, free the port in PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 4000 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
```

Then run `npm start` again.

### Connect button does nothing

- Close the app, run `npm install` (Electron must be closed), then `npm start`.
- In OBS: **Tools → WebSocket Server Settings** — enable server, note port (default **4455**) and password.
- Enter those on the Home tab and click **Connect**.

## Build Windows installer

Close SwiftSync/Electron first, then:

```powershell
npm install
npm run dist
```

Installer output: `pc-app/dist/SwiftSync Setup 1.0.3.exe` (includes embedded relay on port 4000+)

See **[RELEASES.md](./RELEASES.md)** for GitHub Releases and Mac builds.

### After install (streamers)

1. Open SwiftSync → Home **Quick setup** checklist.
2. Enable OBS WebSocket (Tools → WebSocket Server Settings).
3. Click **Connect** — status should show **Cloud relay: online** (or **Relay: online**).
4. Scan QR on Home to pair your phone.
5. OBS multichat dock: **Chat** tab → copy `http://127.0.0.1:4000/dock/chat.html` into OBS → View → Docks → Custom Browser Docks. Add `?compact=1` for a smaller font.

If relay stays offline, tap **Retry relay** and read the yellow hint (port 4000 busy, missing config, or no internet).

Portable build: `npm run dist:portable`

## Mac (macOS)

SwiftSync is the same Electron app as Windows. **OBS, chat dock, and mobile control all work on Mac** the same way (`127.0.0.1:4000/dock/chat.html` in OBS → View → Docks → Custom Browser Docks).

### For streamers today (no Mac installer yet)

Until a signed `.dmg` is published on your site/GitHub Releases:

1. Install **Node.js 20+** from [nodejs.org](https://nodejs.org).
2. Clone the repo and open Terminal:

```bash
cd pc-app
npm install
npm start
```

3. In **OBS Studio for Mac**: enable WebSocket (Tools → WebSocket Server Settings), connect on SwiftSync **Home**, set up chat on **Chat**, paste the dock URL from the Chat tab into **View → Docks → Custom Browser Docks**.

Config files live at: `~/Library/Application Support/SwiftSync/` (same role as `%APPDATA%\SwiftSync` on Windows).

### Build on Mac with Cursor

1. Copy or clone the `swiftsync-relay` folder to your Mac (zip is fine; skip `node_modules` and `dist`).
2. Open the folder in **Cursor** (same account is fine).
3. Ask the agent to follow **[MAC_BUILD.md](./MAC_BUILD.md)** or paste the prompt in that file.

The agent can run `npm install`, test `npm start`, and `npm run dist:mac` on your machine.

### Build a Mac `.dmg` (maintainers — must run on a Mac)

Apple installers are built **on macOS** (not from a Windows PC):

```bash
cd pc-app
npm install
npm run dist:mac
```

Output: `dist/SwiftSync-1.0.1-arm64.dmg`, `dist/SwiftSync-1.0.1-x64.dmg`, and `.zip` variants.

Publish builds on **GitHub Releases** so Mac streamers can download a `.dmg` without using `npm start`. See [RELEASES.md](./RELEASES.md).

**First-time open:** macOS Gatekeeper may block unsigned builds. Users right-click the app → **Open**, or you sign + notarize with an **Apple Developer** account (`CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` for `electron-builder`).

### Mac troubleshooting (port 4000)

```bash
lsof -i :4000
kill -9 <PID>
npm start
```

## Mobile web UI (shared UI + WebSocket protocol)

The mobile “app” is a web UI served by the PC relay — same styling and the same WebSocket commands as the PC app. No separate native app install required.

### Quick test on your phone

1. Start the PC app: `npm start`
2. Connect to OBS on the **Home** tab.
3. On **Home**, note the **mobile URL** under the QR (e.g. `http://192.168.1.10:4000/mobile/?host=...&code=ABC123`).
4. On your phone (same Wi‑Fi), open that URL in Chrome/Safari — or scan the QR with the camera app.
5. The page auto-fills the relay URL and pairing code; tap **Connect**.
6. Use **Scenes**, **Tools**, and **Audio** tabs to control OBS remotely.

### Test on the same PC (no phone)

Open a browser tab:

```text
http://localhost:4000/mobile/
```

Enter pairing code from the PC app Home tab, then connect.

### Relay-only (no Electron)

```powershell
npm run relay
```

Then open `http://localhost:4000/mobile/` — pairing only works once the PC Electron app is also running and connected to the relay.

### Add to home screen (optional PWA)

On iPhone: Share → **Add to Home Screen**. On Android: browser menu → **Install app** / **Add to Home screen**.

## Mobile pairing (QR)

1. Open SwiftSync on PC — **Home** tab shows a QR code, 6-character code, and **mobile URL**.
2. Phone must be on the **same Wi‑Fi** as the PC **unless cloud relay is configured** (see below).
3. Scan QR (opens mobile URL) or paste the URL / code manually.

### Cloud relay (Wi‑Fi + cellular)

For streamers who control OBS away from home, deploy the cloud relay and configure the PC app:

1. Deploy `cloud-relay/` — see [cloud-relay/README.md](../cloud-relay/README.md).
2. Copy `relay-config.example.json` → `relay-config.json` in `pc-app/`:

```json
{
  "cloudRelayUrl": "wss://relay.yourdomain.com",
  "cloudPublicUrl": "https://relay.yourdomain.com"
}
```

3. Restart SwiftSync. Home tab shows **Cloud relay: online** and a QR with your public HTTPS URL.
4. Scan once at home; phone reconnects on cellular while PC app is open.

Installed app config path (Windows): `%APPDATA%\\SwiftSync\\relay-config.json` (same JSON).

---

## Mobile pairing (local Wi‑Fi only)

QR payload format:

```json
{
  "app": "swiftsync",
  "v": 2,
  "relay": "ws://192.168.x.x:4000",
  "host": "192.168.x.x",
  "port": 4000,
  "pairingCode": "A1B2C3",
  "mobileUrl": "http://192.168.x.x:4000/mobile/?host=192.168.x.x&port=4000&code=A1B2C3"
}
```

Mobile connects to `relay` and sends:

```json
{ "type": "role", "role": "mobile", "pairingCode": "A1B2C3" }
```

Click **New Code** on PC to rotate the pairing code (invalidates old QR).

## SE.Live linked scenes

Requires **OBS 32+** with canvas support. SwiftSync auto-detects **Main** and **Vertical** canvases and matches linked scenes by name (e.g. `Gameplay` ↔ `Gameplay (Vertical)`).

1. Open **Scenes** — scene strip shows linked pairs (`↔ Vertical name`).
2. Click a scene — switches **both** Main and Vertical (like SE.Live linked scenes).
3. **Side-by-side panels** — Visual (Hide/Show) and Audio (volume + Mute) controls for each canvas.

Link scenes in SE.Live: scene menu → **Link Scene** → pick the matching scene on the other canvas.

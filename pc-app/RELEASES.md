# SwiftSync releases

Current version: **1.0.32**

## Windows (from any PC)

Close SwiftSync/Electron first, then:

```powershell
cd pc-app
npm install
npm run dist
```

Installer: `dist\SwiftSync Setup 1.0.32.exe`

Portable: `npm run dist:portable` → `dist\SwiftSync 1.0.32.exe`

### Code signing (optional)

See **[CODE_SIGNING.md](./CODE_SIGNING.md)** for SmartScreen-friendly signed builds.

Quick version:

```powershell
$env:CSC_LINK = "C:\path\to\cert.pfx"
$env:CSC_KEY_PASSWORD = "cert-password"
npm run dist
```

## macOS (must run on a Mac)

```bash
cd pc-app
npm install
npm run dist:mac
```

Outputs: `dist/SwiftSync-1.0.32-arm64.dmg`, `dist/SwiftSync-1.0.32-x64.dmg`

First open: right-click app → **Open** (unsigned builds).

## Publish to GitHub Releases

1. Build installer (see above)
2. Tag: `git tag v1.0.32 && git push origin v1.0.32`
3. Create release and upload `dist/*.exe` (and `.dmg` if built)

The PC app checks **ej-swift/SwiftSync1** for update banners automatically. Override at build time:

```powershell
$env:SWIFTSYNC_GITHUB_REPO = "your-org/your-repo"
npm run dist
```

## Streamer config

Copy to `%APPDATA%\SwiftSync\relay-config.json` (Windows) or `~/Library/Application Support/SwiftSync/relay-config.json` (Mac):

```json
{
  "cloudRelayUrl": "wss://swiftsync-relay.fly.dev",
  "cloudPublicUrl": "https://swiftsync-relay.fly.dev"
}
```

## OBS chat dock URL

`http://127.0.0.1:4000/dock/chat.html` — same on every streamer PC. Compact: `?compact=1`

## Mobile (no install)

- Main site: https://ej-swift.github.io/SwiftSync1/
- Chat only: https://swiftsync-relay.fly.dev/mobile/?mode=chat

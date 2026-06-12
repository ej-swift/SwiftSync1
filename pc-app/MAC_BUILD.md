# Build SwiftSync on Mac (for Cursor agent)

Use this when the project is open in **Cursor on macOS**.

## What to upload / open

Open the repo folder (e.g. `swiftsync-relay`) in Cursor. You do **not** need `node_modules` or `dist` — the agent will run `npm install` on the Mac.

Include at minimum:

- `pc-app/` (full folder)
- `cloud-relay/` (optional, only if you deploy relay)

## Prompt for Cursor on Mac

Copy-paste:

```
Build the Mac release for SwiftSync in pc-app:
1. cd pc-app && npm install
2. npm start — confirm the app opens
3. npm run dist:mac — produce .dmg and .zip in dist/
4. Tell me the exact paths to the installer files and any Gatekeeper/signing notes
```

## Expected output

After `npm run dist:mac`:

- `pc-app/dist/SwiftSync-1.0.0-arm64.dmg` (Apple Silicon)
- `pc-app/dist/SwiftSync-1.0.0-x64.dmg` (Intel Mac)
- Matching `.zip` files

## First launch (unsigned build)

Users may need **right-click → Open** the first time, or allow in **System Settings → Privacy & Security**.

## Optional: Apple signing (later)

For distribution without warnings, set up Apple Developer ID and notarize with `electron-builder` (`CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`).

## Requirements on the Mac

- macOS 12+
- Node.js 20+ (`node -v`)
- Xcode Command Line Tools: `xcode-select --install`

# Code signing SwiftSync (Windows)

Unsigned builds work for beta, but Windows SmartScreen shows **“Windows protected your PC”** until you sign the installer.

## What you need

1. **Authenticode code signing certificate** (not a self-signed cert)
   - Buy from DigiCert, Sectigo, SSL.com, etc. (~$200–400/year)
   - Choose **Standard Code Signing** or **EV Code Signing** (EV builds reputation faster)

2. **Certificate file** — usually `.pfx` or `.p12` with a password

## Build a signed installer

Close SwiftSync, then in PowerShell:

```powershell
cd pc-app

# Point electron-builder at your cert (do not commit the .pfx file)
$env:CSC_LINK = "C:\path\to\swiftsync-codesign.pfx"
$env:CSC_KEY_PASSWORD = "your-cert-password"

npm run dist
```

Output: `dist\SwiftSync Setup 1.0.32.exe` (signed if CSC_* vars are valid)

## Optional: enable executable signing in package.json

Signing is currently off in `package.json` (`signAndEditExecutable: false`) so unsigned builds always work.

To sign the app `.exe` as well as the NSIS installer, set:

```json
"win": {
  "signAndEditExecutable": true
}
```

Then rebuild with `CSC_LINK` / `CSC_KEY_PASSWORD` set.

## EV certificate + hardware token

EV certs often ship on a USB token. Install the vendor’s middleware, then:

```powershell
$env:CSC_LINK = "your-certificate-thumbprint-or-token-path"
$env:CSC_KEY_PASSWORD = "token-pin"
npm run dist
```

See [electron-builder code signing](https://www.electron.build/code-signing).

## Timestamp server

electron-builder timestamps signatures automatically. If signing fails offline, ensure your network allows the timestamp URL your CA documents.

## Mac (when you build on a Mac)

1. Apple Developer Program ($99/year)
2. **Developer ID Application** certificate in Keychain
3. Notarize with:

```powershell
$env:APPLE_ID = "you@email.com"
$env:APPLE_APP_SPECIFIC_PASSWORD = "app-specific-password"
$env:APPLE_TEAM_ID = "YOUR_TEAM_ID"
npm run dist:mac
```

First open on Mac: right-click → **Open** (until notarized builds are trusted everywhere).

## GitHub Releases

After signing (or unsigned for beta):

1. Tag: `git tag v1.0.32 && git push origin v1.0.32`
2. Upload `dist\SwiftSync Setup 1.0.32.exe` to the release
3. Installed apps check `ej-swift/SwiftSync1` for update banners automatically

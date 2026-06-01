# TikTok developer portal URLs

Repo: **https://github.com/ej-swift/SwiftSync1** — GitHub Pages serves the **`/docs`** folder on branch **main**.

## Enable GitHub Pages (one time)

1. Push the `docs/` folder to GitHub.
2. Open your repo on GitHub → **Settings** → **Pages**.
3. **Build and deployment** → Source: **Deploy from a branch**.
4. Branch: **main**, folder: **/docs**.
5. Save. Wait 1–3 minutes for the site to go live.

## App icon (TikTok review)

Use the **same** icon file everywhere TikTok checks:

1. **TikTok Developer Portal → Basic Info → App icon** — upload `docs/icon-256.png` from this repo (same as `favicon.ico` / header logo).
2. **GitHub Pages** — Home, Terms, and Privacy show the logo in the header and at the top of each legal page; the browser tab uses `favicon.ico`.
3. Do **not** use the green letter “S” placeholder.

After pushing, hard-refresh Terms and Privacy and confirm the tab favicon and page logo match your TikTok upload.

## Paste into TikTok app settings

| Field | URL |
|-------|-----|
| **Web/Desktop URL** | `https://ej-swift.github.io/SwiftSync1/` |
| **Terms of Service URL** | `https://ej-swift.github.io/SwiftSync1/terms.html/` |
| **Privacy Policy URL** | `https://ej-swift.github.io/SwiftSync1/privacy.html/` |
| **Login Kit redirect URI** | `http://localhost:8877/oauth/callback` |

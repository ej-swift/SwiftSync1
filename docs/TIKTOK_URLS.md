# TikTok developer portal URLs

After you push this repo to GitHub and enable Pages, replace `YOUR_GITHUB_USERNAME` with your GitHub username and `REPO_NAME` with your repository name (e.g. `swiftsync-relay`).

## Enable GitHub Pages (one time)

1. Push the `docs/` folder to GitHub.
2. Open your repo on GitHub → **Settings** → **Pages**.
3. **Build and deployment** → Source: **Deploy from a branch**.
4. Branch: **main** (or **master**), folder: **/docs**.
5. Save. Wait 1–3 minutes for the site to go live.

## Paste into TikTok app settings

| Field | URL |
|-------|-----|
| **Web/Desktop URL** | `https://YOUR_GITHUB_USERNAME.github.io/REPO_NAME/` |
| **Terms of Service URL** | `https://YOUR_GITHUB_USERNAME.github.io/REPO_NAME/terms.html` |
| **Privacy Policy URL** | `https://YOUR_GITHUB_USERNAME.github.io/REPO_NAME/privacy.html` |
| **Login Kit redirect URI** | `http://localhost:8877/oauth/callback` |

## Example

If your repo is `https://github.com/janedoe/swiftsync-relay`:

- Web/Desktop: `https://janedoe.github.io/swiftsync-relay/`
- Terms: `https://janedoe.github.io/swiftsync-relay/terms.html`
- Privacy: `https://janedoe.github.io/swiftsync-relay/privacy.html`

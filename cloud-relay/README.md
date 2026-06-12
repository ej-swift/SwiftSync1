# SwiftSync Cloud Relay

Internet-facing relay so streamers can control OBS from their phone on **Wi‑Fi or cellular** — no port forwarding, no VPN.

```
Phone (cellular) ──wss──► Cloud relay ◄──wss── PC (home)
                              │
                         pairing code
                         links the room
```

## What you manage

| Task | How often | How |
|------|-----------|-----|
| Check it’s running | Weekly (or use host alerts) | `GET /api/health` |
| View live usage | When curious | `GET /api/admin/stats?token=…` |
| Deploy updates | When you ship app changes | `git push` or `fly deploy` |
| Rotate admin token | Yearly / if leaked | Change `ADMIN_TOKEN` env, redeploy |
| Domain / SSL | Once | Point DNS at host (Railway/Fly handle HTTPS) |

You do **not** need to SSH in for normal operation. Logs and restarts are handled by the host.

---

## Quick start (local test)

From repo root:

```powershell
cd cloud-relay
npm install
$env:PUBLIC_URL="http://localhost:8080"
$env:ADMIN_TOKEN="dev-token"
$env:EULER_API_KEY="your-eulerstream-api-key"
$env:EULER_ACCOUNT_ID="your-eulerstream-account-id"
npm start
```

Open http://localhost:8080/mobile/

Configure PC app (`pc-app/relay-config.json`):

```json
{
  "cloudRelayUrl": "ws://localhost:8080",
  "cloudPublicUrl": "http://localhost:8080"
}
```

Restart SwiftSync PC app → scan QR → phone works even on another network (use the cloud URL in QR).

---

## Production deploy (Fly.io — recommended)

**Important:** deploy from the **repo root** (`swiftsync-relay`), not from `cloud-relay` alone — the Docker image needs `pc-app/mobile` too.

### One-time auth setup (so you don't repeat `fly auth login`)

```powershell
cd C:\Users\ellit\OneDrive\Desktop\swiftsync-relay
.\cloud-relay\setup-fly-auth.ps1
```

This creates a **10-year deploy token** for `swiftsync-relay`, saves it to `cloud-relay/.fly-deploy-token` (gitignored), and sets your Windows user env var `FLY_API_TOKEN`. After that, deploy works from any terminal — including Cursor — without logging in again.

### Deploy

```powershell
cd C:\Users\ellit\OneDrive\Desktop\swiftsync-relay
.\cloud-relay\deploy.ps1
```

Or manually:

```powershell
cd C:\Users\ellit\OneDrive\Desktop\swiftsync-relay
flyctl deploy . --config cloud-relay/fly.toml --dockerfile cloud-relay/Dockerfile
```

1. Install [flyctl](https://fly.io/docs/hands-on/install-flyctl/) and sign up at [fly.io](https://fly.io).
2. Run `.\cloud-relay\setup-fly-auth.ps1` once (uses browser login the first time, then saves a long-lived token).
3. If the app does not exist yet: `cd cloud-relay` then `flyctl launch --no-deploy` (say **N** if it asks to create a new app when one already exists).
4. Set secrets (once):

```powershell
flyctl secrets set ADMIN_TOKEN=your-long-random-token
flyctl secrets set PUBLIC_URL=https://swiftsync-relay.fly.dev
flyctl secrets set EULER_API_KEY=your-eulerstream-api-key
flyctl secrets set EULER_ACCOUNT_ID=your-eulerstream-account-id
```

5. Deploy using the commands above (from **repo root**).

5. Add custom domain in Fly dashboard → **Certificates** → attach `relay.yourdomain.com`.

6. Point DNS `relay.yourdomain.com` → Fly (CNAME or A record per Fly instructions).

7. Update every streamer’s `relay-config.json`:

```json
{
  "cloudRelayUrl": "wss://relay.yourdomain.com",
  "cloudPublicUrl": "https://relay.yourdomain.com"
}
```

Ship this file with your installer, or set it once in:

`%APPDATA%\swiftsync\relay-config.json` (Windows userData — created on first SwiftSync run)

---

## Production deploy (Railway)

1. Create project at [railway.app](https://railway.app) → **Deploy from GitHub** (repo root).
2. Set **Root Directory** / Dockerfile path: `cloud-relay/Dockerfile` with build context = repo root (see `Dockerfile`).
3. Variables:
   - `PUBLIC_URL` = `https://your-app.up.railway.app` (or custom domain)
   - `ADMIN_TOKEN` = long random string
   - `PORT` = `8080` (Railway usually injects `PORT` automatically — server reads `process.env.PORT`)
4. Add custom domain under **Settings → Networking**.
5. Same `relay-config.json` on PC as above (use `wss://`).

---

## Docker (VPS)

From repo root:

```powershell
docker compose -f cloud-relay/docker-compose.yml up -d --build
```

Put a reverse proxy (Caddy/nginx) in front for HTTPS. Set `PUBLIC_URL=https://relay.yourdomain.com`.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No (default 8080) | Listen port |
| `PUBLIC_URL` | **Yes in production** | HTTPS URL in QR codes, e.g. `https://relay.yourdomain.com` |
| `ADMIN_TOKEN` | Recommended | Protects `/api/admin/stats` |
| `EULER_API_KEY` | **Yes for TikTok chat** | SwiftSync's EulerStream API key (server-side only; streamers never see it) |
| `EULER_ACCOUNT_ID` | **Yes for TikTok chat** | EulerStream account ID from Dashboard (used to mint per-user WebSocket JWTs) |
| `MOBILE_ROOT` | No | Path to `pc-app` folder (Docker sets automatically) |

Copy `.env.example` to `.env` for local runs.

---

## Admin / monitoring

**Health (public):**

```text
GET https://relay.yourdomain.com/api/health
```

**Stats (requires token):**

```text
GET https://relay.yourdomain.com/api/admin/stats?token=YOUR_ADMIN_TOKEN
```

Returns: active rooms, PC/mobile connection counts, uptime, per-room summary (codes partially masked).

**Logs:** Fly → `fly logs` · Railway → deploy logs · Docker → `docker compose logs -f`

**Alerts:** Point UptimeRobot / Better Stack at `/api/health` — notify if down 2+ minutes.

---

## Mobile chat-only (no PC while viewing)

Phone streamers can view multichat without the PC app running:

1. **Once on PC:** Chat tab → sign in to platforms → **Connect chat** (syncs credentials to cloud).
2. **On phone:** open  
   `https://YOUR-RELAY/mobile/?mode=chat&code=PAIRING&relay=wss://YOUR-RELAY`  
   Add to home screen optional.
3. Cloud chat **starts when the mobile app is open** and **stops ~90s after you leave** (no 24/7 cost).

Pairing code is the room key — keep it private.


1. Open SwiftSync on PC, connect to OBS.
2. Scan QR on phone **once** (at home is fine).
3. Add mobile page to home screen (optional).
4. Later on cellular: open app → **Connect** (auto-fills saved code) — works while PC SwiftSync is running.

---

## Security notes

- Pairing codes are per-PC session; rotate with **New Code** on PC Home tab.
- Use HTTPS (`wss://`) in production — Fly/Railway provide this.
- Set a strong `ADMIN_TOKEN`; do not commit it.
- For public launch, consider longer codes and rate limits (future hardening).

---

## Updating the relay

When you change `server.js` or mobile UI:

```powershell
fly deploy
# or
docker compose -f cloud-relay/docker-compose.yml up -d --build
```

Mobile static files are copied from `pc-app/mobile` at build time — redeploy after UI changes.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| QR shows `192.168…` | PC `relay-config.json` missing or empty — set cloud URLs |
| Phone “Invalid pairing code” | PC app not running, or code rotated — scan fresh QR |
| Phone “PC not connected” | Open SwiftSync on streaming PC |
| `Cloud relay: offline` on PC | Wrong `cloudRelayUrl`, relay down, or firewall blocking outbound WSS |
| Health OK but no control | Check OBS connected on PC Home tab |

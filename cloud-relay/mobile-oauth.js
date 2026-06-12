/**
 * Mobile/browser OAuth — sign in on phone without a PC.
 * Redirect URI: {PUBLIC_URL}/oauth/callback
 */
const path = require('path');
const crypto = require('crypto');

const PC_APP_ROOT = process.env.PC_APP_ROOT
  ? path.resolve(process.env.PC_APP_ROOT)
  : path.join(__dirname, '..', 'pc-app');

const { generatePkce, randomState } = require(path.join(PC_APP_ROOT, 'chat', 'oauth-pkce'));
const { PROVIDERS, normalizeTokenResponse } = require(path.join(PC_APP_ROOT, 'chat', 'oauth-providers'));
function defaultPlatforms() {
  return {
    twitch: { enabled: false, channel: '', oauthToken: '', username: '' },
    kick: { enabled: false, channel: '', accessToken: '', accountId: '' },
    youtube: { enabled: false, channelId: '', apiKey: '' },
    tiktok: { enabled: false, username: '', apiKey: '' }
  };
}

const FLOW_TTL_MS = 5 * 60 * 1000;
const pendingFlows = new Map();

function oauthRedirectUri(publicUrl) {
  const base = String(publicUrl || '').replace(/\/$/, '');
  return `${base}/oauth/callback`;
}

function getEnvCreds(platform) {
  const e = process.env;
  if (platform === 'twitch') {
    return { clientId: e.TWITCH_CLIENT_ID, clientSecret: e.TWITCH_CLIENT_SECRET };
  }
  if (platform === 'kick') {
    return { clientId: e.KICK_CLIENT_ID, clientSecret: e.KICK_CLIENT_SECRET };
  }
  if (platform === 'youtube') {
    return { clientId: e.YOUTUBE_CLIENT_ID, clientSecret: e.YOUTUBE_CLIENT_SECRET };
  }
  if (platform === 'tiktok') {
    return {
      clientId: e.TIKTOK_CLIENT_KEY,
      clientKey: e.TIKTOK_CLIENT_KEY,
      clientSecret: e.TIKTOK_CLIENT_SECRET
    };
  }
  return {};
}

function buildPlatformPartial(platform, auth, profile = {}) {
  const mergedAuth = { ...auth, ...profile };
  const entry = { enabled: true, auth: mergedAuth };

  if (platform === 'twitch') {
    entry.channel = profile.channel || '';
    entry.username = profile.username || '';
    entry.oauthToken = auth.accessToken || '';
  } else if (platform === 'kick') {
    entry.channel = profile.channel || '';
    entry.accessToken = auth.accessToken || '';
    entry.accountId = profile.accountId || auth.accountId || '';
  } else if (platform === 'youtube') {
    entry.channelId = profile.channelId || '';
  } else if (platform === 'tiktok') {
    entry.username = profile.username || '';
  }

  return entry;
}

function mergePlatformConfig(existing, platform, entry) {
  const base = { ...defaultPlatforms(), ...(existing || {}) };
  base[platform] = { ...base[platform], ...entry };
  return base;
}

function successHtml(platform) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SwiftSync</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1117;color:#e8eaed;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
.card{text-align:center;padding:2rem;border:1px solid #333;border-radius:12px;background:#1a1d26;max-width:360px}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#9aa0a6;margin:0 0 1rem;line-height:1.4}
a{color:#00ff85}</style></head>
<body><div class="card"><h1>${platform} connected</h1><p>Return to SwiftSync on your phone — chat will connect automatically.</p>
<script>setTimeout(function(){try{window.close()}catch(e){}},800);</script>
</div></body></html>`;
}

function errorHtml(message) {
  const safe = String(message || 'Sign-in failed').replace(/</g, '&lt;');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SwiftSync</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1117;color:#e8eaed;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
.card{text-align:center;padding:2rem;border:1px solid #633;border-radius:12px;background:#1a1d26;max-width:360px}
h1{font-size:1.25rem;margin:0 0 .5rem;color:#f88}p{color:#9aa0a6;margin:0;line-height:1.4}</style></head>
<body><div class="card"><h1>Sign-in failed</h1><p>${safe}</p></div></body></html>`;
}

function purgeExpiredFlows() {
  const now = Date.now();
  for (const [state, flow] of pendingFlows) {
    if (now - flow.createdAt > FLOW_TTL_MS) pendingFlows.delete(state);
  }
}

function createMobileOAuth(deps) {
  const {
    exchangeOAuthCode,
    getPublicHttpUrl,
    normalizePairingCode,
    getOrCreateRoomForCode,
    cloudChat,
    relay
  } = deps;

  function buildAuthorizeUrl(platform, creds, redirectUri, state, challenge) {
    const provider = PROVIDERS[platform];
    if (!provider) return null;
    if (platform === 'tiktok') {
      return provider.buildAuthorize({
        clientKey: creds.clientKey || creds.clientId,
        redirectUri,
        state,
        codeChallenge: challenge
      });
    }
    return provider.buildAuthorize({
      clientId: creds.clientId,
      redirectUri,
      state,
      codeChallenge: challenge
    });
  }

  async function fetchProfile(platform, auth, creds) {
    const provider = PROVIDERS[platform];
    if (platform === 'twitch') {
      return provider.fetchProfile({ accessToken: auth.accessToken, clientId: creds.clientId });
    }
    if (platform === 'kick') {
      return provider.fetchProfile({ accessToken: auth.accessToken });
    }
    if (platform === 'youtube') {
      return provider.fetchProfile({ accessToken: auth.accessToken });
    }
    if (platform === 'tiktok') {
      return provider.fetchProfile({ accessToken: auth.accessToken });
    }
    return {};
  }

  function handleOAuthStart(req, res, platform) {
    purgeExpiredFlows();
    const query = new URL(req.url, 'http://local').searchParams;
    const code = normalizePairingCode(query.get('code'));
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing code query param (pairing code)');
      return;
    }

    const creds = getEnvCreds(platform);
    if (!creds.clientId && !creds.clientKey) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end(`${platform} OAuth not configured on relay`);
      return;
    }

    const publicUrl = getPublicHttpUrl(req);
    const redirectUri = oauthRedirectUri(publicUrl);
    const { verifier, challenge } = generatePkce();
    const state = randomState();
    const returnPath = query.get('return') || `/mobile/?mode=chat&code=${code}`;
    const authorizeUrl = buildAuthorizeUrl(platform, creds, redirectUri, state, challenge);

    if (!authorizeUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Unknown platform');
      return;
    }

    pendingFlows.set(state, {
      platform,
      pairingCode: code,
      verifier,
      redirectUri,
      returnPath,
      createdAt: Date.now()
    });

    res.writeHead(302, { Location: authorizeUrl });
    res.end();
  }

  async function handleOAuthCallback(req, res) {
    purgeExpiredFlows();
    const query = new URL(req.url, 'http://local').searchParams;
    const state = query.get('state');
    const authCode = query.get('code');
    const err = query.get('error');
    const errDesc = query.get('error_description');

    const flow = state ? pendingFlows.get(state) : null;
    if (!flow) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(errorHtml('Session expired — go back to SwiftSync and tap Sign in again.'));
      return;
    }

    pendingFlows.delete(state);

    if (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(errorHtml(errDesc || err));
      return;
    }

    if (!authCode) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(errorHtml('Missing authorization code.'));
      return;
    }

    const { platform, pairingCode, verifier, redirectUri, returnPath } = flow;
    const creds = getEnvCreds(platform);

    try {
      const tokenJson = await exchangeOAuthCode(platform, {
        code: authCode,
        redirectUri,
        codeVerifier: verifier
      });
      const auth = normalizeTokenResponse(platform, tokenJson);
      let profile = {};
      try {
        profile = await fetchProfile(platform, auth, creds);
      } catch (e) {
        profile = { accountName: platform, _profileError: e.message || String(e) };
      }

      const room = getOrCreateRoomForCode(relay, pairingCode);
      const entry = buildPlatformPartial(platform, auth, profile);
      const platforms = mergePlatformConfig(room.chatConfigStored?.platforms, platform, entry);
      cloudChat.saveConfig(room, { platforms });
      relay.touchRoom(room);

      const returnUrl = new URL(returnPath, getPublicHttpUrl(req));
      returnUrl.searchParams.set('oauth', 'ok');
      returnUrl.searchParams.set('platform', platform);
      if (profile._profileError) {
        returnUrl.searchParams.set('oauth_warn', profile._profileError.slice(0, 120));
      }

      res.writeHead(302, { Location: returnUrl.toString() });
      res.end();
      console.log(`[oauth] Mobile ${platform} linked to room ${pairingCode.slice(0, 4)}…`);
    } catch (e) {
      console.error('[oauth] Callback failed', e.message);
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(errorHtml(e.message || String(e)));
    }
  }

  function tryHandle(req, res, urlPath) {
    const oauthStart = urlPath.match(/^\/api\/oauth\/start\/(twitch|kick|youtube|tiktok)$/);
    if (oauthStart && req.method === 'GET') {
      handleOAuthStart(req, res, oauthStart[1]);
      return true;
    }
    if (urlPath === '/oauth/callback' && req.method === 'GET') {
      handleOAuthCallback(req, res);
      return true;
    }
    return false;
  }

  function isConfigured(platform) {
    const c = getEnvCreds(platform);
    return !!(c.clientId || c.clientKey) && !!c.clientSecret;
  }

  return { tryHandle, isConfigured, oauthRedirectUri };
}

module.exports = { createMobileOAuth, oauthRedirectUri };

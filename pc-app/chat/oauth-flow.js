const http = require('http');
const { generatePkce, randomState } = require('./oauth-pkce');
const { PROVIDERS, normalizeTokenResponse } = require('./oauth-providers');
const { loadOAuthApps, isOAuthConfigured } = require('../chat-oauth-apps');
const { postJson } = require('./http-utils');

function getElectronShell() {
  try {
    return require('electron').shell;
  } catch {
    return null;
  }
}

function getElectronIpcRenderer() {
  try {
    return require('electron').ipcRenderer;
  } catch {
    return null;
  }
}

const REDIRECT_PORT = 8877;
const REDIRECT_PATH = '/oauth/callback';
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

let activeFlow = null;

function successHtml(platform) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>SwiftSync</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1117;color:#e8eaed;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{text-align:center;padding:2rem;border:1px solid #333;border-radius:12px;background:#1a1d26}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#9aa0a6;margin:0}</style></head>
<body><div class="card"><h1>Connected to ${platform}</h1><p>You can close this tab and return to SwiftSync.</p></div></body></html>`;
}

function errorHtml(message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>SwiftSync</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1117;color:#e8eaed;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{text-align:center;padding:2rem;border:1px solid #633;border-radius:12px;background:#1a1d26}
h1{font-size:1.25rem;margin:0 0 .5rem;color:#f88}p{color:#9aa0a6;margin:0}</style></head>
<body><div class="card"><h1>Sign-in failed</h1><p>${message}</p></div></body></html>`;
}

function startCallbackServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith(REDIRECT_PATH)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const url = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const err = url.searchParams.get('error');
      const errDesc = url.searchParams.get('error_description');

      if (activeFlow && state !== activeFlow.state) {
        res.writeHead(400);
        res.end(errorHtml('Invalid state — try again from SwiftSync.'));
        return;
      }

      if (err) {
        res.writeHead(400);
        res.end(errorHtml(errDesc || err));
        if (activeFlow) activeFlow.reject(new Error(errDesc || err));
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end(errorHtml('Missing authorization code.'));
        if (activeFlow) activeFlow.reject(new Error('Missing authorization code'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(successHtml(activeFlow?.platform || 'platform'));
      if (activeFlow) activeFlow.resolve(code);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `OAuth callback port ${REDIRECT_PORT} is already in use. Close other SwiftSync windows and try Sign In again.`
          )
        );
        return;
      }
      reject(err);
    });
    server.listen(REDIRECT_PORT, '127.0.0.1', () => resolve(server));
  });
}

function resetOAuthFlow() {
  if (activeFlow?.reject) {
    try {
      activeFlow.reject(new Error('Sign-in cancelled'));
    } catch {
      /* already settled */
    }
  }
  activeFlow = null;
}

async function openAuthorizeUrl(url) {
  if (!url) throw new Error('Missing authorization URL');
  const shell = getElectronShell();
  if (!shell) {
    throw new Error('Browser OAuth requires the SwiftSync desktop app');
  }
  if (process.type === 'browser') {
    const opened = await shell.openExternal(url, { activate: true });
    if (opened === false) {
      const { exec } = require('child_process');
      const escaped = String(url).replace(/"/g, '""');
      await new Promise((resolve, reject) => {
        exec(`cmd /c start "" "${escaped}"`, (err) => (err ? reject(err) : resolve()));
      });
    }
    return;
  }
  const ipcRenderer = getElectronIpcRenderer();
  if (ipcRenderer) {
    await ipcRenderer.invoke('swiftsync:open-external-url', url);
    return;
  }
  await shell.openExternal(url, { activate: true });
}

async function exchangeViaRelay(relayHttpBase, platform, { code, redirectUri, codeVerifier }) {
  const base = String(relayHttpBase || '').trim().replace(/\/$/, '');
  const url = `${base}/api/oauth/exchange/${platform}`;
  let result;
  try {
    result = await postJson(url, { code, redirectUri, codeVerifier });
  } catch (err) {
    throw new Error(
      `Could not reach cloud relay for OAuth (${base}). Use local sign-in or check internet: ${err.message || err}`
    );
  }
  if (!result.ok) throw new Error(result.error || 'Relay exchange failed');
  return result.token;
}

async function runBrowserOAuth(platform, { relayHttpBase = '' } = {}) {
  if (activeFlow) {
    resetOAuthFlow();
  }

  const apps = loadOAuthApps();
  // With relay exchange, only the clientId is needed locally for the auth URL.
  // Direct exchange (no relay) still needs the secret, checked per-platform below.
  if (!isOAuthConfigured(platform, apps)) {
    throw new Error(
      `OAuth is not configured for ${platform}. Open Chat → OAuth App Setup and add your app credentials.`
    );
  }

  const provider = PROVIDERS[platform];
  if (!provider) throw new Error(`Unknown platform: ${platform}`);

  const redirectUri = apps.redirectUri || `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`;
  // Only use relay exchange for cloud (non-localhost) relays
  const useRelayExchange = !!(relayHttpBase && !/127\.0\.0\.1|localhost/i.test(relayHttpBase));
  const { verifier, challenge } = generatePkce();
  const state = randomState();
  const creds = apps[platform] || {};

  let authorizeUrl;
  if (platform === 'twitch') {
    authorizeUrl = provider.buildAuthorize({
      clientId: creds.clientId,
      redirectUri,
      state,
      codeChallenge: challenge
    });
  } else if (platform === 'kick') {
    authorizeUrl = provider.buildAuthorize({
      clientId: creds.clientId,
      redirectUri,
      state,
      codeChallenge: challenge
    });
  } else if (platform === 'youtube') {
    authorizeUrl = provider.buildAuthorize({
      clientId: creds.clientId,
      redirectUri,
      state,
      codeChallenge: challenge
    });
  } else if (platform === 'tiktok') {
    authorizeUrl = provider.buildAuthorize({
      clientKey: creds.clientKey || creds.clientId,
      redirectUri,
      state,
      codeChallenge: challenge
    });
  }

  if (!authorizeUrl) {
    throw new Error(`Could not build sign-in URL for ${platform}`);
  }

  let server;
  try {
    server = await startCallbackServer();
  } catch (err) {
    throw err;
  }

  const codePromise = new Promise((resolve, reject) => {
    activeFlow = { platform, state, resolve, reject };
    setTimeout(() => {
      if (activeFlow?.state === state) {
        const reject = activeFlow.reject;
        activeFlow = null;
        reject(new Error('Sign-in timed out. Try again.'));
      }
    }, CALLBACK_TIMEOUT_MS);
  });

  await openAuthorizeUrl(authorizeUrl);

  let code;
  try {
    code = await codePromise;
  } finally {
    activeFlow = null;
    server.close();
  }

  let tokenJson;

  try {
    if (useRelayExchange) {
      tokenJson = await exchangeViaRelay(relayHttpBase, platform, {
        code,
        redirectUri,
        codeVerifier: verifier
      });
    } else if (platform === 'twitch') {
      tokenJson = await provider.exchangeCode({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        code,
        redirectUri,
        codeVerifier: verifier
      });
    } else if (platform === 'kick') {
    tokenJson = await provider.exchangeCode({
      clientId: creds.clientId, clientSecret: creds.clientSecret,
      code, redirectUri, codeVerifier: verifier
    });
  } else if (platform === 'youtube') {
    tokenJson = await provider.exchangeCode({
      clientId: creds.clientId, clientSecret: creds.clientSecret,
      code, redirectUri, codeVerifier: verifier
    });
    } else if (platform === 'tiktok') {
      tokenJson = await provider.exchangeCode({
        clientKey: creds.clientKey || creds.clientId,
        clientSecret: creds.clientSecret,
        code,
        redirectUri,
        codeVerifier: verifier
      });
    }
  } catch (err) {
    const msg = err?.message || String(err);
    if (/fetch failed/i.test(msg)) {
      throw new Error(
        `${platform} token exchange could not reach the internet from SwiftSync. Check firewall/VPN, then try again. (${msg})`
      );
    }
    throw err;
  }

  const auth = normalizeTokenResponse(platform, tokenJson);
  let profile = {};
  let profileError = null;
  try {
    if (platform === 'twitch') {
      profile = await provider.fetchProfile({ accessToken: auth.accessToken, clientId: creds.clientId });
    } else if (platform === 'kick') {
      profile = await provider.fetchProfile({ accessToken: auth.accessToken });
    } else if (platform === 'youtube') {
      profile = await provider.fetchProfile({ accessToken: auth.accessToken });
    } else if (platform === 'tiktok') {
      profile = await provider.fetchProfile({ accessToken: auth.accessToken });
    }
  } catch (e) {
    profileError = e.message || String(e);
    profile = { accountName: platform, _profileError: profileError };
  }

  return { auth: { ...auth, ...profile }, profile, profileError };
}

async function refreshPlatformToken(platform, existingAuth) {
  const apps = loadOAuthApps();
  const provider = PROVIDERS[platform];
  const creds = apps[platform] || {};
  if (!provider?.refreshToken || !existingAuth?.refreshToken) return null;

  let tokenJson;
  if (platform === 'twitch') {
    tokenJson = await provider.refreshToken({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: existingAuth.refreshToken
    });
  } else if (platform === 'kick') {
    tokenJson = await provider.refreshToken({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: existingAuth.refreshToken
    });
  } else if (platform === 'youtube') {
    tokenJson = await provider.refreshToken({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: existingAuth.refreshToken
    });
  } else {
    return null;
  }

  const auth = normalizeTokenResponse(platform, tokenJson);
  return { ...existingAuth, ...auth, refreshToken: auth.refreshToken || existingAuth.refreshToken };
}

function tokenNeedsRefresh(auth, skewMs = 60_000) {
  if (!auth?.accessToken) return false;
  if (!auth.expiresAt) return false;
  return Date.now() >= auth.expiresAt - skewMs;
}

module.exports = {
  runBrowserOAuth,
  refreshPlatformToken,
  tokenNeedsRefresh,
  resetOAuthFlow,
  REDIRECT_PORT,
  REDIRECT_PATH
};

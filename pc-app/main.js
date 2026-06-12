const { app, BrowserWindow, Menu, ipcMain, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');

function bootstrapPackagedAppRoot() {
  if (process.env.SWIFTSYNC_APP_ROOT) return;
  if (process.resourcesPath) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked');
    if (fs.existsSync(path.join(unpacked, 'mobile', 'index.html'))) {
      process.env.SWIFTSYNC_APP_ROOT = unpacked;
    }
  }
}
bootstrapPackagedAppRoot();

const { DEFAULT_PORT } = require('./server');
const { bootRelayServer, stopRelayServer, tryFreeRelayPort } = require('./relay-boot');
const { loadObsWebSocketSettings } = require('./obs-config');
const { loadRelayConfig, useCloudRelay, ensureCloudRelayConfigured } = require('./relay-config');
const { ensureOAuthAppsFile } = require('./chat-oauth-apps');
const { createCloudRelayClient } = require('./cloud-relay-client');
const { createRelayWsClient } = require('./relay-ws-client');
const { logStartup } = require('./startup-log');
const { probeRelayHealth } = require('./relay-boot');
const { ensureChatConfigFile } = require('./chat-config');
const { getPersistentPairingCode } = require('./pairing-store');

const DEFAULT_GITHUB_REPO = 'ej-swift/SwiftSync1';

const LOGO_FILE = 'Copilot_20260522_174446.png';
const ICON_FILE = process.platform === 'win32' ? 'icon.ico' : LOGO_FILE;
let relayServer = null;
let mainWindow = null;
let chatPopoutWindow = null;
let cloudRelayClient = null;
let localRelayClient = null;

function resolvePackagedAppRoot() {
  if (process.env.SWIFTSYNC_APP_ROOT) {
    const root = process.env.SWIFTSYNC_APP_ROOT;
    if (fs.existsSync(path.join(root, 'mobile', 'index.html'))) return root;
  }
  if (process.resourcesPath) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked');
    if (fs.existsSync(path.join(unpacked, 'mobile', 'index.html'))) return unpacked;
  }
  return __dirname;
}

function connectEmbeddedRelayPcClient() {
  if (!localRelayClient) return;
  if (relayServer?.external && !relayServer.attached) return;
  const port = relayServer?.port || DEFAULT_PORT;
  const code = getPersistentPairingCode();
  localRelayClient.connect(`ws://127.0.0.1:${port}`, code);
  logStartup(`Main-process PC linked to relay on port ${port}`);
}

function connectEmbeddedCloudRelayClient() {
  if (!cloudRelayClient) return;
  const relayConfig = loadRelayConfig();
  if (!useCloudRelay(relayConfig)) {
    logStartup('Cloud relay not configured — local Wi-Fi pairing only');
    return;
  }
  const code = getPersistentPairingCode();
  cloudRelayClient.connect(relayConfig.cloudRelayUrl, code);
  logStartup(`Main-process PC connecting to cloud relay ${relayConfig.cloudRelayUrl} code=${code.slice(0, 4)}…`);
}

async function bootEmbeddedRelayWithRetry() {
  ensureCloudRelayConfigured();
  try {
    relayServer = await bootRelayServer({ freePorts: false });
  } catch (err) {
    console.error('Relay startup:', err.message);
    logStartup(`Relay startup error: ${err.message}`);
    relayServer = { port: DEFAULT_PORT, external: true, wss: null };
  }

  if (relayServer.external && !relayServer.attached) {
    console.warn('Embedded relay could not bind — retrying once…');
    logStartup('Relay bind failed; freeing port 4000 and retrying');
    tryFreeRelayPort(DEFAULT_PORT);
    await new Promise((r) => setTimeout(r, 400));
    try {
      relayServer = await bootRelayServer({ freePorts: false });
    } catch (err) {
      console.error('Relay retry:', err.message);
      logStartup(`Relay retry error: ${err.message}`);
      relayServer = { port: DEFAULT_PORT, external: true, wss: null };
    }
  }

  const port = relayServer?.port || DEFAULT_PORT;
  const health = await probeRelayHealth(port);
  if (!relayServer.external) {
    console.log(`SwiftSync embedded relay on port ${relayServer.port}`);
    logStartup(`Embedded relay listening on ${relayServer.port}`);
  } else if (relayServer.attached) {
    console.log(`SwiftSync attached to relay on port ${port}`);
    logStartup(`Attached to existing relay on ${port}`);
  } else {
    console.error(
      'Embedded relay failed to start. Close other apps using ports 4000–4003 and use Retry relay in the app.'
    );
    logStartup(`Relay failed; health@${port}=${health}`);
  }

  connectEmbeddedRelayPcClient();
  connectEmbeddedCloudRelayClient();
  return relayServer;
}

function sendCloudRelayEvent(ev) {
  if (ev?.state === 'open') {
    logStartup('Main-process cloud relay connected');
  } else if (ev?.state === 'error') {
    logStartup(`Main-process cloud relay error: ${ev.message || 'unknown'}`);
  } else if (ev?.state === 'timeout') {
    logStartup('Main-process cloud relay connect timeout');
  } else if (ev?.state === 'close') {
    logStartup(`Main-process cloud relay closed (${ev.code || ''})`);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('swiftsync:cloud-relay', ev);
  }
}

const KICK_FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function repairOAuthConfigFromBundle() {
  const { ensureOAuthAppsFile, oauthAppsHaveRealCredentials, getUserDataOAuthPath } = require('./chat-oauth-apps');
  const userPath = ensureOAuthAppsFile();
  const { readJsonSafe } = require('./chat-oauth-apps');
  const raw = readJsonSafe(userPath);
  if (oauthAppsHaveRealCredentials(raw)) return { ok: true, repaired: false, path: userPath };

  const sources = [];
  if (process.resourcesPath) {
    sources.push(path.join(process.resourcesPath, 'chat-oauth-apps.json'));
  }
  if (process.env.SWIFTSYNC_APP_ROOT) {
    sources.push(path.join(process.env.SWIFTSYNC_APP_ROOT, 'chat-oauth-apps.json'));
  }

  for (const src of sources) {
    if (!src) continue;
    const bundled = readJsonSafe(src);
    if (bundled && oauthAppsHaveRealCredentials(bundled)) {
      const { safeMkdirForFile } = require('./electron-user-data');
      const safePath = safeMkdirForFile(userPath);
      fs.writeFileSync(safePath, `${JSON.stringify(bundled, null, 2)}\n`, 'utf8');
      logStartup(`Repaired OAuth config from ${src}`);
      return { ok: true, repaired: true, path: userPath };
    }
  }
  return { ok: false, error: 'No valid OAuth credentials found in app bundle', path: getUserDataOAuthPath() };
}

function registerOAuthIpc() {
  const { runBrowserOAuth, resetOAuthFlow } = require('./chat/oauth-flow');
  const { ensureOAuthAppsFile, oauthAppsHaveRealCredentials } = require('./chat-oauth-apps');
  const fs = require('fs');
  const path = require('path');

  ipcMain.handle('swiftsync:open-external-url', async (_evt, url) => {
    if (!url) throw new Error('missing url');
    const target = String(url);
    const opened = await shell.openExternal(target, { activate: true });
    if (opened === false) {
      const { exec } = require('child_process');
      const escaped = target.replace(/"/g, '""');
      await new Promise((resolve, reject) => {
        exec(`cmd /c start "" "${escaped}"`, (err) => (err ? reject(err) : resolve()));
      });
    }
    return { ok: true };
  });

  ipcMain.handle('swiftsync:oauth-reset', () => {
    resetOAuthFlow();
    return { ok: true };
  });

  ipcMain.handle('swiftsync:repair-oauth-config', () => {
    ensureOAuthAppsFile();
    return repairOAuthConfigFromBundle();
  });

  ipcMain.handle('swiftsync:is-oauth-configured', (_evt, platform) => {
    const { isOAuthConfigured, loadOAuthApps } = require('./chat-oauth-apps');
    ensureOAuthAppsFile();
    repairOAuthConfigFromBundle();
    const apps = loadOAuthApps();
    return {
      ok: true,
      platform,
      configured: platform ? isOAuthConfigured(platform, apps) : false,
      appsPath: apps.appsPath
    };
  });

  ipcMain.handle('swiftsync:browser-oauth', async (_evt, { platform, relayHttpBase } = {}) => {
    if (!platform) throw new Error('missing platform');
    ensureOAuthAppsFile();
    repairOAuthConfigFromBundle();
    logStartup(`OAuth browser sign-in start: ${platform}`);
    try {
      const result = await runBrowserOAuth(platform, { relayHttpBase });
      logStartup(`OAuth browser sign-in done: ${platform}`);
      return result;
    } catch (err) {
      logStartup(`OAuth browser sign-in failed: ${platform}: ${err.message}`);
      throw err;
    }
  });
}

function installMainProcessHttp() {
  const { setElectronFetchJson } = require('./chat/http-utils');
  setElectronFetchJson(async (url, opts = {}) => {
    const controller = new AbortController();
    const ms = Math.max(3000, Number(opts.timeout) || 15000);
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const res = await net.fetch(String(url), {
        method: opts.method || 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': opts.userAgent || KICK_FETCH_UA,
          ...(opts.headers || {})
        },
        body: opts.body || undefined,
        signal: controller.signal
      });
      const text = await res.text();
      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      if (opts.parseJson === false) return text;
      return JSON.parse(text || '{}');
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Request timeout');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  });
}

function registerFetchJsonIpc() {
  ipcMain.handle(
    'swiftsync:fetch-json',
    async (_evt, { url, method, headers, body, timeout, userAgent, parseJson } = {}) => {
      if (!url) throw new Error('fetch-json: missing url');
      const controller = new AbortController();
      const ms = Math.max(3000, Number(timeout) || 15000);
      const timer = setTimeout(() => controller.abort(), ms);
      try {
        const res = await net.fetch(String(url), {
          method: method || 'GET',
          headers: {
            Accept: 'application/json',
            'User-Agent': userAgent || KICK_FETCH_UA,
            ...(headers || {})
          },
          body: body || undefined,
          signal: controller.signal
        });
        const text = await res.text();
        if (res.status >= 400) {
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        if (parseJson === false) return text;
        try {
          return JSON.parse(text || '{}');
        } catch (e) {
          throw new Error(`Bad JSON: ${e.message}`);
        }
      } catch (err) {
        if (err.name === 'AbortError') throw new Error('Request timeout');
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  );
}

function registerCloudRelayIpc() {
  cloudRelayClient = createCloudRelayClient(sendCloudRelayEvent);

  ipcMain.handle('swiftsync:cloud-relay-connect', (_evt, { url, pairingCode }) => {
    if (!url) return { ok: false, error: 'missing url' };
    const code = pairingCode || getPersistentPairingCode();
    cloudRelayClient.connect(url, code);
    if (cloudRelayClient.isOpen?.()) {
      setImmediate(() => sendCloudRelayEvent({ state: 'open' }));
    }
    return {
      ok: true,
      connected: !!cloudRelayClient.isOpen?.(),
      external: !!relayServer?.external,
      port: relayServer?.port || DEFAULT_PORT
    };
  });

  ipcMain.handle('swiftsync:cloud-relay-status', () => ({
    connected: !!cloudRelayClient?.isOpen?.()
  }));

  ipcMain.on('swiftsync:cloud-relay-send', (_evt, text) => {
    cloudRelayClient.send(String(text || ''));
  });

  ipcMain.handle('swiftsync:cloud-relay-disconnect', () => {
    cloudRelayClient.stop();
    return { ok: true };
  });

  ipcMain.handle('swiftsync:get-relay-status', () => ({
    port: relayServer?.port || DEFAULT_PORT,
    external: !!relayServer?.external,
    attached: !!relayServer?.attached,
    embedded: !!(relayServer && !relayServer.external && !relayServer.attached)
  }));
}

function sendLocalRelayEvent(ev) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('swiftsync:local-relay', ev);
  }
}

function registerLocalRelayIpc() {
  localRelayClient = createRelayWsClient(sendLocalRelayEvent);

  ipcMain.handle('swiftsync:local-relay-connect', (_evt, { port, pairingCode }) => {
    const p = Number(port) || relayServer?.port || DEFAULT_PORT;
    localRelayClient.connect(`ws://127.0.0.1:${p}`, pairingCode);
    if (localRelayClient.isOpen?.()) {
      setImmediate(() => sendLocalRelayEvent({ state: 'open' }));
    }
    return { ok: true, port: p, connected: !!localRelayClient.isOpen?.() };
  });

  ipcMain.on('swiftsync:local-relay-send', (_evt, text) => {
    localRelayClient.send(String(text || ''));
  });

  ipcMain.handle('swiftsync:local-relay-disconnect', () => {
    localRelayClient.stop();
    return { ok: true };
  });
}

function getDockChatUrl() {
  const port = relayServer?.port || DEFAULT_PORT;
  return `http://127.0.0.1:${port}/dock/chat.html`;
}

function openChatPopout() {
  if (chatPopoutWindow && !chatPopoutWindow.isDestroyed()) {
    if (chatPopoutWindow.isMinimized()) chatPopoutWindow.restore();
    chatPopoutWindow.focus();
    return;
  }
  chatPopoutWindow = new BrowserWindow({
    width: 400,
    height: 560,
    minWidth: 280,
    minHeight: 360,
    alwaysOnTop: true,
    title: 'SwiftSync Chat',
    icon: getAppIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  chatPopoutWindow.loadURL(getDockChatUrl());
  chatPopoutWindow.on('closed', () => {
    chatPopoutWindow = null;
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function getAppIconPath() {
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'icon.ico');
    if (fs.existsSync(bundled)) return bundled;
  }
  const iconPath = path.join(__dirname, 'assets', ICON_FILE);
  if (fs.existsSync(iconPath)) return iconPath;
  return path.join(__dirname, 'assets', LOGO_FILE);
}

/** HTTP or file URL for logos — never base64 (full PNG is ~1.4MB and freezes the UI). */
function getStartupLogoUrl() {
  const port = relayServer?.port || DEFAULT_PORT;
  const relayUp = relayServer && (!relayServer.external || relayServer.attached);
  if (relayUp) {
    return `http://127.0.0.1:${port}/assets/logo.png`;
  }
  const { pathToFileURL } = require('url');
  for (const name of ['logo.png', 'icon-256.png']) {
    const logoPath = path.join(__dirname, 'assets', name);
    if (fs.existsSync(logoPath) && fs.statSync(logoPath).size < 400000) {
      return pathToFileURL(logoPath).href;
    }
  }
  return '';
}

function injectStartupConfig(win) {
  const relayPort = relayServer?.port || DEFAULT_PORT;
  const relayExternal = relayServer?.external ? 'true' : 'false';
  const logoUrl = getStartupLogoUrl();
  const obsConfig = loadObsWebSocketSettings();
  const relayConfig = loadRelayConfig();
  const cloudEnabled = useCloudRelay(relayConfig);

  win.webContents
    .executeJavaScript(
      `(() => {
        window.SWIFTSYNC_RELAY_PORT = ${relayPort};
        window.SWIFTSYNC_RELAY_EXTERNAL = ${relayExternal};
        window.SWIFTSYNC_RELAY_EMBEDDED = ${relayServer && !relayServer.external ? 'true' : 'false'};
        window.SWIFTSYNC_RELAY_ATTACHED = ${relayServer?.attached ? 'true' : 'false'};
        window.SWIFTSYNC_CLOUD_RELAY_URL = ${JSON.stringify(relayConfig.cloudRelayUrl)};
        window.SWIFTSYNC_CLOUD_PUBLIC_URL = ${JSON.stringify(relayConfig.cloudPublicUrl)};
        window.SWIFTSYNC_USE_CLOUD_RELAY = ${cloudEnabled ? 'true' : 'false'};
        window.SWIFTSYNC_VERSION = ${JSON.stringify(require('./package.json').version)};
        window.SWIFTSYNC_GITHUB_REPO = ${JSON.stringify(process.env.SWIFTSYNC_GITHUB_REPO || DEFAULT_GITHUB_REPO)};
        window.SWIFTSYNC_OBS_CONFIG = ${JSON.stringify(obsConfig)};
        document.querySelectorAll('.swift-brand-logo').forEach((el) => {
          if (${JSON.stringify(logoUrl)}) {
            el.style.backgroundImage = 'url(' + ${JSON.stringify(logoUrl)} + ')';
          }
        });
        const legacyLogo = document.getElementById('swift-logo');
        if (legacyLogo && ${JSON.stringify(logoUrl)} && !legacyLogo.style.backgroundImage) {
          legacyLogo.style.backgroundImage = 'url(' + ${JSON.stringify(logoUrl)} + ')';
        }
        window.dispatchEvent(new Event('swiftsync-config-ready'));
      })();`
    )
    .catch(() => {});
}

async function createWindow() {
  const indexPath = path.join(__dirname, 'index.html');
  logStartup(
    `UI load file ${indexPath} relayPort=${relayServer?.port} external=${!!relayServer?.external} attached=${!!relayServer?.attached}`
  );

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    show: false,
    icon: getAppIconPath(),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: !app.isPackaged
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadFile(indexPath);
}

if (gotSingleInstanceLock) {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.swiftsync.pc');
  }

  async function startEmbeddedRelay(options = {}) {
    ensureCloudRelayConfigured();
    try {
      return await bootRelayServer(options);
    } catch (err) {
      console.error('Relay startup:', err.message);
      logStartup(`Relay startup error: ${err.message}`);
      return { port: DEFAULT_PORT, external: true, wss: null };
    }
  }

  app.whenReady().then(async () => {
    try {
    process.env.SWIFTSYNC_APP_ROOT = resolvePackagedAppRoot();
    logStartup(`SwiftSync ${require('./package.json').version} starting packaged=${app.isPackaged} appRoot=${process.env.SWIFTSYNC_APP_ROOT}`);

    const menu = Menu.buildFromTemplate([
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload', accelerator: 'CmdOrCtrl+R' },
          { role: 'forceReload', accelerator: 'CmdOrCtrl+Shift+R' },
          { role: 'toggleDevTools', accelerator: 'F12' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      }
    ]);
    Menu.setApplicationMenu(menu);

    installMainProcessHttp();
    registerFetchJsonIpc();
    registerOAuthIpc();
    registerCloudRelayIpc();
    registerLocalRelayIpc();
    ipcMain.handle('swiftsync:get-dock-chat-url', () => getDockChatUrl());
    ipcMain.on('swiftsync:open-chat-popout', () => openChatPopout());

    ipcMain.handle('swiftsync:restart-relay', async () => {
      localRelayClient?.stop();
      await stopRelayServer(relayServer);
      relayServer = await bootRelayServer({ freePorts: true });
      connectEmbeddedRelayPcClient();
      connectEmbeddedCloudRelayClient();
      if (mainWindow && !mainWindow.isDestroyed()) {
        injectStartupConfig(mainWindow);
      }
      return {
        ok: !relayServer.external || !!relayServer.attached,
        port: relayServer.port,
        external: !!relayServer.external,
        attached: !!relayServer.attached
      };
    });

    ensureOAuthAppsFile();
    ensureChatConfigFile();
    const oauthRepair = repairOAuthConfigFromBundle();
    if (oauthRepair.repaired) {
      logStartup(`Startup OAuth repair: ${oauthRepair.path}`);
    } else if (!oauthRepair.ok) {
      logStartup(`Startup OAuth repair failed: ${oauthRepair.error || 'unknown'}`);
    }
    await bootEmbeddedRelayWithRetry();
    await createWindow();

    if (mainWindow && !mainWindow.isDestroyed()) {
      injectStartupConfig(mainWindow);
      mainWindow.webContents.once('did-finish-load', () => {
        if (mainWindow && !mainWindow.isDestroyed()) injectStartupConfig(mainWindow);
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().then(() => {
          if (relayServer && mainWindow && !mainWindow.isDestroyed()) {
            injectStartupConfig(mainWindow);
          }
        });
      }
    });
    } catch (err) {
      console.error('SwiftSync startup failed:', err);
      logStartup(`Startup failed: ${err?.message || err}`);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('quit', () => {
    cloudRelayClient?.stop();
    localRelayClient?.stop();
    stopRelayServer(relayServer).catch(() => {});
  });
}

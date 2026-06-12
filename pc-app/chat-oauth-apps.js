const fs = require('fs');
const path = require('path');
const {
  isInsideAppAsar,
  resolveElectronUserDataDir,
  userDataFile,
  safeMkdirForFile
} = require('./electron-user-data');

const FILE_NAME = 'chat-oauth-apps.json';
const EXAMPLE_NAME = 'chat-oauth-apps.example.json';
const DEFAULT_REDIRECT = 'http://localhost:8877/oauth/callback';

function isPlaceholderOAuthValue(value) {
  const s = String(value || '').trim();
  if (!s) return true;
  return /^YOUR_/i.test(s) || /^paste_/i.test(s) || /^your_/i.test(s);
}

function oauthAppsHaveRealCredentials(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const twitch = raw.twitch?.clientId;
  const kick = raw.kick?.clientId;
  const youtube = raw.youtube?.clientId;
  const tiktok = raw.tiktok?.clientKey || raw.tiktok?.clientId;
  return [twitch, kick, youtube, tiktok].some((id) => !isPlaceholderOAuthValue(id));
}

function isPackagedApp() {
  if (isInsideAppAsar(__dirname)) return true;
  try {
    const { app } = require('electron');
    if (typeof app?.isPackaged === 'boolean') return app.isPackaged;
  } catch {
    /* renderer cannot import app */
  }
  return !!(
    process.resourcesPath && !String(process.execPath || '').includes('node_modules\\electron')
  );
}

function readJsonSafe(filePath) {
  if (!filePath || isInsideAppAsar(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonSafe(filePath, raw) {
  const target = safeMkdirForFile(filePath || userDataFile(FILE_NAME));
  fs.writeFileSync(target, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return target;
}

function getBundledOAuthSources() {
  const sources = [];
  if (process.resourcesPath) {
    sources.push(path.join(process.resourcesPath, FILE_NAME));
    sources.push(path.join(process.resourcesPath, EXAMPLE_NAME));
  }
  if (process.env.SWIFTSYNC_APP_ROOT) {
    sources.push(path.join(process.env.SWIFTSYNC_APP_ROOT, FILE_NAME));
    sources.push(path.join(process.env.SWIFTSYNC_APP_ROOT, EXAMPLE_NAME));
  }
  if (!isPackagedApp()) {
    sources.push(path.join(__dirname, FILE_NAME));
    sources.push(path.join(__dirname, EXAMPLE_NAME));
  }
  return [...new Set(sources)];
}

function getUserDataOAuthPath() {
  return userDataFile(FILE_NAME);
}

function findBundledOAuthCredentials() {
  for (const src of getBundledOAuthSources()) {
    const raw = readJsonSafe(src);
    if (raw && oauthAppsHaveRealCredentials(raw)) {
      return { src, raw };
    }
  }
  return null;
}

function seedOAuthAppsToUserData(targetPath = getUserDataOAuthPath()) {
  const target = safeMkdirForFile(targetPath);
  const bundled = findBundledOAuthCredentials();
  if (bundled) {
    writeJsonSafe(target, bundled.raw);
    return { path: target, seeded: true, source: bundled.src };
  }

  const current = readJsonSafe(target);
  if (!current) {
    const template =
      readJsonSafe(getBundledOAuthSources().find((p) => p.endsWith(EXAMPLE_NAME))) ||
      {
        redirectUri: DEFAULT_REDIRECT,
        twitch: {},
        kick: {},
        youtube: {},
        tiktok: {}
      };
    writeJsonSafe(target, template);
  }
  return { path: target, seeded: false };
}

function ensureOAuthAppsFile() {
  const targetPath = getUserDataOAuthPath();
  const current = readJsonSafe(targetPath);
  if (current && oauthAppsHaveRealCredentials(current)) {
    return targetPath;
  }
  seedOAuthAppsToUserData(targetPath);
  return targetPath;
}

function resolveAppsPath() {
  return ensureOAuthAppsFile();
}

function loadOAuthApps() {
  const targetPath = ensureOAuthAppsFile();
  let raw = readJsonSafe(targetPath);

  if (!oauthAppsHaveRealCredentials(raw)) {
    const bundled = findBundledOAuthCredentials();
    if (bundled) {
      writeJsonSafe(targetPath, bundled.raw);
      raw = bundled.raw;
    }
  }

  if (!raw) {
    for (const src of getBundledOAuthSources()) {
      if (!src.endsWith(EXAMPLE_NAME)) continue;
      raw = readJsonSafe(src);
      if (raw) break;
    }
  }
  raw = raw || {};

  return {
    appsPath: targetPath,
    redirectUri: raw.redirectUri || DEFAULT_REDIRECT,
    twitch: raw.twitch || {},
    kick: raw.kick || {},
    youtube: raw.youtube || {},
    tiktok: raw.tiktok || {}
  };
}

function saveOAuthApps(partial = {}) {
  const targetPath = ensureOAuthAppsFile();
  const existing = readJsonSafe(targetPath) || {};

  const merged = {
    redirectUri: partial.redirectUri || existing.redirectUri || DEFAULT_REDIRECT,
    twitch: { ...(existing.twitch || {}), ...(partial.twitch || {}) },
    kick: { ...(existing.kick || {}), ...(partial.kick || {}) },
    youtube: { ...(existing.youtube || {}), ...(partial.youtube || {}) },
    tiktok: { ...(existing.tiktok || {}), ...(partial.tiktok || {}) }
  };

  writeJsonSafe(targetPath, merged);
  return merged;
}

function getOAuthSetupStatus(apps = loadOAuthApps()) {
  return {
    twitch: isOAuthConfigured('twitch', apps),
    kick: isOAuthConfigured('kick', apps),
    youtube: isOAuthConfigured('youtube', apps),
    tiktok: isOAuthConfigured('tiktok', apps)
  };
}

function isOAuthConfigured(platform, apps = loadOAuthApps()) {
  const p = apps[platform] || {};
  if (platform === 'twitch') return isRealOAuthSecret(p.clientId);
  if (platform === 'kick') return isRealOAuthSecret(p.clientId);
  if (platform === 'youtube') return isRealOAuthSecret(p.clientId);
  if (platform === 'tiktok') return isRealOAuthSecret(p.clientKey || p.clientId);
  return false;
}

function isRealOAuthSecret(value) {
  return !isPlaceholderOAuthValue(value);
}

module.exports = {
  loadOAuthApps,
  saveOAuthApps,
  ensureOAuthAppsFile,
  getOAuthSetupStatus,
  getUserDataOAuthPath,
  resolveElectronUserDataDir,
  isOAuthConfigured,
  isRealOAuthSecret,
  oauthAppsHaveRealCredentials,
  readJsonSafe,
  DEFAULT_REDIRECT
};

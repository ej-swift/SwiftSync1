const fs = require('fs');
const path = require('path');
const { userDataFile, safeMkdirForFile, isInsideAppAsar } = require('./electron-user-data');

const FILE_NAME = 'chat-config.json';

const defaultPlatforms = () => ({
  twitch: { enabled: false, channel: '', oauthToken: '', username: '' },
  kick: { enabled: false, channel: '', accessToken: '', accountId: '' },
  youtube: { enabled: false, channelId: '', apiKey: '' },
  tiktok: { enabled: false, username: '', apiKey: '' }
});

const defaults = { platforms: defaultPlatforms() };

function resolveConfigPath() {
  if (process.env.SWIFTSYNC_CHAT_CONFIG) {
    return process.env.SWIFTSYNC_CHAT_CONFIG;
  }

  const userPath = userDataFile(FILE_NAME);
  if (fs.existsSync(userPath)) return userPath;

  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, FILE_NAME));
  }
  if (!isInsideAppAsar(__dirname)) {
    candidates.push(path.join(__dirname, FILE_NAME));
  }

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  return userPath;
}

function normalizeAuth(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const auth = {};
  if (raw.accessToken) auth.accessToken = String(raw.accessToken).trim();
  if (raw.refreshToken) auth.refreshToken = String(raw.refreshToken).trim();
  if (raw.expiresAt != null) auth.expiresAt = Number(raw.expiresAt) || null;
  if (raw.accountName) auth.accountName = String(raw.accountName).trim();
  if (raw.accountId) auth.accountId = String(raw.accountId).trim();
  if (raw.channel) auth.channel = String(raw.channel).trim();
  if (raw.username) auth.username = String(raw.username).trim();
  if (raw.channelId) auth.channelId = String(raw.channelId).trim();
  return Object.keys(auth).length ? auth : null;
}

function normalizePlatformEntry(platform, raw = {}) {
  const base = defaultPlatforms()[platform] || {};
  const out = { ...base };
  for (const key of Object.keys(base)) {
    if (raw[key] != null) {
      out[key] = typeof base[key] === 'boolean' ? !!raw[key] : String(raw[key]).trim();
    }
  }
  if (raw.auth === null) {
    delete out.auth;
  } else if (raw.auth && typeof raw.auth === 'object') {
    const auth = normalizeAuth(raw.auth);
    if (auth) out.auth = auth;
    else delete out.auth;
  } else if (out.auth) {
    /* preserve existing auth when merging partial updates without auth field */
  }
  return out;
}

function migrateLegacyConfig(raw) {
  const platforms = defaultPlatforms();
  if (raw.channel || raw.oauthToken || raw.username) {
    platforms.twitch = {
      enabled: !!String(raw.channel || '').trim(),
      channel: String(raw.channel || '').trim(),
      oauthToken: String(raw.oauthToken || '').trim(),
      username: String(raw.username || '').trim()
    };
  }
  if (raw.platforms && typeof raw.platforms === 'object') {
    for (const platform of Object.keys(platforms)) {
      if (raw.platforms[platform]) {
        platforms[platform] = normalizePlatformEntry(platform, raw.platforms[platform]);
      }
    }
  }
  return { platforms };
}

/**
 * Copy bundled chat-config into %APPDATA%/SwiftSync on first install so desktop app
 * matches dev folder credentials (npm start reads project dir; installer uses userData).
 */
function configHasStoredAuth(raw) {
  const platforms = raw?.platforms || {};
  for (const cfg of Object.values(platforms)) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (cfg.auth?.accessToken || cfg.oauthToken || cfg.accessToken) return true;
    if (cfg.channelId && cfg.auth) return true;
  }
  return false;
}

function ensureChatConfigFile() {
  const userPath = safeMkdirForFile(userDataFile(FILE_NAME));

  if (fs.existsSync(userPath)) {
    try {
      const cur = JSON.parse(fs.readFileSync(userPath, 'utf8'));
      if (configHasStoredAuth(cur)) return userPath;
    } catch {
      /* re-seed below */
    }
  }

  const sources = [];
  if (process.resourcesPath) {
    sources.push(path.join(process.resourcesPath, FILE_NAME));
  }
  if (!isInsideAppAsar(__dirname)) {
    sources.push(path.join(__dirname, FILE_NAME), path.join(__dirname, 'chat-config.example.json'));
  }

  for (const src of sources) {
    if (!src || isInsideAppAsar(src)) continue;
    const raw = (() => {
      try {
        return JSON.parse(fs.readFileSync(src, 'utf8'));
      } catch {
        return null;
      }
    })();
    if (!raw) continue;
    if (!configHasStoredAuth(raw) && src.endsWith('example.json')) continue;
    fs.writeFileSync(userPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    return userPath;
  }

  if (!fs.existsSync(userPath)) {
    fs.writeFileSync(userPath, `${JSON.stringify(defaults, null, 2)}\n`, 'utf8');
  }
  return userPath;
}

function loadChatConfig() {
  const configPath = resolveConfigPath();
  try {
    if (!fs.existsSync(configPath)) return { ...defaults, configPath };
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const migrated = migrateLegacyConfig(raw);
    return { configPath, ...migrated };
  } catch {
    return { ...defaults, configPath };
  }
}

function saveChatConfig(partial) {
  const current = loadChatConfig();
  let platforms = { ...defaultPlatforms(), ...current.platforms };

  if (partial.platforms && typeof partial.platforms === 'object') {
    for (const platform of Object.keys(platforms)) {
      if (partial.platforms[platform]) {
        const merged = { ...platforms[platform], ...partial.platforms[platform] };
        if (partial.platforms[platform].auth === null) {
          delete merged.auth;
          if (platform === 'twitch') merged.oauthToken = '';
          if (platform === 'youtube') {
            merged.accessToken = '';
            delete merged.auth;
          }
        }
        platforms[platform] = normalizePlatformEntry(platform, merged);
      }
    }
  }

  // Legacy top-level twitch fields
  if (partial.channel != null || partial.oauthToken != null || partial.username != null) {
    platforms.twitch = normalizePlatformEntry('twitch', {
      ...platforms.twitch,
      channel: partial.channel != null ? partial.channel : platforms.twitch.channel,
      oauthToken: partial.oauthToken != null ? partial.oauthToken : platforms.twitch.oauthToken,
      username: partial.username != null ? partial.username : platforms.twitch.username
    });
  }

  const next = { platforms };
  const configPath = safeMkdirForFile(
    isInsideAppAsar(current.configPath) ? userDataFile(FILE_NAME) : current.configPath || resolveConfigPath()
  );
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { ...next, configPath };
}

module.exports = {
  loadChatConfig,
  saveChatConfig,
  resolveConfigPath,
  ensureChatConfigFile,
  defaults,
  defaultPlatforms
};

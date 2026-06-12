const fs = require('fs');
const path = require('path');
const { userDataFile, safeMkdirForFile, isInsideAppAsar } = require('./electron-user-data');

const FILE_NAME = 'relay-config.json';

const defaults = { cloudRelayUrl: '', cloudPublicUrl: '' };

/** Shipped default so installed apps work without manual config copy. */
const DEFAULT_CLOUD_CONFIG = {
  cloudRelayUrl: 'wss://swiftsync-relay.fly.dev',
  cloudPublicUrl: 'https://swiftsync-relay.fly.dev'
};

function resolveConfigPath() {
  if (process.env.SWIFTSYNC_RELAY_CONFIG) {
    return process.env.SWIFTSYNC_RELAY_CONFIG;
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

function readJsonUtf8(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

function writeJsonUtf8(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function loadRelayConfig() {
  const configPath = resolveConfigPath();
  try {
    if (!fs.existsSync(configPath)) return { ...defaults, configPath };
    const raw = readJsonUtf8(configPath);
    return {
      configPath,
      cloudRelayUrl: String(raw.cloudRelayUrl || '').trim(),
      cloudPublicUrl: String(raw.cloudPublicUrl || '').trim().replace(/\/$/, '')
    };
  } catch {
    return { ...defaults, configPath };
  }
}

function useCloudRelay(config) {
  return !!(config?.cloudRelayUrl && config?.cloudPublicUrl);
}

/**
 * Create %APPDATA%/SwiftSync/relay-config.json on first run (installer / desktop shortcut).
 */
function ensureRelayConfigFile() {
  const userPath = safeMkdirForFile(userDataFile(FILE_NAME));

  if (fs.existsSync(userPath)) return userPath;

  const bundledCandidates = [];
  if (process.resourcesPath) {
    bundledCandidates.push(path.join(process.resourcesPath, FILE_NAME));
  }
  if (!isInsideAppAsar(__dirname)) {
    bundledCandidates.push(path.join(__dirname, FILE_NAME));
  }
  const example = isInsideAppAsar(__dirname)
    ? null
    : path.join(__dirname, 'relay-config.example.json');
  let content = null;

  const bundled = bundledCandidates.find((p) => p && fs.existsSync(p));
  if (bundled) {
    content = fs.readFileSync(bundled, 'utf8').replace(/^\uFEFF/, '');
  } else if (example && fs.existsSync(example)) {
    try {
      const raw = readJsonUtf8(example);
      if (useCloudRelay(raw)) content = JSON.stringify(raw, null, 2);
    } catch {
      /* use default cloud */
    }
  }
  if (!content) {
    content = `${JSON.stringify(DEFAULT_CLOUD_CONFIG, null, 2)}\n`;
  }

  fs.writeFileSync(userPath, content, 'utf8');
  return userPath;
}

/**
 * Ensure relay-config exists and enable the shipped cloud relay when URLs are blank.
 * Skipped when SWIFTSYNC_DISABLE_CLOUD_RELAY=1 (LAN-only dev).
 */
function ensureCloudRelayConfigured() {
  const userPath = ensureRelayConfigFile();
  if (process.env.SWIFTSYNC_DISABLE_CLOUD_RELAY === '1') return userPath;

  try {
    const raw = readJsonUtf8(userPath);
    const url = String(raw.cloudRelayUrl || '').trim();
    const pub = String(raw.cloudPublicUrl || '').trim();
    if (url && pub) {
      writeJsonUtf8(userPath, { cloudRelayUrl: url, cloudPublicUrl: pub });
      return userPath;
    }
    writeJsonUtf8(userPath, DEFAULT_CLOUD_CONFIG);
  } catch {
    writeJsonUtf8(userPath, DEFAULT_CLOUD_CONFIG);
  }
  return userPath;
}

module.exports = {
  loadRelayConfig,
  useCloudRelay,
  resolveConfigPath,
  ensureRelayConfigFile,
  ensureCloudRelayConfigured,
  defaults,
  DEFAULT_CLOUD_CONFIG
};

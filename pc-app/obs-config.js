const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORTS = [4455, 4444];
function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parseIniValue(content, section, key) {
  const sectionRe = new RegExp(`\\[${section}\\][\\s\\S]*?(?=\\[|$)`, 'i');
  const match = content.match(sectionRe);
  if (!match) return null;
  const lineRe = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'im');
  const line = match[0].match(lineRe);
  return line ? line[1].trim() : null;
}

function getObsBaseDirs() {
  const dirs = [];
  if (process.env.APPDATA) {
    dirs.push(path.join(process.env.APPDATA, 'obs-studio'));
  }
  dirs.push(path.join(os.homedir(), 'AppData', 'Roaming', 'obs-studio'));
  return [...new Set(dirs.filter((d) => d && fs.existsSync(d)))];
}

function getPrimaryLanIp() {
  const nets = os.networkInterfaces();
  const candidates = [];

  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const net of entries) {
      if (net.family !== 'IPv4' && net.family !== 4) continue;
      if (net.internal) continue;
      candidates.push(net.address);
    }
  }

  return candidates[0] || DEFAULT_HOST;
}

function parseWebSocketJson(configPath) {
  const raw = readJsonSafe(configPath);
  if (!raw || typeof raw !== 'object') return null;

  const port = raw.server_port ?? raw.port ?? raw.ServerPort;
  const password =
    raw.auth_secret ??
    raw.server_password ??
    raw.password ??
    raw.auth_password ??
    '';
  const bindHost =
    raw.server_ip ??
    raw.server_bind_ip ??
    raw.bind_address ??
    raw.bind_ip ??
    raw.server_host ??
    null;

  return {
    source: configPath,
    host: bindHost != null ? String(bindHost) : null,
    port: port != null ? String(port) : null,
    password: typeof password === 'string' ? password : String(password || ''),
    authRequired: raw.auth_required !== false,
    serverEnabled: raw.server_enabled !== false
  };
}

function parseGlobalIni(iniPath) {
  try {
    const content = fs.readFileSync(iniPath, 'utf8');
    const port = parseIniValue(content, 'OBSWebSocket', 'Port');
    const password = parseIniValue(content, 'OBSWebSocket', 'Password');
    const bindHost =
      parseIniValue(content, 'OBSWebSocket', 'BindIP') ||
      parseIniValue(content, 'OBSWebSocket', 'ServerIP') ||
      parseIniValue(content, 'OBSWebSocket', 'Host');
    if (!port && !password && !bindHost) return null;
    return {
      source: iniPath,
      host: bindHost || null,
      port: port ? String(port) : null,
      password: password || '',
      authRequired: !!password,
      serverEnabled: true
    };  } catch {
    return null;
  }
}

function loadObsWebSocketSettings() {
  const candidates = [];

  for (const base of getObsBaseDirs()) {
    candidates.push(
      path.join(base, 'plugin_config', 'obs-websocket', 'config.json'),
      path.join(base, 'plugin_config', 'obs-websocket', 'config.ini')
    );
    const globalIni = path.join(base, 'global.ini');
    if (fs.existsSync(globalIni)) {
      const legacy = parseGlobalIni(globalIni);
      if (legacy) candidates.push(legacy);
    }
  }

  for (const item of candidates) {
    if (typeof item === 'object' && item !== null && item.source) {
      return normalizeSettings(item);
    }
    if (typeof item === 'string' && fs.existsSync(item)) {
      const parsed = parseWebSocketJson(item);
      if (parsed) return normalizeSettings(parsed);
    }
  }

  return normalizeSettings({
    source: null,
    host: DEFAULT_HOST,
    port: String(DEFAULT_PORTS[0]),
    password: '',
    authRequired: false,
    serverEnabled: true
  });
}

function normalizeSettings(partial) {
  const configuredHost = partial.host ? String(partial.host).trim() : '';
  const host =
    configuredHost && configuredHost !== '0.0.0.0' && configuredHost !== '::'
      ? configuredHost
      : DEFAULT_HOST;

  return {
    source: partial.source || null,
    host,
    port: partial.port || String(DEFAULT_PORTS[0]),
    password: partial.password || '',
    authRequired: partial.authRequired !== false,
    serverEnabled: partial.serverEnabled !== false,
    foundOnDisk: !!partial.source,
    lanIp: getPrimaryLanIp()
  };
}

function getObsFieldFromDisk(field) {
  const settings = loadObsWebSocketSettings();

  switch (field) {
    case 'host':
      return {
        value: settings.host || DEFAULT_HOST,
        foundOnDisk: settings.foundOnDisk,
        hint: settings.foundOnDisk
          ? 'IP from OBS WebSocket settings'
          : `OBS config not found — using ${DEFAULT_HOST}`
      };
    case 'port':
      return {
        value: settings.port || String(DEFAULT_PORTS[0]),
        foundOnDisk: settings.foundOnDisk,
        hint: settings.foundOnDisk ? 'Port from OBS WebSocket settings' : 'OBS config not found — using port 4455'
      };
    case 'password':
      return {
        value: settings.password || '',
        foundOnDisk: settings.foundOnDisk,
        hint: settings.foundOnDisk ? 'Password from OBS WebSocket settings' : 'OBS config not found — password cleared'
      };
    default:
      return { value: '', foundOnDisk: false, hint: 'Unknown field' };
  }
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORTS,
  getObsFieldFromDisk,
  getPrimaryLanIp,
  loadObsWebSocketSettings
};
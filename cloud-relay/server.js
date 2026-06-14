/**
 * SwiftSync Cloud Relay
 *
 * Hosts the mobile web UI and relays WebSocket messages between PC and phone.
 * Both devices connect outbound — works on Wi‑Fi and cellular, no port forwarding.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const FLY_INSTANCE_ID = process.env.FLY_MACHINE_ID || process.env.FLY_ALLOC_ID || null;
const APP_ROOT = __dirname;
const PC_APP_ROOT = process.env.PC_APP_ROOT
  ? path.resolve(process.env.PC_APP_ROOT)
  : process.env.MOBILE_ROOT
    ? path.resolve(process.env.MOBILE_ROOT)
    : path.join(APP_ROOT, '..', 'pc-app');
let QRCodeLib = null;
try {
  QRCodeLib = require(path.join(PC_APP_ROOT, 'node_modules', 'qrcode'));
} catch (_) {}

const { handleTiktokWsJwt, handleTiktokChat } = require(path.join(
  PC_APP_ROOT,
  'chat',
  'tiktok-relay-api'
));
const { createCloudChatManager } = require('./cloud-chat-session');
const { createMobileOAuth } = require('./mobile-oauth');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

function generatePairingCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function normalizePairingCode(code) {
  const c = String(code || '')
    .trim()
    .toUpperCase();
  return /^[0-9A-F]{8}$/.test(c) ? c : null;
}

function getOrCreateRoomForCode(relay, code) {
  const normalized = normalizePairingCode(code);
  if (!normalized) return null;

  let room = relay.getRoomByCode(normalized);
  if (!room) {
    room = createRoom(normalized);
    relay.rooms.set(normalized, room);
  }
  return room;
}

function publicWsUrl(req) {
  if (PUBLIC_URL) {
    return PUBLIC_URL.replace(/^http/i, 'ws').replace(/^https/i, 'wss');
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const wsProto = proto === 'https' ? 'wss' : 'ws';
  return `${wsProto}://${host}`;
}

function publicHttpUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${host}`;
}

function buildPairingPayload(req, port, pairingCode) {
  const httpBase = publicHttpUrl(req);
  const relay = publicWsUrl(req);
  const mobileUrl = `${httpBase}/mobile/?code=${pairingCode}&relay=${encodeURIComponent(relay)}`;
  return {
    type: 'pairingInfo',
    code: pairingCode,
    port,
    host: null,
    relay,
    mobileUrl,
    httpUrl: `${httpBase}/mobile/`,
    cloud: true,
    flyInstanceId: FLY_INSTANCE_ID
  };
}

function stampFlyReplay(res) {
  if (FLY_INSTANCE_ID) {
    res.setHeader('Fly-Replay-Instance', FLY_INSTANCE_ID);
  }
}

function createObsStateStore() {
  let snapshot = { updatedAt: 0, obsConnected: false, payload: null };
  return {
    set(payload) {
      if (!payload || typeof payload !== 'object') return;
      const online =
        payload.obsConnected === true ||
        payload.obsOnline === true ||
        payload.type === 'obsConnected' ||
        !!(payload.scenes?.length || payload.sceneLinks?.length);
      snapshot = { updatedAt: Date.now(), obsConnected: online, payload };
    },
    get() {
      return snapshot;
    },
    clear() {
      snapshot = { updatedAt: 0, obsConnected: false, payload: null };
    }
  };
}

function createSceneSourcesStore() {
  let snapshot = { updatedAt: 0, sceneName: null, panels: [] };
  return {
    set(payload) {
      if (!payload || typeof payload !== 'object') return;
      snapshot = {
        updatedAt: Date.now(),
        sceneName: payload.sceneName || null,
        panels: Array.isArray(payload.panels) ? payload.panels : []
      };
    },
    get() {
      return snapshot;
    },
    clear() {
      snapshot = { updatedAt: 0, sceneName: null, panels: [] };
    }
  };
}

function createAudioStore() {
  let snapshot = { updatedAt: 0, inputs: [] };
  return {
    set(payload) {
      if (!payload || typeof payload !== 'object') return;
      if (Array.isArray(payload.inputs)) {
        snapshot = { updatedAt: Date.now(), inputs: payload.inputs };
      }
    },
    patchVolume(inputName, volumeDb, volumeMul) {
      if (!inputName) return;
      const inputs = snapshot.inputs.map((i) =>
        i.inputName === inputName
          ? {
              ...i,
              volumeDb: volumeDb != null ? volumeDb : i.volumeDb,
              volumeMul: volumeMul != null ? volumeMul : i.volumeMul
            }
          : i
      );
      snapshot = { updatedAt: Date.now(), inputs };
    },
    patchMute(inputName, muted) {
      if (!inputName) return;
      const inputs = snapshot.inputs.map((i) =>
        i.inputName === inputName ? { ...i, muted: !!muted } : i
      );
      snapshot = { updatedAt: Date.now(), inputs };
    },
    get() {
      return snapshot;
    },
    clear() {
      snapshot = { updatedAt: 0, inputs: [] };
    }
  };
}

function createChatStore() {
  let snapshot = {
    updatedAt: 0,
    messages: [],
    channel: null,
    connected: false,
    statuses: {},
    platforms: []
  };
  return {
    set(payload) {
      if (!payload || typeof payload !== 'object') return;
      snapshot = {
        updatedAt: Date.now(),
        messages: Array.isArray(payload.messages) ? payload.messages : snapshot.messages,
        channel: payload.channel != null ? payload.channel : snapshot.channel,
        connected: payload.connected != null ? !!payload.connected : snapshot.connected,
        statuses:
          payload.statuses && typeof payload.statuses === 'object'
            ? payload.statuses
            : snapshot.statuses,
        platforms: Array.isArray(payload.platforms) ? payload.platforms : snapshot.platforms
      };
    },
    appendMessage(message) {
      if (!message || typeof message !== 'object') return;
      const messages = snapshot.messages.slice();
      messages.push(message);
      while (messages.length > 300) messages.shift();
      snapshot = {
        ...snapshot,
        updatedAt: Date.now(),
        messages
      };
    },
    get() {
      return snapshot;
    },
    clear() {
      snapshot = {
        updatedAt: 0,
        messages: [],
        channel: null,
        connected: false,
        statuses: {},
        platforms: []
      };
    }
  };
}

function safePath(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = decoded.replace(/^\/+/, '');
  const resolved = path.normalize(path.join(root, relative));
  if (!resolved.startsWith(path.normalize(root))) return null;
  return resolved;
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];

  if (urlPath === '/site') {
    const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.writeHead(302, { Location: `/site/${q}` });
    res.end();
    return;
  }

  if (urlPath === '/' || urlPath === '') {
    const welcomePath = path.join(PC_APP_ROOT, 'mobile', 'welcome.html');
    if (fs.existsSync(welcomePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      fs.createReadStream(welcomePath).pipe(res);
      return;
    }
    res.writeHead(302, { Location: '/mobile/' });
    res.end();
    return;
  }

  if (urlPath === '/welcome' || urlPath === '/welcome.html') {
    const welcomePath = path.join(PC_APP_ROOT, 'mobile', 'welcome.html');
    if (fs.existsSync(welcomePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      fs.createReadStream(welcomePath).pipe(res);
      return;
    }
  }

  if (urlPath === '/mobile') {
    const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.writeHead(302, { Location: `/mobile/${q}` });
    res.end();
    return;
  }

  const rootIconPaths = [
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png',
    '/favicon.ico'
  ];
  if (rootIconPaths.includes(urlPath)) {
    const name = urlPath === '/favicon.ico' ? 'favicon.ico' : 'apple-touch-icon.png';
    const iconPath = path.join(PC_APP_ROOT, 'mobile', name);
    if (fs.existsSync(iconPath)) {
      const ext = path.extname(iconPath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache, must-revalidate'
      });
      fs.createReadStream(iconPath).pipe(res);
      return;
    }
  }

  if (urlPath === '/assets/logo.png') {
    const logoCandidates = [
      path.join(PC_APP_ROOT, 'assets', 'Copilot_20260522_174446.png'),
      path.join(PC_APP_ROOT, 'assets', 'logo.png')
    ];
    const logoPath = logoCandidates.find((p) => fs.existsSync(p));
    if (logoPath) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(logoPath).pipe(res);
      return;
    }
  }

  let root = APP_ROOT;
  let filePath;

  if (urlPath.startsWith('/mobile')) {
    root = path.join(PC_APP_ROOT, 'mobile');
    let rel = urlPath.replace(/^\/mobile\/?/, '');
    if (!rel || rel.endsWith('/')) rel = `${rel}index.html`.replace(/^\//, '');
    filePath = safePath(root, rel || 'index.html');
  } else if (urlPath === '/vendor/qrcode.min.js') {
    const qrCandidates = [
      path.join(PC_APP_ROOT, 'shared', 'qrcode.min.js'),
      path.join(PC_APP_ROOT, 'vendor', 'qrcode.min.js'),
      path.join(PC_APP_ROOT, 'node_modules', 'qrcode', 'build', 'qrcode.min.js')
    ];
    filePath = qrCandidates.find((p) => fs.existsSync(p));
    if (!filePath) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(filePath).pipe(res);
    return;
  } else if (urlPath.startsWith('/site')) {
    root = path.join(PC_APP_ROOT, 'site');
    let rel = urlPath.replace(/^\/site\/?/, '');
    if (!rel) rel = 'index.html';
    else if (rel.endsWith('/')) rel = `${rel}index.html`;
    else if (!path.extname(rel) && fs.existsSync(path.join(root, rel, 'index.html'))) {
      rel = `${rel}/index.html`;
    }
    filePath = safePath(root, rel);
  } else if (urlPath.startsWith('/shared')) {
    root = path.join(PC_APP_ROOT, 'shared');
    filePath = safePath(root, urlPath.replace(/^\/shared\/?/, ''));
  } else if (urlPath.startsWith('/assets')) {
    root = path.join(PC_APP_ROOT, 'assets');
    filePath = safePath(root, urlPath.replace(/^\/assets\/?/, ''));
  } else {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (filePath.endsWith('manifest.json')) {
      headers['Content-Type'] = 'application/manifest+json; charset=utf-8';
    }
    if (ext === '.js' || ext === '.css' || ext === '.html' || ext === '.png' || ext === '.ico') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function createRoom(code) {
  return {
    code,
    pc: null,
    mobiles: new Set(),
    chatConfigStored: null,
    obsStateStore: createObsStateStore(),
    sceneSourcesStore: createSceneSourcesStore(),
    audioStore: createAudioStore(),
    chatStore: createChatStore(),
    lastPcObsBroadcast: null,
    lastCanvasPreview: null,
    createdAt: Date.now(),
    lastActivityAt: Date.now()
  };
}

function createRelayState(cloudChatRef) {
  const rooms = new Map();
  const wsToRoom = new Map();
  const wsRole = new Map();

  function getRoomByCode(code) {
    return rooms.get((code || '').toUpperCase()) || null;
  }

  function touchRoom(room) {
    if (room) room.lastActivityAt = Date.now();
  }

  function assignPcToRoom(ws, room) {
    if (room.pc && room.pc !== ws && room.pc.readyState === WebSocket.OPEN) {
      room.pc.close(4000, 'Replaced by new PC session');
    }
    room.pc = ws;
    wsToRoom.set(ws, room);
    wsRole.set(ws, 'pc');
  }

  function removeWs(ws) {
    const room = wsToRoom.get(ws);
    const role = wsRole.get(ws);
    wsToRoom.delete(ws);
    wsRole.delete(ws);

    if (!room) return;

    if (role === 'pc' && room.pc === ws) {
      room.pc = null;
      room.obsStateStore.clear();
      room.sceneSourcesStore.clear();
      room.audioStore.clear();
      room.lastCanvasPreview = null;
      room.lastPcObsBroadcast = null;
      const offline = JSON.stringify({
        type: 'obsState',
        obsConnected: false,
        obsOnline: false,
        message: 'PC disconnected — cloud chat may still work in Chat-only mode.'
      });
      room.mobiles.forEach((m) => {
        if (m.readyState !== WebSocket.OPEN) return;
        if (m._chatOnly && cloudChatRef?.current?.hasConfig?.(room)) {
          m.send(offline);
          return;
        }
        m.send(
          JSON.stringify({
            type: 'obsState',
            obsConnected: false,
            obsOnline: false,
            message: 'PC disconnected — open SwiftSync on your streaming PC.'
          })
        );
        m.close(4002, 'PC disconnected');
      });
      room.mobiles.forEach((m) => {
        if (m.readyState !== WebSocket.OPEN) return;
        if (!m._chatOnly || !cloudChatRef?.current?.hasConfig?.(room)) {
          room.mobiles.delete(m);
        }
      });
    } else if (role === 'mobile') {
      room.mobiles.delete(ws);
      cloudChatRef?.current?.onMobileLeft?.(room, ws._chatOnly);
    }

    if (!room.pc && room.mobiles.size === 0) {
      cloudChatRef?.current?.stopSession?.(room);
      if (!cloudChatRef?.current?.hasConfig?.(room)) {
        rooms.delete(room.code);
      }
    }
  }

  function relayMobileToPc(room, msg) {
    if (room.pc?.readyState === WebSocket.OPEN) {
      room.pc.send(msg);
      return true;
    }
    return false;
  }

  function relayPcToMobile(room, msg) {
    room.mobiles.forEach((m) => m.readyState === WebSocket.OPEN && m.send(msg));
  }

  function cachePcBroadcast(room, msg, data) {
    if (!data || data.from !== 'pc') return;
    if (
      data.type === 'pong' ||
      data.type === 'obsConnected' ||
      data.type === 'obsState' ||
      data.type === 'scenes'
    ) {
      room.lastPcObsBroadcast = msg;
      room.obsStateStore.set(data);
      // obsState includes a full audio snapshot — mirror it into the audio cache
      if (data.type === 'obsState' && Array.isArray(data.audio)) {
        room.audioStore.set({ inputs: data.audio });
      }
    }
    if (data.type === 'sceneSources') {
      room.sceneSourcesStore.set({
        sceneName: data.sceneName || null,
        panels: data.panels || []
      });
    }
    if (data.type === 'audio' && Array.isArray(data.inputs)) {
      room.audioStore.set({ inputs: data.inputs });
    }
    if (data.type === 'volumeChanged' && data.inputName) {
      room.audioStore.patchVolume(data.inputName, data.volumeDb, data.volumeMul);
    }
    if (data.type === 'muteChanged' && data.inputName) {
      room.audioStore.patchMute(data.inputName, data.muted);
    }
    if (data.type === 'canvasPreview' && data.image) {
      room.lastCanvasPreview = msg;
    }
    if (data.type === 'chat' || data.type === 'chatBatch') {
      room.chatStore.set({
        messages: data.messages || [],
        channel: data.channel || null,
        connected: data.connected != null ? !!data.connected : true,
        statuses: data.statuses || {},
        platforms: data.platforms || []
      });
    }
    if (data.type === 'chatMessage' && data.message) {
      room.chatStore.appendMessage(data.message);
    }
    if (data.type === 'chatStatus') {
      room.chatStore.set({
        channel: data.channel != null ? data.channel : undefined,
        connected: data.connected != null ? !!data.connected : undefined,
        statuses: data.statuses || undefined,
        platforms: data.platforms || undefined
      });
    }
  }

  function shouldReplayCachedObs(room) {
    if (!room.lastPcObsBroadcast) return false;
    try {
      const data = JSON.parse(room.lastPcObsBroadcast.toString());
      if (data.obsConnected === false || data.obsOnline === false) return false;
      return (
        data.type === 'obsConnected' ||
        data.type === 'pong' ||
        data.obsConnected === true ||
        data.obsOnline === true ||
        !!(data.scenes?.length || data.sceneLinks?.length)
      );
    } catch {
      return false;
    }
  }

  function rotateRoomToCode(room, newCode) {
    const normalized = normalizePairingCode(newCode) || generatePairingCode();
    const oldCode = room.code;

    if (normalized !== oldCode && rooms.has(normalized)) {
      const other = rooms.get(normalized);
      if (other !== room && other.pc?.readyState === WebSocket.OPEN) {
        other.pc.close(4000, 'Room replaced');
        other.pc = null;
      }
      if (other !== room) rooms.delete(normalized);
    }

    rooms.delete(oldCode);
    room.code = normalized;
    rooms.set(normalized, room);

    room.mobiles.forEach((m) => {
      if (m.readyState === WebSocket.OPEN) {
        m.send(
          JSON.stringify({
            type: 'error',
            message: 'Pairing code changed on PC — open the app and connect again.'
          })
        );
        m.close(4001, 'Code rotated');
      }
    });
    room.mobiles.clear();
    return normalized;
  }

  function rotateRoomCode(room) {
    return rotateRoomToCode(room, generatePairingCode());
  }

  function stats() {
    let pcCount = 0;
    let mobileCount = 0;
    const roomList = [];
    for (const room of rooms.values()) {
      const pcs = room.pc?.readyState === WebSocket.OPEN ? 1 : 0;
      const mobiles = [...room.mobiles].filter((m) => m.readyState === WebSocket.OPEN).length;
      pcCount += pcs;
      mobileCount += mobiles;
      roomList.push({
        code: room.code.slice(0, 2) + '****',
        pcOnline: pcs > 0,
        mobileCount: mobiles,
        lastActivityAt: room.lastActivityAt,
        obsConnected: room.obsStateStore.get().obsConnected
      });
    }
    return {
      rooms: rooms.size,
      pcConnections: pcCount,
      mobileConnections: mobileCount,
      publicUrl: PUBLIC_URL || null,
      uptimeSec: Math.floor(process.uptime()),
      roomList
    };
  }

  return {
    rooms,
    getRoomByCode,
    createRoom,
    assignPcToRoom,
    removeWs,
    relayMobileToPc,
    relayPcToMobile,
    cachePcBroadcast,
    shouldReplayCachedObs,
    rotateRoomCode,
    rotateRoomToCode,
    touchRoom,
    stats,
    wsToRoom,
    wsRole
  };
}

// ── Server-side OAuth token exchange ──────────────────────────────────────────
// Stores client secrets in env vars so no user ever needs their own dev app.

function oauthPost(tokenUrl, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(tokenUrl);
    const body = Buffer.from(bodyStr, 'utf8');
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + (u.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': body.length,
          'User-Agent': 'SwiftSync-Relay/1.0'
        }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, text: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function exchangeOAuthCode(platform, { code, redirectUri, codeVerifier }) {
  const e = process.env;
  let tokenUrl, params;

  if (platform === 'twitch') {
    if (!e.TWITCH_CLIENT_ID || !e.TWITCH_CLIENT_SECRET)
      throw new Error('Twitch OAuth not configured on relay — set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET');
    tokenUrl = 'https://id.twitch.tv/oauth2/token';
    params = new URLSearchParams({
      client_id: e.TWITCH_CLIENT_ID,
      client_secret: e.TWITCH_CLIENT_SECRET,
      code, grant_type: 'authorization_code',
      redirect_uri: redirectUri, code_verifier: codeVerifier || ''
    });
  } else if (platform === 'kick') {
    if (!e.KICK_CLIENT_ID || !e.KICK_CLIENT_SECRET)
      throw new Error('Kick OAuth not configured on relay — set KICK_CLIENT_ID and KICK_CLIENT_SECRET');
    tokenUrl = 'https://id.kick.com/oauth/token';
    params = new URLSearchParams({
      client_id: e.KICK_CLIENT_ID, client_secret: e.KICK_CLIENT_SECRET,
      code, grant_type: 'authorization_code',
      redirect_uri: redirectUri, code_verifier: codeVerifier || ''
    });
  } else if (platform === 'youtube') {
    if (!e.YOUTUBE_CLIENT_ID || !e.YOUTUBE_CLIENT_SECRET)
      throw new Error('YouTube OAuth not configured on relay — set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET');
    tokenUrl = 'https://oauth2.googleapis.com/token';
    params = new URLSearchParams({
      client_id: e.YOUTUBE_CLIENT_ID, client_secret: e.YOUTUBE_CLIENT_SECRET,
      code, grant_type: 'authorization_code',
      redirect_uri: redirectUri, code_verifier: codeVerifier || ''
    });
  } else if (platform === 'tiktok') {
    if (!e.TIKTOK_CLIENT_KEY || !e.TIKTOK_CLIENT_SECRET)
      throw new Error('TikTok OAuth not configured on relay — set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET');
    tokenUrl = 'https://open.tiktokapis.com/v2/oauth/token/';
    params = new URLSearchParams({
      client_key: e.TIKTOK_CLIENT_KEY, client_secret: e.TIKTOK_CLIENT_SECRET,
      code, grant_type: 'authorization_code',
      redirect_uri: redirectUri, code_verifier: codeVerifier || ''
    });
  } else {
    throw new Error(`Unknown platform: ${platform}`);
  }

  const result = await oauthPost(tokenUrl, params.toString());
  let parsed;
  try { parsed = JSON.parse(result.text); } catch { parsed = {}; }
  if (result.status !== 200) {
    const msg = parsed?.message || parsed?.error_description || parsed?.error || result.text.slice(0, 200);
    throw new Error(`${platform} token exchange failed (${result.status}): ${msg}`);
  }
  return parsed;
}

// ──────────────────────────────────────────────────────────────────────────────

function createHttpHandler(relay, cloudChat, mobileOAuth) {
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 512) {
          reject(new Error('Body too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'));
        } catch {
          reject(new Error('Bad JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function jsonResponse(res, status, body) {
    stampFlyReplay(res);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(body));
  }

  function roomFromRequest(req, res, code) {
    const room = relay.getRoomByCode(code);
    if (!room) {
      jsonResponse(res, 404, { ok: false, message: 'Session not found — scan QR on PC again.' });
      return null;
    }
    return room;
  }

  return function handleHttp(req, res) {
    const urlPath = req.url.split('?')[0];
    const query = new URL(req.url, 'http://local').searchParams;

    if (req.method === 'OPTIONS' && urlPath.startsWith('/api/')) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Fly-Replay-Instance'
      });
      res.end();
      return;
    }

    if (mobileOAuth?.tryHandle(req, res, urlPath)) return;

    if (urlPath === '/api/oauth/status' && req.method === 'GET') {
      jsonResponse(res, 200, {
        ok: true,
        redirectUri: mobileOAuth?.oauthRedirectUri?.(publicHttpUrl(req)) || null,
        platforms: {
          twitch: !!mobileOAuth?.isConfigured?.('twitch'),
          kick: !!mobileOAuth?.isConfigured?.('kick'),
          youtube: !!mobileOAuth?.isConfigured?.('youtube'),
          tiktok: !!mobileOAuth?.isConfigured?.('tiktok')
        }
      });
      return;
    }

    if (urlPath === '/api/health' && req.method === 'GET') {
      jsonResponse(res, 200, { ok: true, service: 'swiftsync-cloud-relay', publicUrl: PUBLIC_URL || null });
      return;
    }

    if (urlPath === '/api/admin/stats' && req.method === 'GET') {
      const token = query.get('token') || req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
        jsonResponse(res, 401, { ok: false, message: 'Unauthorized' });
        return;
      }
      jsonResponse(res, 200, { ok: true, ...relay.stats() });
      return;
    }

    if (urlPath === '/api/obs-state' && req.method === 'GET') {
      const code = query.get('code')?.toUpperCase();
      if (!code) {
        jsonResponse(res, 400, { ok: false, message: 'code query param required' });
        return;
      }
      const room = roomFromRequest(req, res, code);
      if (!room) return;
      jsonResponse(res, 200, room.obsStateStore.get());
      return;
    }

    if (urlPath === '/api/scene-sources' && req.method === 'GET') {
      const code = query.get('code')?.toUpperCase();
      if (!code) {
        jsonResponse(res, 400, { ok: false, message: 'code query param required' });
        return;
      }
      const room = roomFromRequest(req, res, code);
      if (!room) return;
      jsonResponse(res, 200, room.sceneSourcesStore.get());
      return;
    }

    if (urlPath === '/api/audio-inputs' && req.method === 'GET') {
      const code = query.get('code')?.toUpperCase();
      if (!code) {
        jsonResponse(res, 400, { ok: false, message: 'code query param required' });
        return;
      }
      const room = roomFromRequest(req, res, code);
      if (!room) return;
      jsonResponse(res, 200, room.audioStore.get());
      return;
    }

    if (urlPath === '/api/chat' && req.method === 'GET') {
      const code = query.get('code')?.toUpperCase();
      if (!code) {
        jsonResponse(res, 400, { ok: false, message: 'code query param required' });
        return;
      }
      const room = roomFromRequest(req, res, code);
      if (!room) return;
      jsonResponse(res, 200, room.chatStore.get());
      return;
    }

    if (urlPath === '/api/relay-status' && req.method === 'GET') {
      const code = query.get('code')?.toUpperCase();
      const room = code ? relay.getRoomByCode(code) : null;
      jsonResponse(res, 200, {
        ok: true,
        pcLinked: !!(room?.pc?.readyState === WebSocket.OPEN),
        pcCount: room?.pc?.readyState === WebSocket.OPEN ? 1 : 0,
        mobileCount: room
          ? [...room.mobiles].filter((m) => m.readyState === WebSocket.OPEN).length
          : 0,
        cloudChatReady: room ? cloudChat.hasConfig(room) : false,
        flyInstanceId: FLY_INSTANCE_ID
      });
      return;
    }

    if (urlPath === '/api/chat-config/status' && req.method === 'GET') {
      const code = query.get('code')?.toUpperCase();
      if (!code) {
        jsonResponse(res, 400, { ok: false, message: 'code query param required' });
        return;
      }
      const room = relay.getRoomByCode(code) || getOrCreateRoomForCode(relay, code);
      jsonResponse(res, 200, {
        ok: true,
        ready: cloudChat.hasConfig(room),
        updatedAt: room.chatConfigStored?.updatedAt || null
      });
      return;
    }

    if (urlPath === '/api/chat-config' && req.method === 'POST') {
      readJsonBody(req)
        .then((payload) => {
          const code = normalizePairingCode(payload.pairingCode);
          if (!code) {
            jsonResponse(res, 400, { ok: false, message: 'pairingCode required' });
            return;
          }
          if (!payload.platforms || typeof payload.platforms !== 'object') {
            jsonResponse(res, 400, { ok: false, message: 'platforms required' });
            return;
          }
          const room = getOrCreateRoomForCode(relay, code);
          cloudChat.saveConfig(room, { platforms: payload.platforms });
          relay.touchRoom(room);
          jsonResponse(res, 200, { ok: true, updatedAt: room.chatConfigStored.updatedAt });
        })
        .catch((e) => jsonResponse(res, 400, { ok: false, message: e.message }));
      return;
    }

    if (urlPath === '/api/pairing' && req.method === 'GET') {
      const code = (query.get('code') || '').toUpperCase();
      if (!code) {
        jsonResponse(res, 400, { ok: false, message: 'code query param required' });
        return;
      }
      const payload = buildPairingPayload(req, PORT, code);
      const { type, ...info } = payload;
      if (QRCodeLib && info.mobileUrl) {
        QRCodeLib.toDataURL(info.mobileUrl, { margin: 1, width: 220 })
          .then((qrDataUrl) => jsonResponse(res, 200, { ...info, qrDataUrl }))
          .catch(() => jsonResponse(res, 200, info));
        return;
      }
      jsonResponse(res, 200, info);
      return;
    }

    if (urlPath === '/api/mobile-cmd' && req.method === 'POST') {
      readJsonBody(req)
        .then((payload) => {
          const code = (payload.pairingCode || '').toUpperCase();
          const room = relay.getRoomByCode(code);
          if (!room) {
            jsonResponse(res, 404, { ok: false, message: 'Session not found' });
            return;
          }
          if (!payload.command) {
            jsonResponse(res, 400, { ok: false, message: 'command required' });
            return;
          }
          const { pairingCode, ...rest } = payload;
          const forwarded = relay.relayMobileToPc(room, JSON.stringify({ from: 'mobile', ...rest }));
          if (!forwarded) {
            jsonResponse(res, 503, {
              ok: false,
              message: 'PC app not connected — open SwiftSync on your streaming PC.'
            });
            return;
          }
          relay.touchRoom(room);
          jsonResponse(res, 200, { ok: true });
        })
        .catch((e) => jsonResponse(res, 400, { ok: false, message: e.message }));
      return;
    }

    if (urlPath === '/api/tiktok/ws-jwt' && req.method === 'POST') {
      handleTiktokWsJwt(req, res, readJsonBody, jsonResponse);
      return;
    }

    if (urlPath === '/api/tiktok/chat' && req.method === 'POST') {
      handleTiktokChat(req, res, readJsonBody, jsonResponse);
      return;
    }

    const oauthMatch = urlPath.match(/^\/api\/oauth\/exchange\/(twitch|kick|youtube|tiktok)$/);
    if (oauthMatch && req.method === 'POST') {
      readJsonBody(req)
        .then((body) => exchangeOAuthCode(oauthMatch[1], body))
        .then((token) => jsonResponse(res, 200, { ok: true, token }))
        .catch((err) => jsonResponse(res, 400, { ok: false, error: err.message }));
      return;
    }

    serveStatic(req, res);
  };
}

function attachWebSocketHandlers(wss, relay, port, cloudChat) {
  wss.on('connection', (ws, req) => {
    ws.on('message', async (msg) => {
      try {
        const data = JSON.parse(msg.toString());

        if (data.type === 'role') {
          if (data.role === 'pc') {
            let room = relay.wsToRoom.get(ws);
            const requestedCode = normalizePairingCode(data.pairingCode);

            if (!room && requestedCode) {
              room = getOrCreateRoomForCode(relay, requestedCode);
            }
            if (!room) {
              let code = generatePairingCode();
              while (relay.rooms.has(code)) code = generatePairingCode();
              room = createRoom(code);
              relay.rooms.set(code, room);
            }

            if (
              room.pc &&
              room.pc !== ws &&
              room.pc.readyState === WebSocket.OPEN
            ) {
              room.pc.close(4000, 'Replaced by new PC session');
            }

            relay.assignPcToRoom(ws, room);
            relay.touchRoom(room);
            ws.send(JSON.stringify(buildPairingPayload(req, port, room.code)));
            if (room.mobiles.size > 0) {
              ws.send(JSON.stringify({ type: 'mobileConnected' }));
            }
            console.log(`[relay] PC joined room ${room.code.slice(0, 4)}…`);
            return;
          }

          if (data.role === 'mobile') {
            const code = (data.pairingCode || '').toUpperCase();
            const chatOnly = !!(data.chatOnly || data.chatMode === 'chat');
            let room = relay.getRoomByCode(code);
            if (!room && code) {
              room = getOrCreateRoomForCode(relay, code);
            }
            if (!code || !room) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: 'Invalid pairing code — scan the QR on your PC Home tab.'
                })
              );
              ws.close();
              return;
            }

            const pcOnline = room.pc?.readyState === WebSocket.OPEN;
            const cloudReady = cloudChat.hasConfig(room);

            if (!pcOnline && !chatOnly) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: room
                    ? 'PC not connected — open SwiftSync on your streaming PC first.'
                    : 'Invalid pairing code — scan the QR on your PC Home tab.'
                })
              );
              ws.close();
              return;
            }

            const setupRequired = chatOnly && !pcOnline && !cloudReady;

            ws._chatOnly = chatOnly;
            room.mobiles.add(ws);
            relay.wsToRoom.set(ws, room);
            relay.wsRole.set(ws, 'mobile');
            relay.touchRoom(room);
            cloudChat.onMobileJoined(room, chatOnly);
            ws.send(
              JSON.stringify({
                type: 'paired',
                role: 'mobile',
                pcLinked: pcOnline,
                cloudChat: chatOnly && cloudReady,
                chatOnly,
                setupRequired,
                flyInstanceId: FLY_INSTANCE_ID
              })
            );
            if (relay.shouldReplayCachedObs(room) && room.lastPcObsBroadcast) {
              ws.send(room.lastPcObsBroadcast);
            }
            if (room.lastCanvasPreview) {
              ws.send(room.lastCanvasPreview);
            }
            if (pcOnline) {
              room.pc.send(JSON.stringify({ type: 'mobileConnected' }));
            } else if (chatOnly && cloudReady) {
              cloudChat.startSession(room).catch(() => {});
            }
            const chatSnap = room.chatStore.get();
            if (chatSnap?.messages?.length) {
              ws.send(
                JSON.stringify({
                  from: 'pc',
                  type: 'chat',
                  messages: chatSnap.messages,
                  channel: chatSnap.channel,
                  connected: chatSnap.connected,
                  statuses: chatSnap.statuses || {},
                  platforms: chatSnap.platforms || []
                })
              );
            }
            console.log(
              `[relay] Mobile joined room ${code.slice(0, 4)}…${chatOnly ? ' (chat-only)' : ''}`
            );
            return;
          }
        }

        const room = relay.wsToRoom.get(ws);
        if (!room) return;
        relay.touchRoom(room);

        if (data.type === 'pairing' && data.action === 'rotate') {
          if (relay.wsRole.get(ws) !== 'pc') return;
          const room = relay.wsToRoom.get(ws);
          if (!room) return;
          const newCode = relay.rotateRoomToCode(
            room,
            data.pairingCode || generatePairingCode()
          );
          ws.send(JSON.stringify(buildPairingPayload(req, port, newCode)));
          console.log(`[relay] Rotated room to ${newCode.slice(0, 4)}…`);
          return;
        }

        if (data.from === 'pc') {
          if (data.type === 'relayPing') return;
          relay.cachePcBroadcast(room, msg, data);
          relay.relayPcToMobile(room, msg);
        } else if (data.from === 'mobile') {
          if (data.command === 'ping') {
            if (relay.shouldReplayCachedObs(room) && room.lastPcObsBroadcast) {
              ws.send(room.lastPcObsBroadcast);
            }
          }
          if (relay.relayMobileToPc(room, msg)) {
            return;
          }
          if (await cloudChat.handleMobileCommand(room, ws, data)) {
            return;
          }
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'PC app not connected — open SwiftSync on your streaming PC.'
            })
          );
        }
      } catch (e) {
        console.error('[relay] Bad message', e.message);
      }
    });

    ws.on('close', () => {
      const room = relay.wsToRoom.get(ws);
      const role = relay.wsRole.get(ws);
      relay.removeWs(ws);
      if (room && role === 'pc') {
        console.log(`[relay] PC left room ${room.code.slice(0, 4)}…`);
      }
      if (room && role === 'mobile') {
        const remaining = [...room.mobiles].filter((m) => m.readyState === WebSocket.OPEN).length;
        if (remaining === 0 && room.pc?.readyState === WebSocket.OPEN) {
          room.pc.send(JSON.stringify({ type: 'mobileDisconnected' }));
        }
      }
    });
  });
}

function startServer() {
  const cloudChatRef = { current: null };
  const relay = createRelayState(cloudChatRef);
  cloudChatRef.current = createCloudChatManager({
    relayPcToMobile: relay.relayPcToMobile,
    updateChatStore: (room, payload) => {
      room.chatStore.set({
        messages: payload.messages || [],
        channel: payload.channel || null,
        connected: payload.connected != null ? !!payload.connected : true,
        statuses: payload.statuses || {},
        platforms: payload.platforms || []
      });
    },
    getPublicHttpBase: () => PUBLIC_URL
  });
  const cloudChat = cloudChatRef.current;
  const mobileOAuth = createMobileOAuth({
    exchangeOAuthCode,
    getPublicHttpUrl: publicHttpUrl,
    normalizePairingCode,
    getOrCreateRoomForCode,
    cloudChat,
    relay
  });
  const httpServer = http.createServer(createHttpHandler(relay, cloudChat, mobileOAuth));
  const wss = new WebSocket.Server({ server: httpServer });

  attachWebSocketHandlers(wss, relay, PORT, cloudChat);

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`SwiftSync cloud relay listening on :${PORT}`);
    if (PUBLIC_URL) {
      console.log(`Public URL: ${PUBLIC_URL}`);
      console.log(`Mobile UI:  ${PUBLIC_URL}/mobile/`);
    } else {
      console.warn('PUBLIC_URL not set — QR codes will use request Host header. Set PUBLIC_URL in production.');
    }
    if (!ADMIN_TOKEN) {
      console.warn('ADMIN_TOKEN not set — /api/admin/stats is disabled.');
    }
  });

  return { httpServer, wss, relay };
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, generatePairingCode, PUBLIC_URL };

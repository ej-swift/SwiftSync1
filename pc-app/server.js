const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { handleTiktokWsJwt, handleTiktokChat } = require('./chat/tiktok-relay-api');
const { getPersistentPairingCode } = require('./pairing-store');

let QRCodeLib = null;
try {
  QRCodeLib = require('qrcode');
} catch (_) {}

const DEFAULT_PORT = 4000;

function resolveAppRoot() {
  const envRoot = process.env.SWIFTSYNC_APP_ROOT;
  if (envRoot && fs.existsSync(path.join(envRoot, 'mobile', 'index.html'))) {
    return envRoot;
  }
  if (process.resourcesPath) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked');
    if (fs.existsSync(path.join(unpacked, 'mobile', 'index.html'))) {
      return unpacked;
    }
  }
  return __dirname;
}

function getAppRoot() {
  return resolveAppRoot();
}

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
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function normalizePairingCode(code) {
  const c = String(code || '')
    .trim()
    .toUpperCase();
  return /^[0-9A-F]{6,8}$/.test(c) ? c : null;
}

function isVirtualInterface(name) {
  return /virtual|vmware|vbox|vethernet|hyper-v|wsl|npcap|tap|tun|nord|wireguard|hamachi|zerotier|loopback|bluetooth/i.test(
    String(name || '')
  );
}

function isPrivateIpv4(addr) {
  return (
    /^192\.168\./.test(addr) ||
    /^10\./.test(addr) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(addr)
  );
}

function getLocalIpAddress() {
  const nets = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(nets)) {
    if (isVirtualInterface(name)) continue;
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const addr = net.address;
      let score = 0;
      if (isPrivateIpv4(addr)) score += 10;
      if (/wi-?fi|wlan|wireless/i.test(name)) score += 5;
      if (/ethernet|eth/i.test(name)) score += 4;
      candidates.push({ addr, score, name });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length) return candidates[0].addr;

  // Fallback: any non-internal IPv4
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function isLocalRequest(req) {
  const addr = req.socket.remoteAddress || '';
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.endsWith('127.0.0.1')
  );
}

function createObsStateStore() {
  let snapshot = {
    updatedAt: 0,
    obsConnected: false,
    payload: null
  };

  return {
    set(payload) {
      if (!payload || typeof payload !== 'object') return;
      const online =
        payload.obsConnected === true ||
        payload.obsOnline === true ||
        payload.type === 'obsConnected' ||
        !!(payload.scenes?.length || payload.sceneLinks?.length);
      snapshot = {
        updatedAt: Date.now(),
        obsConnected: online,
        payload
      };
    },
    get() {
      return snapshot;
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
    }
  };
}

function createAudioInputsStore() {
  let snapshot = { updatedAt: 0, inputs: [] };
  return {
    set(payload) {
      if (!payload || typeof payload !== 'object') return;
      snapshot = {
        updatedAt: Date.now(),
        inputs: Array.isArray(payload.inputs) ? payload.inputs : []
      };
    },
    get() {
      return snapshot;
    }
  };
}

function createChatStore() {
  let snapshot = {
    updatedAt: 0,
    messages: [],
    channel: null,
    connected: false,
    canSend: false,
    sendPlatforms: [],
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
        canSend: payload.canSend != null ? !!payload.canSend : snapshot.canSend,
        sendPlatforms: Array.isArray(payload.sendPlatforms)
          ? payload.sendPlatforms
          : snapshot.sendPlatforms,
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
    }
  };
}

function buildPairingPayload(port, pairingCode) {
  const host = getLocalIpAddress();
  const relay = `ws://${host}:${port}`;
  const mobileUrl = `http://${host}:${port}/mobile/?host=${host}&port=${port}&code=${pairingCode}`;
  return {
    type: 'pairingInfo',
    code: pairingCode,
    port,
    host,
    relay,
    mobileUrl,
    httpUrl: `http://${host}:${port}/mobile/`
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

  if (urlPath === '/' || urlPath === '') {
    res.writeHead(302, { Location: '/mobile/' });
    res.end();
    return;
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
    const iconPath = path.join(getAppRoot(), 'mobile', name);
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
      path.join(getAppRoot(), 'assets', 'Copilot_20260522_174446.png'),
      path.join(getAppRoot(), 'assets', 'logo.png')
    ];
    const logoPath = logoCandidates.find((p) => fs.existsSync(p));
    if (logoPath) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      fs.createReadStream(logoPath).pipe(res);
      return;
    }
  }

  let root = getAppRoot();
  let filePath;

  if (urlPath.startsWith('/pc')) {
    root = getAppRoot();
    let rel = urlPath.replace(/^\/pc\/?/, '');
    if (!rel || rel.endsWith('/')) rel = 'index.html';
    filePath = safePath(root, rel || 'index.html');
  } else if (urlPath.startsWith('/mobile')) {
    root = path.join(getAppRoot(), 'mobile');
    let rel = urlPath.replace(/^\/mobile\/?/, '');
    if (!rel || rel.endsWith('/')) rel = `${rel}index.html`.replace(/^\//, '');
    filePath = safePath(root, rel || 'index.html');
  } else if (urlPath.startsWith('/dock')) {
    root = path.join(getAppRoot(), 'dock');
    let rel = urlPath.replace(/^\/dock\/?/, '');
    if (!rel || rel.endsWith('/')) rel = 'chat.html';
    filePath = safePath(root, rel || 'chat.html');
  } else if (urlPath === '/vendor/qrcode.min.js') {
    const qrCandidates = [
      path.join(getAppRoot(), 'vendor', 'qrcode.min.js'),
      path.join(getAppRoot(), 'node_modules', 'qrcode', 'build', 'qrcode.min.js')
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
  } else if (urlPath.startsWith('/shared')) {
    root = path.join(getAppRoot(), 'shared');
    filePath = safePath(root, urlPath.replace(/^\/shared\/?/, ''));
  } else if (urlPath.startsWith('/assets')) {
    root = path.join(getAppRoot(), 'assets');
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

function createHttpHandler(stores, relayBridge) {
  const { obsStateStore, sceneSourcesStore, audioInputsStore, chatStore } = stores;

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
        } catch (e) {
          reject(new Error('Bad JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function jsonResponse(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(body));
  }

  return function handleHttp(req, res) {
    const urlPath = req.url.split('?')[0];

    if (req.method === 'OPTIONS' && urlPath.startsWith('/api/')) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    if (urlPath === '/api/obs-state' && req.method === 'GET') {
      jsonResponse(res, 200, obsStateStore.get());
      return;
    }

    if (urlPath === '/api/scene-sources' && req.method === 'GET') {
      jsonResponse(res, 200, sceneSourcesStore.get());
      return;
    }

    if (urlPath === '/api/audio-inputs' && req.method === 'GET') {
      jsonResponse(res, 200, audioInputsStore.get());
      return;
    }

    if (urlPath === '/api/chat' && req.method === 'GET') {
      jsonResponse(res, 200, chatStore.get());
      return;
    }

    if (urlPath === '/api/pairing' && req.method === 'GET') {
      const code = relayBridge.getPairingCode();
      const port = relayBridge.getPort ? relayBridge.getPort() : DEFAULT_PORT;
      const payload = buildPairingPayload(port, code || '');
      const { type, ...info } = payload;
      const body = {
        ...info,
        dockUrl: `http://127.0.0.1:${port}/dock/chat.html`
      };
      if (QRCodeLib && body.mobileUrl) {
        QRCodeLib.toDataURL(body.mobileUrl, { margin: 1, width: 220 })
          .then((qrDataUrl) => {
            jsonResponse(res, 200, { ...body, qrDataUrl });
          })
          .catch(() => jsonResponse(res, 200, body));
        return;
      }
      jsonResponse(res, 200, body);
      return;
    }

    if (urlPath === '/api/chat/send' && req.method === 'POST') {
      if (!isLocalRequest(req)) {
        jsonResponse(res, 403, { ok: false, message: 'Local only' });
        return;
      }
      readJsonBody(req)
        .then((payload) => {
          const text = String(payload.text || payload.message || '').trim();
          if (!text) {
            jsonResponse(res, 400, { ok: false, message: 'text required' });
            return;
          }
          const forwarded = relayBridge.forwardMobileCommand({
            command: 'sendChat',
            text,
            platform: payload.platform || 'all'
          });
          if (!forwarded) {
            jsonResponse(res, 503, {
              ok: false,
              message: 'SwiftSync PC app not connected — open SwiftSync on this PC.'
            });
            return;
          }
          jsonResponse(res, 200, { ok: true });
        })
        .catch((e) => jsonResponse(res, 400, { ok: false, message: e.message }));
      return;
    }

    if (urlPath === '/api/relay-status' && req.method === 'GET') {
      jsonResponse(res, 200, {
        ok: true,
        pcLinked: relayBridge.getPcCount() > 0,
        pcCount: relayBridge.getPcCount(),
        mobileCount: relayBridge.getMobileCount()
      });
      return;
    }

    if (urlPath === '/api/pc-state' && req.method === 'POST') {
      if (!isLocalRequest(req)) {
        jsonResponse(res, 403, { ok: false, message: 'Local PC app only' });
        return;
      }
      readJsonBody(req)
        .then((payload) => {
          obsStateStore.set(payload);
          jsonResponse(res, 200, { ok: true });
        })
        .catch((e) => jsonResponse(res, 400, { ok: false, message: e.message }));
      return;
    }

    if (urlPath === '/api/scene-sources' && req.method === 'POST') {
      if (!isLocalRequest(req)) {
        jsonResponse(res, 403, { ok: false, message: 'Local PC app only' });
        return;
      }
      readJsonBody(req)
        .then((payload) => {
          sceneSourcesStore.set(payload);
          jsonResponse(res, 200, { ok: true });
        })
        .catch((e) => jsonResponse(res, 400, { ok: false, message: e.message }));
      return;
    }

    if (urlPath === '/api/audio-inputs' && req.method === 'POST') {
      if (!isLocalRequest(req)) {
        jsonResponse(res, 403, { ok: false, message: 'Local PC app only' });
        return;
      }
      readJsonBody(req)
        .then((payload) => {
          audioInputsStore.set(payload);
          jsonResponse(res, 200, { ok: true });
        })
        .catch((e) => jsonResponse(res, 400, { ok: false, message: e.message }));
      return;
    }

    if (urlPath === '/api/chat' && req.method === 'POST') {
      if (!isLocalRequest(req)) {
        jsonResponse(res, 403, { ok: false, message: 'Local PC app only' });
        return;
      }
      readJsonBody(req)
        .then((payload) => {
          chatStore.set(payload);
          jsonResponse(res, 200, { ok: true });
        })
        .catch((e) => jsonResponse(res, 400, { ok: false, message: e.message }));
      return;
    }

    if (urlPath === '/api/mobile-cmd' && req.method === 'POST') {
      readJsonBody(req)
        .then((payload) => {
          const code = (payload.pairingCode || '').toUpperCase();
          const expected = relayBridge.getPairingCode();
          if (!code || !expected || code !== expected) {
            jsonResponse(res, 403, { ok: false, message: 'Invalid pairing code' });
            return;
          }
          if (!payload.command) {
            jsonResponse(res, 400, { ok: false, message: 'command required' });
            return;
          }
          const { pairingCode, ...rest } = payload;
          const forwarded = relayBridge.forwardMobileCommand(rest);
          if (!forwarded) {
            jsonResponse(res, 503, {
              ok: false,
              message: 'PC app not connected to relay — open SwiftSync on your PC.'
            });
            return;
          }
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

    if (urlPath === '/api/health' && req.method === 'GET') {
      jsonResponse(res, 200, { ok: true, service: 'swiftsync-relay' });
      return;
    }

    serveStatic(req, res);
  };
}

function isLocalAddress(addr) {
  if (!addr) return false;
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.endsWith('127.0.0.1')
  );
}

function attachRelayHandlers(wss, stores, port, relayBridge) {
  const { obsStateStore, sceneSourcesStore, audioInputsStore, chatStore } = stores;
  const mobileClients = new Set();
  const pcClients = new Set();
  const dockClients = new Set();
  let pairingCode = getPersistentPairingCode();
  let lastPcObsBroadcast = null;

  function cachePcObsBroadcast(msg, data) {
    if (!data || data.from !== 'pc') return;
    if (
      data.type === 'pong' ||
      data.type === 'obsConnected' ||
      data.type === 'obsState' ||
      data.type === 'scenes'
    ) {
      lastPcObsBroadcast = msg;
      obsStateStore.set(data);
    }
    if (data.type === 'sceneSources') {
      sceneSourcesStore.set({
        sceneName: data.sceneName || null,
        panels: data.panels || []
      });
    }
    if (data.type === 'audio') {
      audioInputsStore.set({
        inputs: data.inputs || []
      });
    }
    if (data.type === 'chat' || data.type === 'chatBatch') {
      chatStore.set({
        messages: data.messages || [],
        channel: data.channel || null,
        connected: data.connected != null ? !!data.connected : true,
        statuses: data.statuses || {},
        platforms: data.platforms || []
      });
    }
    if (data.type === 'chatMessage' && data.message) {
      chatStore.appendMessage(data.message);
    }
    if (data.type === 'chatStatus') {
      chatStore.set({
        channel: data.channel != null ? data.channel : undefined,
        connected: data.connected != null ? !!data.connected : undefined,
        statuses: data.statuses || undefined,
        platforms: data.platforms || undefined
      });
    }
  }

  function shouldReplayCachedObs() {
    if (!lastPcObsBroadcast) return false;
    try {
      const data = JSON.parse(lastPcObsBroadcast.toString());
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

  function replayObsStateToMobile(ws) {
    if (shouldReplayCachedObs()) ws.send(lastPcObsBroadcast);
  }

  function relayPcToMobile(msg) {
    mobileClients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(msg));
  }

  function relayPcToDock(msg) {
    dockClients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(msg));
  }

  function replayChatToDock(ws) {
    const snap = chatStore.get();
    if (!snap.messages?.length && !snap.connected) return;
    ws.send(
      JSON.stringify({
        type: 'chat',
        from: 'pc',
        messages: snap.messages,
        channel: snap.channel,
        connected: snap.connected,
        canSend: snap.canSend,
        sendPlatforms: snap.sendPlatforms,
        statuses: snap.statuses,
        platforms: snap.platforms
      })
    );
  }

  function notifyPcPairing(ws) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(buildPairingPayload(port, pairingCode)));
  }

  function broadcastPairingToPc() {
    pcClients.forEach((c) => notifyPcPairing(c));
  }

  function notifyAllPcMobileConnected() {
    const msg = JSON.stringify({ type: 'mobileConnected' });
    pcClients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(msg));
  }

  wss.on('connection', (ws, req) => {
    ws._remoteAddress = req?.socket?.remoteAddress || '';

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());

        if (data.type === 'role') {
          if (data.role === 'dock') {
            if (!isLocalAddress(ws._remoteAddress)) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: 'OBS dock must load from this PC (127.0.0.1)'
                })
              );
              ws.close();
              return;
            }
            dockClients.add(ws);
            ws.send(JSON.stringify({ type: 'paired', role: 'dock' }));
            replayChatToDock(ws);
            return;
          }

          if (data.role === 'pc') {
            const requested = normalizePairingCode(data.pairingCode);
            if (requested) pairingCode = requested;
            pcClients.add(ws);
            notifyPcPairing(ws);
            if (mobileClients.size > 0) {
              ws.send(JSON.stringify({ type: 'mobileConnected' }));
            }
            return;
          }

          if (data.role === 'mobile') {
            const code = (data.pairingCode || '').toUpperCase();
            if (!code || code !== pairingCode) {
              ws.send(JSON.stringify({ type: 'error', message: 'Invalid pairing code' }));
              ws.close();
              return;
            }
            mobileClients.add(ws);
            ws.send(
              JSON.stringify({
                type: 'paired',
                role: 'mobile',
                pcLinked: pcClients.size > 0
              })
            );
            replayObsStateToMobile(ws);
            notifyAllPcMobileConnected();
            return;
          }
        }

        if (data.type === 'pairing' && data.action === 'rotate') {
          if (!pcClients.has(ws)) return;
          const requested = normalizePairingCode(data.pairingCode);
          pairingCode = requested || generatePairingCode();
          broadcastPairingToPc();
          return;
        }

        if (data.from === 'pc') {
          cachePcObsBroadcast(msg, data);
          relayPcToMobile(msg);
          if (
            data.type === 'chat' ||
            data.type === 'chatBatch' ||
            data.type === 'chatMessage' ||
            data.type === 'chatStatus'
          ) {
            relayPcToDock(msg);
          }
        } else if (data.from === 'mobile') {
          if (data.command === 'ping') replayObsStateToMobile(ws);
          pcClients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(msg));
        }
      } catch (e) {
        console.error('Bad message', e);
      }
    });

    ws.on('close', () => {
      const wasMobile = mobileClients.delete(ws);
      pcClients.delete(ws);
      dockClients.delete(ws);
      if (wasMobile && mobileClients.size === 0) {
        const msg = JSON.stringify({ type: 'mobileDisconnected' });
        pcClients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(msg));
      }
    });
  });

  console.log(`SwiftSync relay on port ${port} · pairing ${pairingCode}`);
  console.log(`Mobile UI: http://${getLocalIpAddress()}:${port}/mobile/`);
  console.log(`OBS chat dock: http://127.0.0.1:${port}/dock/chat.html`);

  relayBridge.getPairingCode = () => pairingCode;
  relayBridge.getPort = () => port;
  relayBridge.getPcCount = () =>
    [...pcClients].filter((c) => c.readyState === WebSocket.OPEN).length;
  relayBridge.getMobileCount = () =>
    [...mobileClients].filter((c) => c.readyState === WebSocket.OPEN).length;
  relayBridge.forwardMobileCommand = (payload) => {
    const msg = JSON.stringify({ from: 'mobile', ...payload });
    let sent = 0;
    pcClients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN) {
        c.send(msg);
        sent += 1;
      }
    });
    return sent;
  };

  return {
    getPairingCode: () => pairingCode,
    rotatePairingCode: () => {
      pairingCode = generatePairingCode();
      broadcastPairingToPc();
      return pairingCode;
    },
    getLocalIp: getLocalIpAddress
  };
}

function startRelayServer(port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    const obsStateStore = createObsStateStore();
    const sceneSourcesStore = createSceneSourcesStore();
    const audioInputsStore = createAudioInputsStore();
    const chatStore = createChatStore();
    const relayBridge = {
      getPairingCode: () => '',
      getPort: () => port,
      getPcCount: () => 0,
      getMobileCount: () => 0,
      forwardMobileCommand: () => 0
    };
    const stores = { obsStateStore, sceneSourcesStore, audioInputsStore, chatStore };
    const httpServer = http.createServer(createHttpHandler(stores, relayBridge));
    let settled = false;

    const failExternal = (reason) => {
      if (settled) return;
      settled = true;
      if (reason) console.warn(reason);
      try {
        httpServer.close();
      } catch (_) {}
      resolve({
        wss: null,
        httpServer: null,
        port,
        external: true,
        getPairingCode: () => null,
        rotatePairingCode: () => null,
        getLocalIp: getLocalIpAddress
      });
    };

    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        failExternal(`Port ${port} already in use — will attach if SwiftSync relay is running there.`);
        return;
      }
      failExternal(`Relay failed: ${err.message}`);
    });

    httpServer.listen(port, '0.0.0.0', () => {
      if (settled) return;
      let wss;
      try {
        wss = new WebSocket.Server({ server: httpServer });
      } catch (err) {
        failExternal(`Relay WebSocket failed: ${err.message}`);
        return;
      }
      wss.on('error', (err) => {
        if (!settled) failExternal(`Relay WebSocket error: ${err.message}`);
      });
      const relay = attachRelayHandlers(wss, stores, port, relayBridge);
      settled = true;
      resolve({
        wss,
        httpServer,
        port,
        external: false,
        obsStateStore,
        sceneSourcesStore,
        audioInputsStore,
        chatStore,
        ...relay
      });
    });
  });
}

if (require.main === module) {
  startRelayServer(DEFAULT_PORT);
}

module.exports = {
  startRelayServer,
  getLocalIpAddress,
  generatePairingCode,
  DEFAULT_PORT
};

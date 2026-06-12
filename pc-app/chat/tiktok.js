const WebSocket = require('ws');

const { EventEmitter } = require('events');

const { postJson } = require('./http-utils');

const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60000;
const RECONNECT_GIVE_UP = 8;
const JWT_REFRESH_BUFFER_MS = 10_000;

function normalizeUsername(username) {
  return String(username || '')
    .replace(/^@+/, '')
    .trim();
}

function authorFromUser(user) {
  if (!user || typeof user !== 'object') return null;
  const nick = String(
    user.nickname || user.displayName || user.display_name || user.nickName || ''
  ).trim();
  const id = String(user.uniqueId || user.unique_id || user.username || '').trim();
  if (nick && id && nick.toLowerCase() !== id.toLowerCase()) return `${nick} (@${id})`;
  return nick || id || null;
}

function findUserObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  if (obj.user && typeof obj.user === 'object') return obj.user;
  for (const key of ['data', 'payload', 'content', 'event', 'message']) {
    const nested = obj[key];
    if (nested && typeof nested === 'object') {
      const found = findUserObject(nested, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractCommentText(payload, root) {
  if (typeof payload?.comment === 'string') return payload.comment.trim();
  if (typeof root?.comment === 'string') return root.comment.trim();
  if (typeof payload?.content === 'string') return payload.content.trim();
  if (typeof payload?.text === 'string') return payload.text.trim();
  if (typeof payload?.message === 'string') return payload.message.trim();

  const nested = payload?.comment || payload?.message || root?.comment || root?.message;
  if (nested && typeof nested === 'object') {
    return String(nested.text || nested.msg || nested.content || nested.comment || '').trim();
  }
  return '';
}

function isTiktokChatType(type) {
  const t = String(type || '').toLowerCase();
  if (!t) return false;
  if (t === 'chat' || t === 'webcastchatmessage') return true;
  if (t.includes('chatmessage') && !t.includes('like')) return true;
  return false;
}

function createTiktokConnector() {
  const emitter = new EventEmitter();
  let username = null;
  let apiKey = null;
  let relayHttpBase = null;
  let relayHttpBases = [];
  let jwtKey = null;
  let jwtExpiresAt = 0;
  let roomId = null;
  let ws = null;
  let connected = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let jwtRefreshTimer = null;
  let intentionalClose = false;
  let statusMeta = { connecting: false, reconnecting: false, error: null };

  function hasDirectApiKey() {
    return !!apiKey;
  }

  function hasRelayAuth() {
    return !apiKey && relayBases().length > 0;
  }

  function hasAuth() {
    return hasDirectApiKey() || hasRelayAuth();
  }

  function canSendNow() {
    return !!(roomId && connected && (hasDirectApiKey() || hasRelayAuth()));
  }

  function emitStatus(extra = {}) {
    if (Object.prototype.hasOwnProperty.call(extra, 'connecting')) {
      statusMeta.connecting = !!extra.connecting;
    }
    if (Object.prototype.hasOwnProperty.call(extra, 'reconnecting')) {
      statusMeta.reconnecting = !!extra.reconnecting;
    }
    if (Object.prototype.hasOwnProperty.call(extra, 'error')) {
      statusMeta.error = extra.error || null;
    }
    if (connected) {
      statusMeta.connecting = false;
      statusMeta.reconnecting = false;
      statusMeta.error = null;
    }
    emitter.emit('status', {
      platform: 'tiktok',
      connected,
      channel: username,
      canSend: canSendNow(),
      ...statusMeta,
      ...extra,
      ...(connected ? { connecting: false, reconnecting: false, error: null } : {})
    });
  }

  function markConnected() {
    if (connected) return;
    connected = true;
    reconnectAttempt = 0;
    clearReconnectTimer();
    emitStatus({ connected: true, reconnecting: false, connecting: false, error: null });
  }

  function captureRoomId(data) {
    if (roomId || !data || typeof data !== 'object') return;
    const found =
      data.roomId ||
      data.room_id ||
      data.data?.roomId ||
      data.data?.room_id ||
      data.payload?.roomId ||
      data.payload?.room_id;
    if (found) {
      roomId = String(found);
      markConnected();
    }
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearJwtRefreshTimer() {
    if (jwtRefreshTimer) {
      clearTimeout(jwtRefreshTimer);
      jwtRefreshTimer = null;
    }
  }

  async function refreshJwtInBackground() {
    const token = await fetchWsJwt();
    jwtKey = token.jwt;
    jwtExpiresAt = Date.now() + (token.expiresIn || 60) * 1000;
    scheduleJwtRefresh();
  }

  function scheduleJwtRefresh() {
    clearJwtRefreshTimer();
    if (!hasRelayAuth() || intentionalClose || !username || hasDirectApiKey()) return;
    const delay = Math.max(5000, jwtExpiresAt - Date.now() - JWT_REFRESH_BUFFER_MS);
    jwtRefreshTimer = setTimeout(() => {
      jwtRefreshTimer = null;
      if (intentionalClose || !username || hasDirectApiKey()) return;
      refreshJwtInBackground().catch((err) => {
        emitter.emit('error', err);
        emitStatus({ error: err.message || String(err) });
      });
    }, delay);
  }

  function relayBases() {
    const list = [relayHttpBase, ...(Array.isArray(relayHttpBases) ? relayHttpBases : [])]
      .map((b) => String(b || '').trim().replace(/\/$/, ''))
      .filter(Boolean);
    return [...new Set(list)];
  }

  async function fetchWsJwt() {
    const bases = relayBases();
    if (!bases.length) throw new Error('SwiftSync relay URL missing for TikTok chat');
    let lastErr = null;
    for (const base of bases) {
      try {
        const data = await postJson(`${base}/api/tiktok/ws-jwt`, { uniqueId: username });
        if (data?.ok && data.jwt) {
          relayHttpBase = base;
          return { jwt: data.jwt, expiresIn: Number(data.expiresIn) || 60 };
        }
        lastErr = new Error(data?.message || 'Relay did not return TikTok JWT');
      } catch (err) {
        lastErr = err;
      }
    }
    throw (
      lastErr ||
      new Error(
        'TikTok chat unavailable — go LIVE, set your username, or add an EulerStream API key in Advanced'
      )
    );
  }

  function scheduleReconnect() {
    if (intentionalClose || !username || !hasAuth()) return;
    if (reconnectAttempt >= RECONNECT_GIVE_UP) {
      emitStatus({
        connected: false,
        reconnecting: false,
        connecting: false,
        error: 'TikTok chat unavailable — go LIVE on TikTok, then click Connect'
      });
      return;
    }
    clearReconnectTimer();
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt += 1;
    emitStatus({ reconnecting: true, retryInMs: delay });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket().catch((err) => {
        emitter.emit('error', err);
        emitStatus({ error: err.message || String(err) });
        scheduleReconnect();
      });
    }, delay);
  }

  function isChatEventType(type) {
    const t = String(type || '').toLowerCase();
    return t === 'chat' || t.includes('chatmessage');
  }

  function extractChatText(payload, root) {
    if (typeof payload === 'string') return payload.trim();
    if (typeof root?.comment === 'string') return root.comment.trim();
    if (!payload || typeof payload !== 'object') return '';

    if (typeof payload.comment === 'string') return payload.comment.trim();
    if (typeof payload.content === 'string') return payload.content.trim();
    if (typeof payload.message === 'string') return payload.message.trim();

    const nested = payload.comment || payload.content || payload.message;
    if (typeof nested === 'string') return nested.trim();
    if (nested && typeof nested === 'object') {
      return String(nested.text || nested.msg || nested.content || '').trim();
    }
    return '';
  }

  function formatTiktokAuthor(user, payload, root) {
    const u = user || payload?.user || root?.user;
    if (u && typeof u === 'object') {
      const nick = u.nickname || u.displayName || u.display_name;
      const handle = u.uniqueId || u.unique_id || u.username;
      if (nick) return String(nick).trim();
      if (handle) return String(handle).trim();
    }
    const fallback =
      payload?.nickname ||
      payload?.uniqueId ||
      root?.nickname ||
      root?.uniqueId;
    if (fallback) return String(fallback).trim();
    return 'Viewer';
  }

  function parseChatEvent(data) {
    const events = [];
    if (!data || typeof data !== 'object') return events;

    if (Array.isArray(data.messages)) {
      for (const msg of data.messages) {
        events.push(...parseChatEvent(msg));
      }
      return events;
    }

    const type = data.type || data.event || data.msgType || '';
    const payload =
      data.data && typeof data.data === 'object' && !Array.isArray(data.data)
        ? data.data
        : data;

    const text = extractChatText(payload, data);
    const userObj = payload.user || data.user;
    const isChat = isChatEventType(type) || (text && userObj);

    if (!isChat || !text) return events;

    const author = formatTiktokAuthor(userObj, payload, data);
    events.push({
      id: String(payload.msgId || payload.id || data.id || `${Date.now()}-${author}`),
      platform: 'tiktok',
      author,
      color: userObj?.color || null,
      text,
      timestamp: Date.now()
    });

    return events;
  }

  function handleMessage(raw) {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }

    captureRoomId(data);

    if (
      data.type === 'connected' ||
      data.event === 'connected' ||
      data.type === 'roomInfo' ||
      data.event === 'roomInfo'
    ) {
      markConnected();
      return;
    }

    const chatEvents = parseChatEvent(data);
    if (chatEvents.length) markConnected();
    for (const msg of chatEvents) {
      emitter.emit('message', msg);
    }
  }

  async function openSocket() {
    if (!username || !hasAuth()) return;

    try {
      ws?.close();
    } catch {
      /* ignore */
    }

    roomId = null;
    jwtKey = null;

    let url;
    if (hasDirectApiKey()) {
      url =
        `wss://ws.eulerstream.com?uniqueId=${encodeURIComponent(username)}` +
        `&apiKey=${encodeURIComponent(apiKey)}`;
    } else {
      const token = await fetchWsJwt();
      jwtKey = token.jwt;
      jwtExpiresAt = Date.now() + (token.expiresIn || 60) * 1000;
      url =
        `wss://ws.eulerstream.com?uniqueId=${encodeURIComponent(username)}` +
        `&jwtKey=${encodeURIComponent(jwtKey)}`;
      scheduleJwtRefresh();
    }

    ws = new WebSocket(url);

    ws.on('open', () => {
      connected = false;
      emitStatus({ connecting: true });
      setTimeout(() => {
        if (intentionalClose || ws?.readyState !== WebSocket.OPEN) return;
        if (!connected && (roomId || hasDirectApiKey())) markConnected();
      }, 2500);
    });

    ws.on('message', handleMessage);

    ws.on('close', () => {
      const wasConnected = connected;
      connected = false;
      if (!intentionalClose) {
        emitStatus({
          connected: false,
          reconnecting: true,
          connecting: false,
          error: wasConnected ? null : statusMeta.error
        });
        scheduleReconnect();
      } else {
        roomId = null;
        emitStatus({ connected: false, reconnecting: false, connecting: false });
      }
    });

    ws.on('error', (err) => {
      emitter.emit('error', err);
      emitStatus({ error: err.message || String(err) });
    });
  }

  return {
    connect(config = {}) {
      username = normalizeUsername(config.username);
      apiKey = String(config.apiKey || '').trim();
      relayHttpBases = Array.isArray(config.relayHttpBases) ? config.relayHttpBases : [];
      relayHttpBase =
        String(config.relayHttpBase || '').trim() ||
        String(relayHttpBases[0] || '').trim();

      intentionalClose = false;
      reconnectAttempt = 0;
      clearReconnectTimer();
      clearJwtRefreshTimer();

      if (!username) throw new Error('TikTok username required');

      if (!hasAuth()) {
        connected = false;
        emitStatus({
          error: 'TikTok: sign in with TikTok, then Connect while LIVE',
          hint: relayHttpBase
            ? 'SwiftSync relay TikTok chat is unavailable — check relay configuration'
            : 'Sign in with TikTok above, enable TikTok, then Connect while you are LIVE'
        });
        return;
      }

      openSocket().catch((err) => {
        emitter.emit('error', err);
        emitStatus({ error: err.message || String(err) });
      });
      emitStatus({ connecting: true });
    },

    disconnect() {
      intentionalClose = true;
      clearReconnectTimer();
      clearJwtRefreshTimer();
      connected = false;
      username = null;
      apiKey = null;
      relayHttpBase = null;
      jwtKey = null;
      jwtExpiresAt = 0;
      roomId = null;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
      emitStatus();
    },

    async send(text) {
      if (!canSendNow()) {
        throw new Error('TikTok send requires live stream (EulerStream roomId)');
      }
      const msg = String(text || '').trim();
      if (!msg) throw new Error('Message required');

      if (hasDirectApiKey()) {
        await postJson(
          'https://tiktok.eulerstream.com/webcast/chat',
          { room_id: roomId, message: msg.replace(/\r|\n/g, ' ') },
          { headers: { Authorization: `Bearer ${apiKey}` } }
        );
        return;
      }

      const base = String(relayHttpBase || '').replace(/\/$/, '');
      const data = await postJson(`${base}/api/tiktok/chat`, {
        roomId,
        message: msg.replace(/\r|\n/g, ' ')
      });
      if (data?.ok === false) {
        throw new Error(data.message || 'TikTok chat send failed');
      }
    },

    getStatus() {
      return {
        platform: 'tiktok',
        connected,
        channel: username,
        canSend: canSendNow(),
        needsApiKey: !hasAuth(),
        ...statusMeta,
        reconnecting: statusMeta.reconnecting || !!reconnectTimer
      };
    },

    on(event, cb) {
      emitter.on(event, cb);
      return () => emitter.off(event, cb);
    }
  };
}

module.exports = { createTiktokConnector };

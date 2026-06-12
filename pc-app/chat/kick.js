const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { fetchJson, postJson, unwrapIpcInvokeError } = require('./http-utils');

const PUSHER_URL =
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2';
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const KICK_CHAT_EVENTS = new Set([
  'App\\Events\\ChatMessageEvent',
  'App\\Events\\ChatMessageSentEvent',
  'ChatMessageEvent',
  'ChatMessageSentEvent',
  'ChatMessage'
]);

const KICK_JOIN_EVENTS = new Set([
  'App\\Events\\UserJoinedEvent',
  'App\\Events\\UserJoinedChatEvent',
  'UserJoinedEvent',
  'UserJoinedChatEvent'
]);

function normalizeSlug(channel) {
  let s = String(channel || '').trim();
  const fromUrl = s.match(/kick\.com\/([A-Za-z0-9_-]+)/i);
  if (fromUrl) s = fromUrl[1];
  return s
    .replace(/^@+/, '')
    .trim()
    .toLowerCase();
}

/** Resolve Kick URL slug from saved channel, OAuth token, or broadcaster id. */
async function resolveKickChannelSlug({ channel, accessToken, accountId } = {}) {
  let slug = normalizeSlug(channel);
  if (slug) return slug;

  const token = String(accessToken || '').trim();
  const uid = accountId != null && accountId !== '' ? String(accountId) : '';
  if (!token) return null;

  if (uid) {
    try {
      const chData = await fetchJson(
        `https://api.kick.com/public/v1/channels?broadcaster_user_id=${encodeURIComponent(uid)}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
      );
      const fromApi = chData?.data?.[0]?.slug;
      if (fromApi) return normalizeSlug(fromApi);
    } catch {
      /* try users endpoint */
    }
  }

  try {
    const userData = await fetchJson('https://api.kick.com/public/v1/users', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    const user = userData?.data?.[0] || userData?.data || userData;
    if (!user) return null;
    const userId = user.user_id ?? user.id;
    if (user.slug) return normalizeSlug(user.slug);
    if (user.username) return normalizeSlug(user.username);
    if (userId && String(userId) !== uid) {
      return resolveKickChannelSlug({ channel: '', accessToken: token, accountId: userId });
    }
  } catch {
    /* ignore */
  }

  return null;
}

function kickBrowserHeaders(slug) {
  const s = normalizeSlug(slug) || 'kick';
  return {
    Accept: 'application/json',
    Referer: `https://kick.com/${s}`,
    Origin: 'https://kick.com',
    'Accept-Language': 'en-US,en;q=0.9'
  };
}

function pickChatroomId(row) {
  if (!row || typeof row !== 'object') return null;
  return (
    row.chatroom?.id ??
    row.chatroom_id ??
    row.chatroomId ??
    row.livestream?.chatroom_id ??
    (row.livestream ? row.id : null) ??
    row.id ??
    null
  );
}

/** Resolve chatroom id + canonical slug (OAuth API first, then kick.com). */
async function resolveKickChatroom(channelSlug, { accessToken, accountId } = {}) {
  let slug = normalizeSlug(channelSlug);
  if (!slug) throw new Error('Kick channel slug is empty');

  const token = String(accessToken || '').trim();
  const uid = accountId != null && accountId !== '' ? String(accountId) : '';
  const errors = [];

  if (token && uid) {
    try {
      const byUser = await fetchJson(
        `https://api.kick.com/public/v1/channels?broadcaster_user_id=${encodeURIComponent(uid)}`,
        {
          userAgent: USER_AGENT,
          headers: { ...kickBrowserHeaders(slug), Authorization: `Bearer ${token}` }
        }
      );
      const row = byUser?.data?.[0];
      const id = pickChatroomId(row);
      const apiSlug = row?.slug ? normalizeSlug(row.slug) : slug;
      if (id) return { chatroomId: id, slug: apiSlug };
    } catch (e) {
      errors.push(unwrapIpcInvokeError(e));
    }
  }

  if (token) {
    try {
      const bySlug = await fetchJson(
        `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`,
        {
          userAgent: USER_AGENT,
          headers: { ...kickBrowserHeaders(slug), Authorization: `Bearer ${token}` }
        }
      );
      const row = bySlug?.data?.[0] || bySlug?.data;
      const id = pickChatroomId(row);
      if (id) {
        return { chatroomId: id, slug: row?.slug ? normalizeSlug(row.slug) : slug };
      }
    } catch (e) {
      errors.push(unwrapIpcInvokeError(e));
    }
  }

  try {
    const data = await fetchJson(
      `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`,
      { userAgent: USER_AGENT, headers: kickBrowserHeaders(slug) }
    );
    const id = pickChatroomId(data);
    if (id) return { chatroomId: id, slug };
  } catch (e) {
    errors.push(unwrapIpcInvokeError(e));
  }

  const detail = errors[0] ? ` — ${errors[0]}` : '';
  const blocked = errors.some((e) => /403|security policy/i.test(String(e)));
  const hint = blocked
    ? ' Restart SwiftSync from npm start (Kick blocks non-browser lookups).'
    : token
      ? ' Check Sign in with Browser on Kick, then Connect again.'
      : ' Sign in with Browser on Kick or enter your exact kick.com username.';
  throw new Error(`Could not open Kick chat for "${slug}"${detail}.${hint}`);
}

function createKickConnector() {
  const emitter = new EventEmitter();
  let ws = null;
  let slug = null;
  let chatroomId = null;
  let accessToken = null;
  let accountId = null;
  let connected = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let intentionalClose = false;
  let statusMeta = { connecting: false, error: null, reconnecting: false, retryInMs: null };
  let socketReadyResolve = null;
  let socketReadyReject = null;

  function canSendNow() {
    return !!(accessToken && accountId && connected);
  }

  function emitStatus(extra = {}) {
    if (Object.prototype.hasOwnProperty.call(extra, 'connecting')) {
      statusMeta.connecting = !!extra.connecting;
    }
    if (Object.prototype.hasOwnProperty.call(extra, 'error')) {
      statusMeta.error = extra.error || null;
    }
    if (Object.prototype.hasOwnProperty.call(extra, 'reconnecting')) {
      statusMeta.reconnecting = !!extra.reconnecting;
    }
    if (Object.prototype.hasOwnProperty.call(extra, 'retryInMs')) {
      statusMeta.retryInMs = extra.retryInMs ?? null;
    }
    if (connected) {
      statusMeta.connecting = false;
      statusMeta.error = null;
      statusMeta.reconnecting = false;
    }
    emitter.emit('status', {
      platform: 'kick',
      connected,
      channel: slug,
      canSend: canSendNow(),
      ...statusMeta,
      ...extra
    });
  }

  function settleSocketWait(err) {
    if (err && socketReadyReject) {
      const reject = socketReadyReject;
      socketReadyResolve = null;
      socketReadyReject = null;
      reject(err);
      return;
    }
    if (!err && socketReadyResolve) {
      const resolve = socketReadyResolve;
      socketReadyResolve = null;
      socketReadyReject = null;
      resolve();
    }
  }

  function markConnected() {
    if (connected) return;
    connected = true;
    reconnectAttempt = 0;
    clearReconnectTimer();
    emitStatus({ connected: true, reconnecting: false, connecting: false, error: null });
    settleSocketWait();
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  async function reconnectSocket() {
    if (intentionalClose || !slug || !chatroomId) return;
    emitStatus({ reconnecting: true, connecting: true, connected: false });
    try {
      await openSocket();
      reconnectAttempt = 0;
    } catch (err) {
      emitStatus({ error: err.message || String(err), connected: false });
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (intentionalClose || !slug) return;
    clearReconnectTimer();
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt += 1;
    emitStatus({ reconnecting: true, retryInMs: delay, connected: false });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (chatroomId) {
        reconnectSocket();
        return;
      }
      connect({ channel: slug, accessToken, accountId }).catch((err) => {
        emitStatus({ error: err.message || String(err) });
        scheduleReconnect();
      });
    }, delay);
  }

  function subscribe() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !chatroomId) return;
    const channels = [
      `chatrooms.${chatroomId}.v2`,
      `chatroom_${chatroomId}`,
      `chatrooms.${chatroomId}`
    ];
    for (const channel of channels) {
      ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel } }));
    }
  }

  function emitChatMessage(payload) {
    const data =
      payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
        ? payload.data
        : payload;
    const msgBlock =
      data?.message && typeof data.message === 'object' ? data.message : data;
    const sender = data?.user || msgBlock?.sender || data?.sender || payload?.sender || {};
    const text =
      (typeof msgBlock?.message === 'string' && msgBlock.message) ||
      (typeof msgBlock?.content === 'string' && msgBlock.content) ||
      (typeof data?.message === 'string' && data.message) ||
      (typeof data?.content === 'string' && data.content) ||
      (typeof payload?.content === 'string' && payload.content) ||
      (typeof payload?.message === 'string' && payload.message) ||
      '';
    if (!text) return;
    markConnected();

    const author =
      sender.username ||
      sender.slug ||
      sender.name ||
      msgBlock?.username ||
      payload?.username ||
      payload?.sender_username ||
      'unknown';
    const ts = msgBlock?.created_at
      ? Number(msgBlock.created_at) * (String(msgBlock.created_at).length <= 10 ? 1000 : 1)
      : payload?.created_at
        ? Date.parse(payload.created_at)
        : Date.now();

    emitter.emit('message', {
      id: String(msgBlock?.id || payload?.id || `${ts}-${author}`),
      platform: 'kick',
      author,
      color: sender.identity?.color || payload?.identity?.color || null,
      text,
      timestamp: Number.isFinite(ts) ? ts : Date.now()
    });
  }

  function emitJoinMessage(payload) {
    const data =
      payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
        ? payload.data
        : payload;
    const user = data?.user || data?.sender || payload?.user || payload?.sender || {};
    const author =
      user.username || user.slug || user.name || data?.username || payload?.username || 'Someone';
    const ts = Date.now();
    markConnected();
    emitter.emit('message', {
      id: `join-${ts}-${author}`,
      platform: 'kick',
      author,
      kind: 'join',
      text: `${author} joined`,
      timestamp: ts
    });
  }

  function handlePusherMessage(raw) {
    let envelope;
    try {
      envelope = JSON.parse(String(raw));
    } catch {
      return;
    }

    const event = envelope.event || '';

    if (event === 'pusher:ping') {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
      }
      return;
    }

    if (event === 'pusher:connection_established') {
      subscribe();
      return;
    }

    if (
      event === 'pusher_internal:subscription_succeeded' ||
      event === 'pusher:subscription_succeeded'
    ) {
      markConnected();
      return;
    }

    if (KICK_JOIN_EVENTS.has(event)) {
      let payload;
      try {
        payload = typeof envelope.data === 'string' ? JSON.parse(envelope.data) : envelope.data;
      } catch {
        return;
      }
      emitJoinMessage(payload);
      return;
    }

    if (!KICK_CHAT_EVENTS.has(event)) return;

    let payload;
    try {
      payload = typeof envelope.data === 'string' ? JSON.parse(envelope.data) : envelope.data;
    } catch {
      return;
    }
    emitChatMessage(payload);
  }

  function openSocket() {
    return new Promise((resolve, reject) => {
      socketReadyResolve = resolve;
      socketReadyReject = reject;

      try {
        ws?.close();
      } catch {
        /* ignore */
      }

      const timer = setTimeout(() => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        settleSocketWait(
          new Error('Kick chat timed out — confirm you are live on Kick, then Connect again')
        );
      }, 30000);

      const clearWait = () => clearTimeout(timer);

      ws = new WebSocket(PUSHER_URL);

      ws.on('open', () => {
        connected = false;
        emitStatus({ connecting: true });
      });

      ws.on('message', (raw) => {
        handlePusherMessage(raw);
      });

      ws.on('close', () => {
        clearWait();
        const wasConnected = connected;
        connected = false;
        if (!intentionalClose) {
          emitStatus({ connected: false, connecting: false, reconnecting: true });
          if (!wasConnected && socketReadyReject) {
            settleSocketWait(
              new Error(statusMeta.error || 'Kick chat disconnected before it came online')
            );
          }
          scheduleReconnect();
        } else {
          emitStatus({ connected: false, connecting: false, reconnecting: false });
        }
      });

      ws.on('error', (err) => {
        clearWait();
        emitter.emit('error', err);
        emitStatus({ error: err.message || String(err) });
        settleSocketWait(err);
      });
    });
  }

  return {
    async connect(config = {}) {
      accessToken = String(config.accessToken || config.auth?.accessToken || '').trim();
      accountId = config.accountId || config.auth?.accountId || null;
      slug = await resolveKickChannelSlug({
        channel: config.channel || config.auth?.channel,
        accessToken,
        accountId
      });
      if (!slug) {
        throw new Error(
          'Kick channel not set — click Sign in with Browser on Kick, or paste your kick.com username below'
        );
      }

      intentionalClose = false;
      reconnectAttempt = 0;
      clearReconnectTimer();
      emitStatus({ connecting: true });

      const room = await resolveKickChatroom(slug, { accessToken, accountId });
      slug = room.slug;
      chatroomId = room.chatroomId;
      emitStatus({ channel: slug, connecting: true });
      await openSocket();
    },

    disconnect() {
      intentionalClose = true;
      clearReconnectTimer();
      connected = false;
      slug = null;
      chatroomId = null;
      accessToken = null;
      accountId = null;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
      emitStatus();
    },

    async send(text) {
      if (!canSendNow()) throw new Error('Kick send requires sign-in and live chat');
      const msg = String(text || '').trim();
      if (!msg) throw new Error('Message required');
      await postJson(
        'https://api.kick.com/public/v1/chat',
        {
          broadcaster_user_id: Number(accountId),
          type: 'user',
          content: msg.replace(/\r|\n/g, ' ')
        },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
    },

    getStatus() {
      return {
        platform: 'kick',
        connected,
        channel: slug,
        canSend: canSendNow(),
        ...statusMeta
      };
    },

    on(event, cb) {
      emitter.on(event, cb);
      return () => emitter.off(event, cb);
    }
  };
}

module.exports = {
  createKickConnector,
  resolveKickChannelSlug,
  resolveKickChatroom,
  normalizeSlug
};

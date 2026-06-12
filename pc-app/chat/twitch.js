const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { loadOAuthApps } = require('../chat-oauth-apps');
const { fetchJsonNode } = require('./http-utils');

const AUTH_EXPIRED_MSG =
  'Twitch sign-in expired — use Sign in with Browser on the Chat tab';

const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
const RECONNECT_BASE_MS = 8000;
const RECONNECT_MAX_MS = 90000;
const MAX_MESSAGES = 300;

function normalizeChannel(channel) {
  return String(channel || '')
    .replace(/^#+/, '')
    .trim()
    .toLowerCase();
}

function parseTags(tagStr) {
  const tags = {};
  if (!tagStr) return tags;
  for (const part of tagStr.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) tags[part] = true;
    else tags[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return tags;
}

function parseIrcLine(line) {
  let rest = line;
  let tags = {};
  if (rest.startsWith('@')) {
    const space = rest.indexOf(' ');
    tags = parseTags(rest.slice(1, space));
    rest = rest.slice(space + 1);
  }

  let prefix = '';
  if (rest.startsWith(':')) {
    const space = rest.indexOf(' ');
    prefix = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }

  const cmdEnd = rest.indexOf(' ');
  const command = cmdEnd === -1 ? rest : rest.slice(0, cmdEnd);
  let params = cmdEnd === -1 ? '' : rest.slice(cmdEnd + 1);

  let trailing = '';
  const trailIdx = params.indexOf(' :');
  if (trailIdx !== -1) {
    trailing = params.slice(trailIdx + 2);
    params = params.slice(0, trailIdx);
  }

  const paramList = params ? params.split(' ').filter(Boolean) : [];
  const nick = prefix.includes('!') ? prefix.split('!')[0] : prefix;

  return { tags, command, params: paramList, trailing, nick, prefix };
}

function createTwitchConnector() {
  const emitter = new EventEmitter();
  let ws = null;
  let channel = null;
  let oauthToken = null;
  let username = null;
  let connected = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let intentionalClose = false;
  let authFailed = false;
  let capReady = false;
  let socketReadyResolve = null;
  let socketReadyReject = null;
  let statusMeta = { connecting: false, reconnecting: false, error: null };
  const messages = [];

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

  function pushMessage(msg) {
    messages.push(msg);
    while (messages.length > MAX_MESSAGES) messages.shift();
    emitter.emit('message', msg);
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
    const readOnly = connected && !(oauthToken && username);
    emitter.emit('status', {
      platform: 'twitch',
      connected,
      channel,
      canSend: !!(oauthToken && username && connected),
      readOnly,
      ...statusMeta,
      ...extra,
      ...(connected
        ? { connecting: false, reconnecting: false, error: null, readOnly: !(oauthToken && username) }
        : {})
    });
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (intentionalClose || authFailed || !channel) return;
    clearReconnectTimer();
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt += 1;
    emitStatus({ reconnecting: true, retryInMs: delay });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  }

  function sendRaw(line) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(`${line}\r\n`);
  }

  function anonNick() {
    return `justinfan${Math.floor(10000 + Math.random() * 89999)}`;
  }

  function normalizeToken(token) {
    const t = String(token || '').trim();
    if (!t) return '';
    return t.startsWith('oauth:') ? t : `oauth:${t}`;
  }

  function pushJoin(author) {
    const name = String(author || '').trim();
    if (!name || /^justinfan/i.test(name)) return;
    pushMessage({
      id: `join-${Date.now()}-${name}`,
      platform: 'twitch',
      author: name,
      kind: 'join',
      text: `${name} joined`,
      timestamp: Date.now()
    });
  }

  function handlePrivmsg(parsed) {
    const target = parsed.params[0] || '';
    if (!target.startsWith('#')) return;
    const text = parsed.trailing || '';
    if (!text) return;

    const tags = parsed.tags || {};
    const author = tags['display-name'] || parsed.nick || 'unknown';
    const ts = tags['tmi-sent-ts'] ? Number(tags['tmi-sent-ts']) : Date.now();

    pushMessage({
      id: tags.id || `${ts}-${author}`,
      platform: 'twitch',
      author,
      color: tags.color || null,
      text,
      badges: tags.badges || '',
      emotes: tags.emotes || '',
      timestamp: Number.isFinite(ts) ? ts : Date.now()
    });
  }

  function handleLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;

    const parsed = parseIrcLine(trimmed);

    if (parsed.command === 'NOTICE') {
      const notice = (parsed.trailing || '').toLowerCase();
      if (notice.includes('login authentication failed')) {
        authFailed = true;
        intentionalClose = true;
        clearReconnectTimer();
        emitStatus({
          connected: false,
          connecting: false,
          reconnecting: false,
          error: AUTH_EXPIRED_MSG
        });
        settleSocketWait(new Error(AUTH_EXPIRED_MSG));
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (parsed.command === 'PING') {
      sendRaw(`PONG ${parsed.params[0] || ':tmi.twitch.tv'}`);
      return;
    }

    if (parsed.command === 'RECONNECT') {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      scheduleReconnect();
      return;
    }

    function markOnline() {
      connected = true;
      reconnectAttempt = 0;
      clearReconnectTimer();
      emitStatus({ connected: true, reconnecting: false, connecting: false, error: null });
      settleSocketWait();
    }

    if (parsed.command === 'CAP') {
      const sub = parsed.params[1] || '';
      if (sub === 'ACK' || sub === 'NAK') authenticateAndJoin();
      return;
    }

    if (parsed.command === '001' || parsed.command === '376') {
      markOnline();
      return;
    }

    if (parsed.command === 'JOIN') {
      const tags = parsed.tags || {};
      const joinedChannel = (parsed.params[0] || '').replace(/^#/, '').toLowerCase();
      const nick = (tags['display-name'] || parsed.nick || '').trim();
      if (joinedChannel === channel) {
        markOnline();
        const self = String(username || '').toLowerCase();
        if (
          nick &&
          !/^justinfan/i.test(nick) &&
          (!self || nick.toLowerCase() !== self)
        ) {
          pushJoin(nick);
        }
      }
      return;
    }

    if (parsed.command === 'USERNOTICE') {
      const tags = parsed.tags || {};
      const msgId = tags['msg-id'] || '';
      const author = tags['display-name'] || parsed.nick || 'Someone';
      const ts = tags['tmi-sent-ts'] ? Number(tags['tmi-sent-ts']) : Date.now();
      if (msgId === 'raid') {
        const viewers = tags['msg-param-viewerCount'] || '';
        pushMessage({
          id: tags.id || `raid-${ts}-${author}`,
          platform: 'twitch',
          author,
          kind: 'join',
          text: viewers ? `${author} raided with ${viewers} viewers` : `${author} raided`,
          timestamp: Number.isFinite(ts) ? ts : Date.now()
        });
      }
      return;
    }

    if (parsed.command === 'PRIVMSG') {
      if (!connected) markOnline();
      handlePrivmsg(parsed);
    }
  }

  async function validateAccessToken() {
    if (!oauthToken) return;
    const apps = loadOAuthApps()?.twitch || {};
    if (!apps.clientId) return;
    const bare = String(oauthToken)
      .trim()
      .replace(/^oauth:/i, '');
    try {
      await fetchJsonNode('https://api.twitch.tv/helix/users', {
        headers: {
          Authorization: `Bearer ${bare}`,
          'Client-Id': apps.clientId,
          Accept: 'application/json'
        }
      });
    } catch (err) {
      if (/HTTP 401|HTTP 403/.test(String(err?.message || err))) {
        authFailed = true;
        throw new Error(AUTH_EXPIRED_MSG);
      }
      throw err;
    }
  }

  function authenticateAndJoin() {
    if (capReady) return;
    capReady = true;
    if (oauthToken && username) {
      sendRaw(`PASS ${normalizeToken(oauthToken)}`);
      sendRaw(`NICK ${username}`);
    } else {
      sendRaw('PASS SCHMOOPLE');
      sendRaw(`NICK ${anonNick()}`);
    }
    sendRaw(`JOIN #${channel}`);
    sendRaw('CAP END');
  }

  function openSocket() {
    intentionalClose = false;
    if (!channel) return;

    try {
      ws?.close();
    } catch {
      /* ignore */
    }

    capReady = false;
    ws = new WebSocket(TWITCH_IRC_URL);

    ws.on('open', () => {
      sendRaw('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership');
      setTimeout(() => {
        if (!capReady && ws?.readyState === WebSocket.OPEN) authenticateAndJoin();
      }, 4000);
      connected = false;
      emitStatus({ connecting: true });
    });

    ws.on('message', (data) => {
      String(data)
        .split('\r\n')
        .forEach(handleLine);
    });

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
        if (socketReadyReject) {
          settleSocketWait(new Error('Twitch chat disconnected before it came online'));
        }
        scheduleReconnect();
      } else {
        emitStatus({ connected: false, connecting: false, reconnecting: false });
      }
    });

    ws.on('error', (err) => {
      emitter.emit('error', err);
      emitStatus({ error: err.message || String(err), connecting: false });
      settleSocketWait(err);
    });
  }

  return {
    async connect(channelOrConfig, opts = {}) {
      const cfg =
        typeof channelOrConfig === 'string'
          ? { channel: channelOrConfig, ...opts }
          : { ...channelOrConfig, ...opts };
      channel = normalizeChannel(cfg.channel || cfg.auth?.channel);
      const token = cfg.oauthToken || cfg.auth?.accessToken;
      if (token) oauthToken = String(token).trim();
      const user = cfg.username || cfg.auth?.username;
      if (user) username = String(user).trim();
      if (!channel) throw new Error('Twitch channel name required');
      intentionalClose = false;
      authFailed = false;
      reconnectAttempt = 0;
      clearReconnectTimer();
      emitStatus({ connecting: true });

      if (oauthToken && username) {
        await validateAccessToken();
      }

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try {
            ws?.close();
          } catch {
            /* ignore */
          }
          settleSocketWait(new Error('Twitch chat timed out — check channel name'));
        }, 30000);

        socketReadyResolve = () => {
          clearTimeout(timer);
          resolve();
        };
        socketReadyReject = (err) => {
          clearTimeout(timer);
          reject(err);
        };
        openSocket();
      });
    },

    disconnect() {
      intentionalClose = true;
      clearReconnectTimer();
      connected = false;
      channel = null;
      messages.length = 0;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
      emitStatus();
    },

    send(text) {
      const msg = String(text || '').trim();
      if (!msg) throw new Error('Message required');
      if (!channel) throw new Error('Not connected to a channel');
      if (!oauthToken || !username) {
        throw new Error('OAuth token and username required to send messages');
      }
      if (!connected) throw new Error('Chat not connected');
      sendRaw(`PRIVMSG #${channel} :${msg.replace(/\r|\n/g, ' ')}`);
    },

    getMessages() {
      return messages.slice();
    },

    getChannel() {
      return channel;
    },

    isConnected() {
      return connected;
    },

    canSend() {
      return !!(oauthToken && username && connected);
    },

    setCredentials(opts = {}) {
      if (opts.oauthToken != null) oauthToken = String(opts.oauthToken).trim();
      if (opts.username != null) username = String(opts.username).trim();
      emitStatus();
    },

    getStatus() {
      return {
        platform: 'twitch',
        connected,
        channel,
        canSend: !!(oauthToken && username && connected),
        readOnly: connected && !(oauthToken && username),
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

module.exports = { createTwitchConnector, createTwitchChatClient: createTwitchConnector, normalizeChannel, MAX_MESSAGES };

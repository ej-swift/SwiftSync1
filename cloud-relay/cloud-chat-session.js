/**
 * On-demand cloud chat — runs platform connectors only while mobile is active.
 * Chat credentials are stored per pairing room (synced from PC once).
 */
const path = require('path');

const PC_APP_ROOT = process.env.PC_APP_ROOT
  ? path.resolve(process.env.PC_APP_ROOT)
  : path.join(__dirname, '..', 'pc-app');

const { createChatHub } = require(path.join(PC_APP_ROOT, 'chat', 'hub'));
const { prepareChatConfig } = require(path.join(PC_APP_ROOT, 'chat', 'prepare-config'));

const IDLE_MS = Number(process.env.CLOUD_CHAT_IDLE_MS) || 90_000;
const MOBILE_GONE_GRACE_MS = 8_000;

function platformEnabled(platforms) {
  if (!platforms || typeof platforms !== 'object') return false;
  return Object.values(platforms).some((p) => p && p.enabled);
}

function buildChatPayload(hub) {
  const statuses = hub.getStatuses();
  const connectedPlatforms = hub.getConnectedPlatforms();
  const sendPlatforms = hub.getSendPlatforms();
  return {
    messages: hub.getMessages(),
    channel:
      connectedPlatforms.length === 1 ? statuses[connectedPlatforms[0]]?.channel || null : null,
    connected: hub.isAnyConnected(),
    canSend: hub.canSendAny(),
    sendPlatforms,
    statuses,
    platforms: connectedPlatforms
  };
}

function createCloudChatManager(deps) {
  const { relayPcToMobile, updateChatStore, getPublicHttpBase } = deps;
  /** @type {Map<string, { hub, idleTimer, graceTimer, active, starting, chatOnlyMobiles: number }>} */
  const sessions = new Map();

  function openMobileCount(room) {
    return [...room.mobiles].filter((m) => m.readyState === WebSocket.OPEN).length;
  }

  function clearTimer(timer) {
    if (timer) clearTimeout(timer);
    return null;
  }

  function getSession(room) {
    if (!room?.code) return null;
    let sess = sessions.get(room.code);
    if (!sess) {
      const hub = createChatHub();
      sess = {
        hub,
        idleTimer: null,
        graceTimer: null,
        active: false,
        starting: null,
        chatOnlyMobiles: 0
      };
      hub.on('message', (message) => {
        relayPcToMobile(
          room,
          JSON.stringify({ from: 'pc', type: 'chatMessage', message })
        );
        updateChatStore(room, buildChatPayload(hub));
      });
      hub.on('status', () => {
        broadcastStatus(room, sess);
      });
      sessions.set(room.code, sess);
    }
    return sess;
  }

  function broadcastChat(room, sess, full = true) {
    const payload = buildChatPayload(sess.hub);
    relayPcToMobile(
      room,
      JSON.stringify({ from: 'pc', type: full ? 'chat' : 'chatBatch', ...payload })
    );
    updateChatStore(room, payload);
  }

  function broadcastStatus(room, sess) {
    relayPcToMobile(
      room,
      JSON.stringify({ from: 'pc', type: 'chatStatus', ...buildChatPayload(sess.hub), cloudChat: true })
    );
  }

  function scheduleIdleStop(room, delayMs = IDLE_MS) {
    const sess = sessions.get(room.code);
    if (!sess?.active) return;
    sess.idleTimer = clearTimer(sess.idleTimer);
    sess.idleTimer = setTimeout(() => {
      sess.idleTimer = null;
      stopSession(room, 'idle');
    }, delayMs);
  }

  function touchSession(room) {
    const sess = sessions.get(room.code);
    if (!sess?.active) return;
    scheduleIdleStop(room);
  }

  function hasConfig(room) {
    return platformEnabled(room.chatConfigStored?.platforms);
  }

  function saveConfig(room, config) {
    if (!room || !config?.platforms) return false;
    room.chatConfigStored = {
      platforms: config.platforms,
      updatedAt: Date.now()
    };
    return true;
  }

  function pcOnline(room) {
    return room?.pc?.readyState === WebSocket.OPEN;
  }

  async function startSession(room) {
    if (!room || pcOnline(room)) return { ok: false, reason: 'pc_online' };
    if (!hasConfig(room)) {
      return {
        ok: false,
        error: 'Sign in first — on Connect, tap Twitch, Kick, YouTube, or TikTok.'
      };
    }

    const sess = getSession(room);
    touchSession(room);

    if (sess.active && sess.hub.isAnyConnected()) {
      broadcastChat(room, sess, true);
      broadcastStatus(room, sess);
      return { ok: true };
    }

    if (sess.starting) return sess.starting;

    sess.starting = (async () => {
      try {
        const publicUrl = (getPublicHttpBase() || '').replace(/\/$/, '');
        const prepared = await prepareChatConfig(
          {
            platforms: room.chatConfigStored.platforms,
            relayHttpBase: publicUrl,
            relayHttpBases: publicUrl ? [publicUrl] : []
          },
          { forceAuthRefresh: true }
        );
        room.chatConfigStored.platforms = prepared.config.platforms;
        await sess.hub.connectAll(prepared.config, { force: true });
        sess.active = true;
        broadcastChat(room, sess, true);
        broadcastStatus(room, sess);
        console.log(`[cloud-chat] Started for room ${room.code.slice(0, 4)}…`);
        return { ok: true };
      } catch (err) {
        console.error('[cloud-chat] Start failed', err.message);
        return { ok: false, error: err.message || String(err) };
      } finally {
        sess.starting = null;
      }
    })();

    return sess.starting;
  }

  function stopSession(room, reason = 'manual') {
    const sess = sessions.get(room?.code);
    if (!sess) return;
    sess.idleTimer = clearTimer(sess.idleTimer);
    sess.graceTimer = clearTimer(sess.graceTimer);
    if (sess.active) {
      try {
        sess.hub.disconnectAll();
      } catch (_) {}
      sess.active = false;
      console.log(`[cloud-chat] Stopped for room ${room.code.slice(0, 4)}… (${reason})`);
    }
  }

  function onMobileJoined(room, chatOnly) {
    if (chatOnly) {
      const sess = getSession(room);
      sess.chatOnlyMobiles += 1;
    }
  }

  function onMobileLeft(room, chatOnly) {
    if (chatOnly) {
      const sess = sessions.get(room.code);
      if (sess && sess.chatOnlyMobiles > 0) sess.chatOnlyMobiles -= 1;
    }
    if (pcOnline(room)) return;
    const sess = sessions.get(room.code);
    if (!sess?.active) return;
    if (openMobileCount(room) > 0) return;
    sess.graceTimer = clearTimer(sess.graceTimer);
    sess.graceTimer = setTimeout(() => {
      sess.graceTimer = null;
      if (openMobileCount(room) === 0) stopSession(room, 'mobile_gone');
    }, MOBILE_GONE_GRACE_MS);
  }

  async function handleMobileCommand(room, ws, data) {
    if (!room || pcOnline(room)) return false;

    const cmd = data.command;
    if (cmd === 'connectChat' || cmd === 'getChat') {
      const result = await startSession(room);
      if (!result.ok && result.error) {
        ws.send(JSON.stringify({ type: 'error', message: result.error }));
      }
      return true;
    }
    if (cmd === 'chatHeartbeat') {
      touchSession(room);
      if (!sessions.get(room.code)?.active) {
        await startSession(room);
      } else {
        const sess = sessions.get(room.code);
        broadcastChat(room, sess, false);
        broadcastStatus(room, sess);
      }
      return true;
    }
    if (cmd === 'stopChat') {
      stopSession(room, 'mobile_stop');
      return true;
    }
    if (cmd === 'sendChat') {
      const sess = sessions.get(room.code);
      if (!sess?.active || !sess.hub.canSendAny()) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Cloud chat not connected — wait a moment or tap Connect again.'
          })
        );
        return true;
      }
      const text = String(data.text || data.message || '').trim();
      const platform = data.platform || sess.hub.getDefaultSendPlatform();
      if (!text) {
        ws.send(JSON.stringify({ type: 'error', message: 'text required' }));
        return true;
      }
      try {
        const result = await sess.hub.send(platform, text);
        if (platform === 'all' && Array.isArray(result) && result.length) {
          ws.send(JSON.stringify({ type: 'error', message: 'Partial send failure on cloud chat' }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message || String(err) }));
      }
      return true;
    }
    return false;
  }

  return {
    hasConfig,
    saveConfig,
    startSession,
    touchSession,
    stopSession,
    onMobileJoined,
    onMobileLeft,
    handleMobileCommand,
    pcOnline
  };
}

module.exports = { createCloudChatManager, IDLE_MS };

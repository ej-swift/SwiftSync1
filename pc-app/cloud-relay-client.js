const WebSocket = require('ws');

const CONNECT_TIMEOUT_MS = 15000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const PING_INTERVAL_MS = 25000;

function disposeWebSocket(socket) {
  if (!socket) return;
  const state = socket.readyState;
  socket.onerror = () => {};
  socket.onclose = () => {};
  try {
    if (state === WebSocket.CONNECTING) {
      socket.terminate();
    } else if (state === WebSocket.OPEN || state === WebSocket.CLOSING) {
      socket.close();
    }
  } catch (_) {
    /* ws throws if close() races with CONNECTING — terminate() avoids it */
  }
  try {
    socket.removeAllListeners();
  } catch (_) {}
}

/**
 * Cloud/local relay WebSocket in the main process (Node ws — reliable in Electron).
 */
function createCloudRelayClient(onEvent) {
  let ws = null;
  let reconnectTimer = null;
  let pingTimer = null;
  let shouldReconnect = false;
  let reconnectAttempt = 0;
  let lastUrl = '';
  let lastPairingCode = '';

  function emit(ev) {
    try {
      onEvent(ev);
    } catch (_) {
      /* ignore */
    }
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function startPing() {
    clearPing();
    pingTimer = setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      try {
        ws.ping();
      } catch (_) {
        /* ignore */
      }
    }, PING_INTERVAL_MS);
  }

  function stop() {
    shouldReconnect = false;
    reconnectAttempt = 0;
    clearReconnect();
    clearPing();
    disposeWebSocket(ws);
    ws = null;
  }

  function scheduleReconnect() {
    if (!shouldReconnect || reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (shouldReconnect && lastUrl) connect(lastUrl, lastPairingCode);
    }, delay);
  }

  function isOpen() {
    return ws?.readyState === WebSocket.OPEN;
  }

  function connect(url, pairingCode) {
    const nextUrl = String(url || '').trim();
    const nextCode = pairingCode || lastPairingCode || '';
    if (!nextUrl) return;

    if (ws && lastUrl === nextUrl) {
      const prevCode = lastPairingCode;
      lastPairingCode = nextCode;
      shouldReconnect = true;
      if (ws.readyState === WebSocket.OPEN) {
        if (prevCode && nextCode && prevCode !== nextCode) {
          clearPing();
          disposeWebSocket(ws);
          ws = null;
        } else {
          try {
            ws.send(JSON.stringify({ type: 'role', role: 'pc', pairingCode: lastPairingCode }));
          } catch (_) {}
          startPing();
          emit({ state: 'open' });
          return;
        }
      }
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        return;
      }
    }

    clearPing();
    disposeWebSocket(ws);
    ws = null;
    shouldReconnect = true;
    lastUrl = nextUrl;
    lastPairingCode = nextCode;

    ws = new WebSocket(nextUrl);
    const socket = ws;
    const connectTimeout = setTimeout(() => {
      if (socket?.readyState === WebSocket.CONNECTING) {
        emit({ state: 'timeout' });
        disposeWebSocket(socket);
        if (ws === socket) ws = null;
        scheduleReconnect();
      }
    }, CONNECT_TIMEOUT_MS);

    socket.on('open', () => {
      clearTimeout(connectTimeout);
      if (ws !== socket) return;
      reconnectAttempt = 0;
      try {
        socket.send(JSON.stringify({ type: 'role', role: 'pc', pairingCode: lastPairingCode }));
      } catch (err) {
        emit({ state: 'error', message: err?.message || 'Send failed' });
      }
      startPing();
      emit({ state: 'open' });
    });

    socket.on('message', (data) => {
      if (ws !== socket) return;
      emit({ state: 'message', data: data.toString() });
    });

    socket.on('close', (code, reason) => {
      clearTimeout(connectTimeout);
      clearPing();
      if (ws === socket) ws = null;
      emit({ state: 'close', code, reason: reason?.toString() || '' });
      scheduleReconnect();
    });

    socket.on('error', (err) => {
      clearTimeout(connectTimeout);
      emit({ state: 'error', message: err?.message || 'WebSocket error' });
      if (ws === socket && socket.readyState === WebSocket.CONNECTING) {
        disposeWebSocket(socket);
        ws = null;
        scheduleReconnect();
      }
    });

    socket.on('pong', () => {
      /* keepalive ack */
    });
  }

  function send(text) {
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(text);
      } catch (err) {
        emit({ state: 'error', message: err?.message || 'Send failed' });
      }
    }
  }

  return { connect, send, stop, isOpen };
}

module.exports = { createCloudRelayClient };

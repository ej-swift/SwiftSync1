const WebSocket = require('ws');

const CONNECT_TIMEOUT_MS = 15000;
const RECONNECT_MS = 2000;

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
 * Cloud relay WebSocket in the main process (Node ws — reliable in Electron).
 */
function createCloudRelayClient(onEvent) {
  let ws = null;
  let reconnectTimer = null;
  let shouldReconnect = false;
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

  function stop() {
    shouldReconnect = false;
    clearReconnect();
    disposeWebSocket(ws);
    ws = null;
  }

  function scheduleReconnect() {
    if (!shouldReconnect || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (shouldReconnect && lastUrl) connect(lastUrl, lastPairingCode);
    }, RECONNECT_MS);
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
          disposeWebSocket(ws);
          ws = null;
        } else {
          try {
            ws.send(JSON.stringify({ type: 'role', role: 'pc', pairingCode: lastPairingCode }));
          } catch (_) {}
          emit({ state: 'open' });
          return;
        }
      }
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        return;
      }
    }

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
      socket.send(JSON.stringify({ type: 'role', role: 'pc', pairingCode: lastPairingCode }));
      emit({ state: 'open' });
    });

    socket.on('message', (data) => {
      if (ws !== socket) return;
      emit({ state: 'message', data: data.toString() });
    });

    socket.on('close', (code, reason) => {
      clearTimeout(connectTimeout);
      if (ws === socket) ws = null;
      emit({ state: 'close', code, reason: reason?.toString() || '' });
      scheduleReconnect();
    });

    socket.on('error', (err) => {
      clearTimeout(connectTimeout);
      emit({ state: 'error', message: err?.message || 'WebSocket error' });
    });
  }

  function send(text) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(text);
  }

  return { connect, send, stop, isOpen };
}

module.exports = { createCloudRelayClient };

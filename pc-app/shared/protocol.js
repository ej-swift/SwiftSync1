/**
 * SwiftSync relay protocol — shared by PC and mobile web UI.
 * Messages use JSON over WebSocket; mobile sends { from:'mobile', command }.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SwiftSyncProtocol = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ROLES = { PC: 'pc', MOBILE: 'mobile' };

  function parseRelayUrl(input) {
    const raw = (input || '').trim();
    if (!raw) return null;
    if (raw.startsWith('ws://') || raw.startsWith('wss://')) return raw;
    if (raw.startsWith('http://')) return `ws://${raw.slice(7).replace(/\/$/, '')}`;
    if (raw.startsWith('https://')) return `wss://${raw.slice(8).replace(/\/$/, '')}`;
    return `ws://${raw.replace(/\/$/, '')}`;
  }

  function httpBaseFromRelay(relayUrl) {
    const ws = parseRelayUrl(relayUrl);
    if (!ws) return null;
    return ws.replace(/^ws/i, 'http').replace(/^wss/i, 'https');
  }

  class RelayClient {
    constructor(role) {
      this.role = role;
      this.ws = null;
      this.pairingCode = '';
      this.handlers = new Set();
      this._reconnectTimer = null;
    }

    onMessage(fn) {
      this.handlers.add(fn);
      return () => this.handlers.delete(fn);
    }

    _emit(data) {
      this.handlers.forEach((fn) => {
        try { fn(data); } catch (e) { console.error(e); }
      });
    }

    connect(relayUrl, options = {}) {
      const url = parseRelayUrl(relayUrl);
      if (!url) return Promise.reject(new Error('Invalid relay URL'));

      this.pairingCode = (options.pairingCode || '').toUpperCase();
      this._clearReconnect();

      return new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket(url);
        this.ws = ws;

        ws.onopen = () => {
          const hello = { type: 'role', role: this.role };
          if (this.role === ROLES.MOBILE) {
            hello.pairingCode = this.pairingCode;
            if (options.chatOnly) hello.chatOnly = true;
          }
          ws.send(JSON.stringify(hello));
        };

        ws.onmessage = (ev) => {
          let data;
          try { data = JSON.parse(ev.data); } catch { return; }

          if (data.type === 'paired' && this.role === ROLES.MOBILE) {
            if (!settled) { settled = true; resolve(data); }
          }
          if (data.type === 'error' && this.role === ROLES.MOBILE && !settled) {
            settled = true;
            reject(new Error(data.message || 'Pairing failed'));
            ws.close();
            return;
          }

          this._emit(data);
        };

        ws.onerror = () => {
          if (!settled) {
            settled = true;
            reject(new Error('WebSocket connection failed'));
          }
        };

        ws.onclose = () => {
          this.ws = null;
          if (options.autoReconnect && this.role === ROLES.MOBILE) {
            this._reconnectTimer = setTimeout(() => {
              this.connect(url, options).catch(() => {});
            }, options.reconnectMs || 4000);
          }
        };
      });
    }

    _clearReconnect() {
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
    }

    disconnect() {
      this._clearReconnect();
      if (this.ws) this.ws.close();
      this.ws = null;
    }

    get connected() {
      return this.ws?.readyState === WebSocket.OPEN;
    }

    send(payload) {
      if (!this.connected) return false;
      this.ws.send(JSON.stringify(payload));
      return true;
    }

    command(name, extra = {}) {
      return this.send({ from: 'mobile', command: name, ...extra });
    }

    ping() {
      return this.command('ping');
    }

    getState() {
      return this.command('getState');
    }
  }

  return {
    ROLES,
    RelayClient,
    parseRelayUrl,
    httpBaseFromRelay
  };
});

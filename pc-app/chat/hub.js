const { EventEmitter } = require('events');
const { createTwitchConnector } = require('./twitch');
const { createKickConnector } = require('./kick');
const { createYoutubeConnector } = require('./youtube');
const { createTiktokConnector } = require('./tiktok');
const { normalizeChatMessage } = require('./chat-message');

const MAX_MESSAGES = 300;

const CONNECTOR_FACTORIES = {
  twitch: createTwitchConnector,
  kick: createKickConnector,
  youtube: createYoutubeConnector,
  tiktok: createTiktokConnector
};

function messageKey(msg) {
  return `${msg.platform}:${msg.id}`;
}

function createChatHub() {
  const emitter = new EventEmitter();
  const connectors = new Map();
  const statuses = {};
  const messages = [];
  const seen = new Set();
  let config = null;

  function getStatuses() {
    const out = {};
    for (const [platform, connector] of connectors) {
      const live = connector.getStatus?.() || { platform, connected: false };
      const cached = statuses[platform] || {};
      const isConnected = !!live.connected;
      out[platform] = {
        platform,
        connected: isConnected,
        channel: live.channel ?? cached.channel ?? null,
        canSend: !!live.canSend,
        readOnly: live.readOnly ?? null,
        connecting: isConnected ? false : !!(live.connecting ?? cached.connecting),
        reconnecting: isConnected ? false : !!(live.reconnecting ?? cached.reconnecting),
        hint: isConnected ? null : live.hint ?? cached.hint ?? null,
        error: isConnected ? null : live.error ?? cached.error ?? null,
        retryInMs: live.retryInMs ?? cached.retryInMs ?? null
      };
    }
    return out;
  }

  function emitStatus(platform, status) {
    statuses[platform] = { ...status, platform };
    emitter.emit('status', { platform, ...status });
    emitter.emit('statuses', getStatuses());
  }

  function insertMessage(raw) {
    const msg = normalizeChatMessage(raw);
    if (!msg || !msg.platform || !msg.id) return;
    if (!msg.text && msg.kind !== 'join') return;
    const key = messageKey(msg);
    if (seen.has(key)) return;
    seen.add(key);
    messages.push(msg);
    while (messages.length > MAX_MESSAGES) {
      const removed = messages.shift();
      if (removed) seen.delete(messageKey(removed));
    }
    messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    emitter.emit('message', msg);
  }

  function attachConnector(platform, connector) {
    connector.on('message', (msg) => {
      insertMessage({ ...msg, platform: msg.platform || platform });
    });
    connector.on('status', (status) => {
      emitStatus(platform, status);
    });
    connector.on('error', (err) => {
      emitStatus(platform, {
        ...(statuses[platform] || {}),
        platform,
        connected: false,
        connecting: false,
        error: err.message || String(err)
      });
    });
  }

  function getEnabledPlatforms(cfg) {
    const platforms = cfg?.platforms || {};
    return Object.keys(CONNECTOR_FACTORIES).filter((p) => platforms[p]?.enabled);
  }

  return {
    async connectAll(cfg, opts = {}) {
      config = cfg;
      const force = !!opts.force;
      const enabled = getEnabledPlatforms(cfg);

      for (const platform of [...connectors.keys()]) {
        if (!enabled.includes(platform)) {
          try {
            connectors.get(platform)?.disconnect();
          } catch {
            /* ignore */
          }
          connectors.delete(platform);
          delete statuses[platform];
        }
      }

      await Promise.all(
        enabled.map(async (platform) => {
          const platformCfg = cfg.platforms[platform] || {};
          const factory = CONNECTOR_FACTORIES[platform];
          if (!factory) return;

          const existing = connectors.get(platform);
          const live = existing?.getStatus?.() || statuses[platform] || {};
          if (live.connected && !force) return;
          if (!force && (live.connecting || live.reconnecting)) return;
          if (!force && platform === 'youtube' && live.hint && !live.error) return;

          if (existing) {
            try {
              existing.disconnect();
            } catch {
              /* ignore */
            }
            if (force) {
              connectors.delete(platform);
              delete statuses[platform];
            }
          }

          const connector = factory();
          connectors.set(platform, connector);
          attachConnector(platform, connector);

          try {
            await connector.connect(platformCfg);
          } catch (err) {
            emitStatus(platform, {
              platform,
              connected: false,
              connecting: false,
              channel: platformCfg.channel || platformCfg.channelId || platformCfg.username || null,
              canSend: false,
              error: err.message || String(err)
            });
          }
        })
      );
    },

    disconnectAll() {
      for (const connector of connectors.values()) {
        try {
          connector.disconnect();
        } catch {
          /* ignore */
        }
      }
      connectors.clear();
      for (const key of Object.keys(statuses)) {
        delete statuses[key];
      }
    },

    async sendAll(text) {
      const platforms = this.getSendPlatforms();
      if (!platforms.length) throw new Error('No platform available for sending');
      const errors = [];
      for (const platform of platforms) {
        try {
          const connector = connectors.get(platform);
          if (!connector?.send) throw new Error(`${platform} does not support sending`);
          await connector.send(text);
        } catch (err) {
          errors.push({ platform, error: err.message || String(err) });
        }
      }
      return errors;
    },

    async send(platform, text) {
      const target = platform || this.getDefaultSendPlatform();
      if (!target) throw new Error('No platform available for sending');
      if (target === 'all') return this.sendAll(text);
      const connector = connectors.get(target);
      if (!connector?.send) throw new Error(`${target} does not support sending`);
      return connector.send(text);
    },

    getDefaultSendPlatform() {
      for (const [platform, connector] of connectors) {
        const status = connector.getStatus?.() || statuses[platform] || {};
        if (status.canSend && status.connected) return platform;
      }
      return null;
    },

    getSendPlatforms() {
      const list = [];
      for (const [platform, connector] of connectors) {
        const status = connector.getStatus?.() || statuses[platform] || {};
        if (status.canSend && status.connected) list.push(platform);
      }
      return list;
    },

    getMessages() {
      return messages.slice();
    },

    getStatuses,

    getConnectedPlatforms() {
      return Object.entries(getStatuses())
        .filter(([, s]) => s.connected)
        .map(([p]) => p);
    },

    isAnyConnected() {
      return this.getConnectedPlatforms().length > 0;
    },

    canSendAny() {
      return this.getSendPlatforms().length > 0;
    },

    getConfig() {
      return config;
    },

    on(event, cb) {
      emitter.on(event, cb);
      return () => emitter.off(event, cb);
    }
  };
}

module.exports = { createChatHub, MAX_MESSAGES, CONNECTOR_FACTORIES };

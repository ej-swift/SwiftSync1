const { tokenNeedsRefresh, refreshPlatformToken } = require('./oauth-flow');
const { resolveKickChannelSlug } = require('./kick');
const { normalizeYoutubeChannelId } = require('./youtube');

function applyAuthToPlatform(platform, cfg) {
  const out = { ...cfg };
  const auth = out.auth;

  if (platform === 'twitch' && auth?.accessToken) {
    out.oauthToken = auth.accessToken;
    out.username = out.username || auth.username;
    out.channel = out.channel || auth.channel;
  }

  if (platform === 'youtube' && auth?.accessToken) {
    out.accessToken = auth.accessToken;
    out.channelId = out.channelId || auth.channelId;
  }

  if (platform === 'kick' && auth?.accessToken) {
    out.accessToken = auth.accessToken;
    out.accountId = out.accountId || auth.accountId;
    out.channel = out.channel || auth.channel;
  }

  if (platform === 'tiktok' && auth?.username) {
    out.username = out.username || auth.username;
  }

  return out;
}

async function preparePlatformConfig(platform, platformCfg = {}, opts = {}) {
  const cfg = { ...platformCfg };
  let authChanged = false;
  const forceAuthRefresh = !!opts.forceAuthRefresh;

  const shouldRefresh =
    cfg.auth?.refreshToken &&
    (tokenNeedsRefresh(cfg.auth) ||
      (forceAuthRefresh && ['kick', 'youtube', 'twitch'].includes(platform)));

  if (shouldRefresh) {
    try {
      const refreshed = await refreshPlatformToken(platform, cfg.auth);
      if (refreshed?.accessToken) {
        cfg.auth = { ...cfg.auth, ...refreshed };
        authChanged = true;
      }
    } catch {
      /* use existing token until connect fails */
    }
  }

  let prepared = applyAuthToPlatform(platform, cfg);

  if (platform === 'kick') {
    const slug = await resolveKickChannelSlug({
      channel: prepared.channel,
      accessToken: prepared.accessToken || prepared.auth?.accessToken,
      accountId: prepared.accountId || prepared.auth?.accountId
    });
    if (slug) prepared.channel = slug;
  }

  if (platform === 'youtube' && prepared.channelId) {
    prepared.channelId = normalizeYoutubeChannelId(prepared.channelId);
  }

  return { cfg: prepared, authChanged };
}

async function prepareChatConfig(chatConfig = {}, opts = {}) {
  const platforms = { ...(chatConfig.platforms || {}) };
  const relayHttpBase = String(chatConfig.relayHttpBase || '').trim();
  let authChanged = false;

  for (const platform of Object.keys(platforms)) {
    const result = await preparePlatformConfig(platform, platforms[platform], opts);
    platforms[platform] = result.cfg;
    if (result.authChanged) authChanged = true;
  }

  const relayHttpBases = Array.isArray(chatConfig.relayHttpBases)
    ? chatConfig.relayHttpBases
    : [];

  if (platforms.tiktok) {
    platforms.tiktok = {
      ...platforms.tiktok,
      ...(relayHttpBase ? { relayHttpBase } : {}),
      ...(relayHttpBases.length ? { relayHttpBases } : {})
    };
  }

  return { config: { platforms, relayHttpBase, relayHttpBases }, authChanged };
}

module.exports = { prepareChatConfig, preparePlatformConfig, applyAuthToPlatform };

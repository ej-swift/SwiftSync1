const { fetchJson, postFormUrlEncoded } = require('./http-utils');
const { normalizeSlug: normalizeKickSlug } = require('./kick');

const TWITCH = {
  authorizeUrl: 'https://id.twitch.tv/oauth2/authorize',
  tokenUrl: 'https://id.twitch.tv/oauth2/token',
  scopes: ['chat:read', 'chat:edit', 'user:read:email'],
  buildAuthorize({ clientId, redirectUri, state, codeChallenge }) {
    const u = new URL(this.authorizeUrl);
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', this.scopes.join(' '));
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  },
  async exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
    if (!clientSecret) {
      throw new Error(
        'Twitch requires a Client Secret for the token exchange. Add it in Chat → OAuth App Setup, or connect to the SwiftSync cloud relay which handles this automatically.'
      );
    }
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    });
    return postFormUrlEncoded(this.tokenUrl, body);
  },
  async refreshToken({ clientId, clientSecret, refreshToken }) {
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });
    if (clientSecret) body.set('client_secret', clientSecret);
    return postFormUrlEncoded(this.tokenUrl, body);
  },
  async fetchProfile({ accessToken, clientId }) {
    const data = await fetchJson('https://api.twitch.tv/helix/users', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': clientId
      }
    });
    const user = data?.data?.[0];
    if (!user) throw new Error('Twitch profile not found');
    return {
      accountId: user.id,
      accountName: user.display_name || user.login,
      channel: user.login,
      username: user.login
    };
  }
};

const KICK = {
  authorizeUrl: 'https://id.kick.com/oauth/authorize',
  tokenUrl: 'https://id.kick.com/oauth/token',
  scopes: ['user:read', 'channel:read', 'chat:write'],
  buildAuthorize({ clientId, redirectUri, state, codeChallenge }) {
    const u = new URL(this.authorizeUrl);
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', this.scopes.join(' '));
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  },
  async exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    });
    return postFormUrlEncoded(this.tokenUrl, body);
  },
  async refreshToken({ clientId, clientSecret, refreshToken }) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });
    return postFormUrlEncoded(this.tokenUrl, body);
  },
  async fetchProfile({ accessToken }) {
    const data = await fetchJson('https://api.kick.com/public/v1/users', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const user = data?.data?.[0] || data?.data || data;
    if (!user) throw new Error('Kick profile not found');

    const userId = user.user_id || user.id;
    const displayName = user.name || '';

    let slug = normalizeKickSlug(user.slug || user.username || '');

    if (!slug && userId) {
      try {
        const chData = await fetchJson(
          `https://api.kick.com/public/v1/channels?broadcaster_user_id=${encodeURIComponent(userId)}`,
          { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }
        );
        slug = normalizeKickSlug(chData?.data?.[0]?.slug || '');
      } catch (_) {}
    }

    return {
      accountId: userId != null && userId !== '' ? String(userId) : '',
      accountName: displayName || slug || 'Kick',
      channel: slug || ''
    };
  }
};

const YOUTUBE = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl'
  ],
  buildAuthorize({ clientId, redirectUri, state, codeChallenge }) {
    const u = new URL(this.authorizeUrl);
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', this.scopes.join(' '));
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    return u.toString();
  },
  async exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    });
    return postFormUrlEncoded(this.tokenUrl, body);
  },
  async refreshToken({ clientId, clientSecret, refreshToken }) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });
    return postFormUrlEncoded(this.tokenUrl, body);
  },
  async fetchProfile({ accessToken }) {
    const data = await fetchJson(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const ch = data?.items?.[0];
    if (!ch) throw new Error('YouTube channel not found (sign in with the channel owner account)');
    return {
      accountId: ch.id,
      accountName: ch.snippet?.title || ch.id,
      channelId: ch.id
    };
  }
};

const TIKTOK = {
  authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
  tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
  scopes: ['user.info.basic'],
  buildAuthorize({ clientKey, redirectUri, state, codeChallenge }) {
    const u = new URL(this.authorizeUrl);
    u.searchParams.set('client_key', clientKey);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', this.scopes.join(','));
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  },
  async exchangeCode({ clientKey, clientSecret, code, redirectUri, codeVerifier }) {
    const body = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    });
    return postFormUrlEncoded(this.tokenUrl, body);
  },
  async fetchProfile({ accessToken }) {
    const data = await fetchJson(
      'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const user = data?.data?.user;
    if (!user) throw new Error('TikTok profile not found');
    return {
      accountId: user.open_id,
      accountName: user.display_name || user.username,
      username: user.username
    };
  }
};

const PROVIDERS = { twitch: TWITCH, kick: KICK, youtube: YOUTUBE, tiktok: TIKTOK };

function normalizeTokenResponse(platform, tokenJson) {
  const raw = tokenJson?.data && typeof tokenJson.data === 'object' ? tokenJson.data : tokenJson;
  const expiresIn = Number(raw.expires_in || 0);
  const expiresAt = expiresIn > 0 ? Date.now() + expiresIn * 1000 : null;
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token || null,
    expiresAt,
    tokenType: raw.token_type || 'Bearer'
  };
}

module.exports = {
  PROVIDERS,
  normalizeTokenResponse,
  TWITCH,
  KICK,
  YOUTUBE,
  TIKTOK
};

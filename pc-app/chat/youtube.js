const { EventEmitter } = require('events');
const { fetchJson, fetchText, postJson } = require('./http-utils');
const { createStrikeCounter } = require('./resilience');

const POLL_MS = 5000;
const LIVE_RECHECK_MS = 45000;
const LIVE_CHECK_FAIL_THRESHOLD = 3;
const POLL_FAIL_THRESHOLD = 5;
const WAIT_FOR_LIVE_MS = 90000;
const WAIT_POLL_MS = 8000;
const LIVE_STANDBY_MS = 30000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const AUTH_EXPIRED_MSG =
  'YouTube sign-in expired — use Sign in with Browser on the Chat tab';

function mapYoutubeAuthError(err) {
  const msg = err?.message || String(err);
  if (/HTTP 401|invalid authentication credentials/i.test(msg)) {
    return new Error(AUTH_EXPIRED_MSG);
  }
  return err instanceof Error ? err : new Error(msg);
}

function normalizeYoutubeChannelId(input) {
  let s = String(input || '').trim();
  const fromUrl = s.match(/youtube\.com\/channel\/(UC[\w-]+)/i);
  if (fromUrl) return fromUrl[1];
  if (/^UC[\w-]{10,}$/i.test(s)) return s;
  if (s.startsWith('@')) return s;
  return s;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createYoutubeConnector() {
  const emitter = new EventEmitter();
  let channelId = null;
  let apiKey = null;
  let accessToken = null;
  let liveChatId = null;
  let liveVideoId = null;
  let pageToken = null;
  let pollTimer = null;
  let liveCheckTimer = null;
  let liveWatchTimer = null;
  let pollDelayMs = POLL_MS;
  let connected = false;
  let intentionalStop = false;
  let statusMeta = { connecting: false, hint: null, error: null };
  const liveCheckStrikes = createStrikeCounter(LIVE_CHECK_FAIL_THRESHOLD, () => {
    markOffline('YouTube no longer live — Connect again after Go Live');
  });
  const pollStrikes = createStrikeCounter(POLL_FAIL_THRESHOLD, () => {
    markOffline('YouTube chat disconnected — Connect again when live');
  });

  function canSendNow() {
    return !!(accessToken && liveChatId && connected);
  }

  function emitStatus(extra = {}) {
    if (Object.prototype.hasOwnProperty.call(extra, 'connecting')) {
      statusMeta.connecting = !!extra.connecting;
    }
    if (Object.prototype.hasOwnProperty.call(extra, 'hint')) {
      statusMeta.hint = extra.hint || null;
    }
    if (Object.prototype.hasOwnProperty.call(extra, 'error')) {
      statusMeta.error = extra.error || null;
    }
    if (connected) {
      statusMeta.connecting = false;
      statusMeta.error = null;
      statusMeta.hint = null;
    }
    emitter.emit('status', {
      platform: 'youtube',
      connected,
      channel: channelId,
      canSend: canSendNow(),
      ...statusMeta,
      ...extra,
      ...(connected ? { connecting: false, error: null, hint: null } : {})
    });
  }

  function clearPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (liveCheckTimer) {
      clearInterval(liveCheckTimer);
      liveCheckTimer = null;
    }
  }

  function clearLiveWatch() {
    if (liveWatchTimer) {
      clearInterval(liveWatchTimer);
      liveWatchTimer = null;
    }
  }

  function beginPolling() {
    clearPoll();
    const schedulePoll = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        pollMessages().catch(() => {});
      }, pollDelayMs);
    };
    schedulePoll();
    liveCheckTimer = setInterval(() => {
      runLiveCheck().catch(() => {});
    }, LIVE_RECHECK_MS);
  }

  async function attachIfLive() {
    const pair = await resolveLivePairOnce();
    if (!(await verifyVideoIsLive(pair.videoId))) return false;
    liveChatId = pair.liveChatId;
    liveVideoId = pair.videoId;
    pageToken = null;
    await pollMessages();
    if (!connected) return false;
    return true;
  }

  function startLiveStandby() {
    if (liveWatchTimer || intentionalStop) return;
    emitStatus({
      connecting: true,
      connected: false,
      error: null,
      hint: 'Waiting for YouTube Go Live — connects automatically when you start on YouTube'
    });
    liveWatchTimer = setInterval(async () => {
      if (intentionalStop || connected) {
        clearLiveWatch();
        return;
      }
      try {
        if (await attachIfLive()) {
          clearLiveWatch();
          beginPolling();
        }
      } catch (err) {
        const mapped = mapYoutubeAuthError(err);
        const msg = mapped.message || String(mapped);
        if (!/no live stream/i.test(msg)) {
          emitStatus({ connecting: false, connected: false, error: msg });
        }
      }
    }, LIVE_STANDBY_MS);
  }

  function requestOpts() {
    if (accessToken) return { headers: { Authorization: `Bearer ${accessToken}` } };
    return {};
  }

  function keySuffix() {
    if (accessToken) return '';
    return `&key=${encodeURIComponent(apiKey)}`;
  }

  async function fetchVideoRow(videoId) {
    if (!videoId) return null;
    const videoUrl =
      `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,snippet&id=${encodeURIComponent(videoId)}` +
      keySuffix();
    const video = await fetchJson(videoUrl, requestOpts());
    return video.items?.[0] || null;
  }

  /** True only when YouTube reports this video is actively live right now. */
  function isVideoRowLive(row) {
    if (!row) return false;
    if (row.snippet?.liveBroadcastContent !== 'live') return false;
    const details = row.liveStreamingDetails;
    if (!details?.activeLiveChatId) return false;
    if (details.actualEndTime) return false;
    return true;
  }

  async function verifyVideoIsLive(videoId) {
    const row = await fetchVideoRow(videoId);
    return isVideoRowLive(row);
  }

  async function resolveChannelIdForApi(rawChannelId) {
    const norm = normalizeYoutubeChannelId(rawChannelId);
    if (/^UC[\w-]{10,}$/i.test(norm)) return norm;

    if (norm.startsWith('@')) {
      const handle = norm.slice(1);
      const byHandle = await fetchJson(
        `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handle)}${keySuffix()}`,
        requestOpts()
      );
      const id = byHandle.items?.[0]?.id;
      if (id) return id;
    }

    return norm;
  }

  async function getOAuthChannelId() {
    if (!accessToken) return null;
    const data = await fetchJson(
      `https://www.googleapis.com/youtube/v3/channels?part=id&mine=true${keySuffix()}`,
      requestOpts()
    );
    return data.items?.[0]?.id || null;
  }

  async function getChannelIdsToCheck() {
    const ids = new Set();
    const fromConfig = await resolveChannelIdForApi(channelId);
    if (fromConfig && /^UC[\w-]{10,}$/i.test(fromConfig)) ids.add(fromConfig);

    const oauthId = await getOAuthChannelId();
    if (oauthId) {
      ids.add(oauthId);
      channelId = oauthId;
    }

    return [...ids];
  }

  async function pairFromVideoId(videoId) {
    if (!videoId) return null;
    const row = await fetchVideoRow(videoId);
    if (!isVideoRowLive(row)) return null;
    return {
      videoId,
      liveChatId: row.liveStreamingDetails.activeLiveChatId
    };
  }

  async function chatIdFromBroadcastItems(items = []) {
    for (const item of items || []) {
      if (item.status?.lifeCycleStatus !== 'live') continue;
      const videoId = item.id;
      if (!videoId) continue;
      const pair = await pairFromVideoId(videoId);
      if (pair) return pair;
    }
    return null;
  }

  async function tryLiveBroadcastsApi() {
    if (!accessToken) return null;

    try {
      const active = await fetchJson(
        'https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status&broadcastStatus=active&broadcastType=all' +
          keySuffix(),
        requestOpts()
      );
      const pair = await chatIdFromBroadcastItems(active.items);
      if (pair) return pair;
    } catch {
      /* try mine */
    }

    const mine = await fetchJson(
      'https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status&mine=true&broadcastType=all' +
        keySuffix(),
      requestOpts()
    );
    return chatIdFromBroadcastItems(mine.items);
  }

  async function trySearchLive(channelIds) {
    for (const cid of channelIds) {
      try {
        const searchUrl =
          `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(cid)}` +
          `&eventType=live&type=video&maxResults=5${keySuffix()}`;
        const search = await fetchJson(searchUrl, requestOpts());
        for (const item of search.items || []) {
          const pair = await pairFromVideoId(item.id?.videoId);
          if (pair) return pair;
        }
      } catch {
        /* next channel */
      }
    }
    return null;
  }

  async function trySearchRecentLive(channelIds) {
    for (const cid of channelIds) {
      try {
        const searchUrl =
          `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(cid)}` +
          `&type=video&order=date&maxResults=15${keySuffix()}`;
        const search = await fetchJson(searchUrl, requestOpts());
        for (const item of search.items || []) {
          if (item.snippet?.liveBroadcastContent !== 'live') continue;
          const pair = await pairFromVideoId(item.id?.videoId);
          if (pair) return pair;
        }
      } catch {
        /* next */
      }
    }
    return null;
  }

  async function tryUploadsPlaylist(channelIds) {
    for (const cid of channelIds) {
      try {
        const ch = await fetchJson(
          `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${encodeURIComponent(cid)}${keySuffix()}`,
          requestOpts()
        );
        const uploadsId = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (!uploadsId) continue;

        const pl = await fetchJson(
          `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${encodeURIComponent(uploadsId)}&maxResults=25${keySuffix()}`,
          requestOpts()
        );

        for (const item of pl.items || []) {
          if (item.snippet?.liveBroadcastContent !== 'live') continue;
          const pair = await pairFromVideoId(item.snippet?.resourceId?.videoId);
          if (pair) return pair;
        }
      } catch {
        /* next channel */
      }
    }
    return null;
  }

  function parseLiveVideoIdFromHtml(html) {
    if (!html || (!/"isLive":true/i.test(html) && !/"isLiveNow":true/i.test(html))) {
      return null;
    }
    const watch = html.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
    if (watch) return watch[1];
    const quoted = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (quoted) return quoted[1];
    return null;
  }

  async function tryChannelLivePage(channelIds) {
    for (const cid of channelIds) {
      const urls = [
        `https://www.youtube.com/channel/${cid}/live`,
        `https://www.youtube.com/channel/${cid}/streams`
      ];
      for (const pageUrl of urls) {
        try {
          const html = await fetchText(pageUrl, {
            userAgent: BROWSER_UA,
            timeout: 20000,
            headers: { 'Accept-Language': 'en-US,en;q=0.9' }
          });
          const videoId = parseLiveVideoIdFromHtml(html);
          const pair = await pairFromVideoId(videoId);
          if (pair) return pair;
        } catch {
          /* try next url */
        }
      }
    }
    return null;
  }

  async function resolveLivePairOnce() {
    const channelIds = await getChannelIdsToCheck();
    if (!channelIds.length) {
      throw new Error('YouTube channel ID invalid — sign in with Google or paste your UC… channel ID');
    }

    const attempts = [
      tryLiveBroadcastsApi,
      () => trySearchLive(channelIds),
      () => trySearchRecentLive(channelIds),
      () => tryUploadsPlaylist(channelIds),
      () => tryChannelLivePage(channelIds)
    ];

    for (const fn of attempts) {
      const pair = await fn();
      if (pair?.liveChatId && pair?.videoId) return pair;
    }

    throw new Error(
      'no live stream found. Start streaming in YouTube Studio (Go Live), wait ~30s, then Connect — must be live on YouTube, not only Twitch/Kick.'
    );
  }

  async function resolveLivePairWithWait() {
    const deadline = Date.now() + WAIT_FOR_LIVE_MS;
    let lastErr;
    while (!intentionalStop && Date.now() < deadline) {
      try {
        return await resolveLivePairOnce();
      } catch (e) {
        lastErr = e;
        if (!/no live stream/i.test(e.message || '')) throw e;
        emitStatus({
          connecting: true,
          connected: false,
          hint: 'waiting for you to go live in YouTube Studio'
        });
        await sleep(WAIT_POLL_MS);
      }
    }
    throw lastErr || new Error('no live stream found');
  }

  async function assertStreamStillLive() {
    if (!liveVideoId) return false;
    return verifyVideoIsLive(liveVideoId);
  }

  function markOffline(reason) {
    connected = false;
    liveChatId = null;
    liveVideoId = null;
    pageToken = null;
    clearPoll();
    liveCheckStrikes.ok();
    pollStrikes.ok();
    if (intentionalStop) {
      emitStatus({
        connected: false,
        connecting: false,
        error: reason || null
      });
      return;
    }
    startLiveStandby();
  }

  async function pollMessages() {
    if (!liveChatId || intentionalStop) return;
    if (!accessToken && !apiKey) return;

    try {
      let url =
        `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${encodeURIComponent(liveChatId)}` +
        `&part=snippet,authorDetails&maxResults=200${keySuffix()}`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

      const data = await fetchJson(url, requestOpts());
      pageToken = data.nextPageToken || pageToken;
      if (data.pollingIntervalMillis) {
        pollDelayMs = Math.max(2000, Math.min(Number(data.pollingIntervalMillis) || POLL_MS, 15000));
      }
      pollStrikes.ok();

      for (const item of data.items || []) {
        const snippet = item.snippet || {};
        const authorDetails = item.authorDetails || {};
        const ts = snippet.publishedAt ? Date.parse(snippet.publishedAt) : Date.now();
        const eventType = snippet.type || '';

        if (eventType === 'newMemberEvent') {
          const author = authorDetails.displayName || 'Someone';
          emitter.emit('message', {
            id: item.id || `join-${ts}-${author}`,
            platform: 'youtube',
            author,
            kind: 'join',
            text: `${author} joined`,
            timestamp: Number.isFinite(ts) ? ts : Date.now()
          });
          continue;
        }

        const text = snippet.displayMessage || '';
        if (!text) continue;

        emitter.emit('message', {
          id: item.id || `${ts}-${authorDetails.displayName}`,
          platform: 'youtube',
          author: authorDetails.displayName || 'unknown',
          color: null,
          text,
          badges: authorDetails.isChatOwner ? 'owner' : authorDetails.isVerified ? 'verified' : '',
          timestamp: Number.isFinite(ts) ? ts : Date.now()
        });
      }

      if (!connected) {
        connected = true;
        emitStatus();
      }
    } catch (err) {
      const msg = err.message || String(err);
      if (/not found|invalid|forbidden|ended|no longer|liveChat/i.test(msg)) {
        markOffline('YouTube chat ended — Connect again when live');
        return;
      }
      if (pollStrikes.fail()) return;
      emitStatus({
        connected: true,
        error: `YouTube poll hiccup (${pollStrikes.count}/${POLL_FAIL_THRESHOLD})`
      });
    }
  }

  async function runLiveCheck() {
    if (!liveVideoId || intentionalStop || !connected) return;
    if (await assertStreamStillLive()) {
      liveCheckStrikes.ok();
      return;
    }
    liveCheckStrikes.fail();
  }

  return {
    async connect(config = {}) {
      channelId = normalizeYoutubeChannelId(config.channelId || config.auth?.channelId || '');
      apiKey = String(config.apiKey || '').trim();
      accessToken = String(config.accessToken || config.auth?.accessToken || '').trim();
      if (!channelId && !accessToken) {
        throw new Error('YouTube channel ID required — sign in with Google or enter channel ID');
      }
      if (!accessToken && !apiKey) {
        throw new Error('YouTube sign-in required — click Sign in with Browser or add an API key');
      }

      intentionalStop = false;
      clearLiveWatch();
      pageToken = null;
      connected = false;
      liveChatId = null;
      liveVideoId = null;
      emitStatus({ connecting: true, hint: null, error: null, connected: false });

      try {
        if (await attachIfLive()) {
          beginPolling();
          return;
        }
      } catch (err) {
        const mapped = mapYoutubeAuthError(err);
        const msg = mapped.message || String(mapped);
        if (!/no live stream/i.test(msg)) throw mapped;
      }

      startLiveStandby();
    },

    disconnect() {
      intentionalStop = true;
      clearLiveWatch();
      clearPoll();
      connected = false;
      channelId = null;
      apiKey = null;
      accessToken = null;
      liveChatId = null;
      liveVideoId = null;
      pageToken = null;
      emitStatus();
    },

    async send(text) {
      if (!canSendNow()) throw new Error('YouTube send requires sign-in and live chat');
      if (!(await assertStreamStillLive())) {
        markOffline('YouTube no longer live');
        throw new Error('YouTube no longer live');
      }
      const msg = String(text || '').trim();
      if (!msg) throw new Error('Message required');
      await postJson(
        'https://www.googleapis.com/youtube/v3/liveChatMessages?part=snippet',
        {
          snippet: {
            liveChatId,
            type: 'textMessageEvent',
            textMessageDetails: { messageText: msg.replace(/\r|\n/g, ' ') }
          }
        },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
    },

    getStatus() {
      return {
        platform: 'youtube',
        connected,
        channel: channelId,
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

module.exports = { createYoutubeConnector, normalizeYoutubeChannelId };

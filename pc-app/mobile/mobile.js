(function () {
  const { RelayClient, ROLES, httpBaseFromRelay } = SwiftSyncProtocol;

  const LOGO_URL = '../assets/logo.png';
  const TAB_PAGES = {
    connect: 'connect-screen',
    scenes: 'scenes',
    audio: 'audio-panel',
    chat: 'chat-panel',
    tools: 'tools-panel'
  };

  const TAB_ORDER = ['connect', 'scenes', 'audio', 'chat', 'tools'];
  const carouselTrack = document.getElementById('carousel-track');
  const pageCarousel = document.getElementById('page-carousel');
  const tabSlide =
    pageCarousel && carouselTrack && typeof SwiftSyncTabSlide !== 'undefined'
      ? SwiftSyncTabSlide.create({
          viewportEl: pageCarousel,
          trackEl: carouselTrack,
          tabOrder: TAB_ORDER,
          tabToPageId: TAB_PAGES
        })
      : null;

  const relayUrlInput = document.getElementById('relay-url');
  const pairingCodeInput = document.getElementById('pairing-code');
  const pairBtn = document.getElementById('pair-btn');
  const disconnectBtn = document.getElementById('disconnect-btn');
  const pairFields = document.getElementById('pair-fields');
  const connectSubtitle = document.getElementById('connect-subtitle');
  const mobileInviteSection = document.getElementById('mobile-invite-section');
  const mobileInviteQr = document.getElementById('mobile-invite-qr');
  const mobileInviteCode = document.getElementById('mobile-invite-code');
  const mobileInviteUrl = document.getElementById('mobile-invite-url');
  const mobileInviteCopyBtn = document.getElementById('mobile-invite-copy-btn');
  const statusLine = document.getElementById('status-line');
  let lastInviteUrl = '';
  let qrLibPromise = null;
  const pillRelay = document.getElementById('pill-relay');
  const pillObs = document.getElementById('pill-obs');
  const pillChat = document.getElementById('pill-chat');
  const sceneList = document.getElementById('scene-list');
  const linkedScenesHeader = document.getElementById('linked-scenes-header');
  const sceneVisualList = document.getElementById('scene-visual-list');
  const sceneSourcesEmpty = document.getElementById('scene-sources-empty');
  const globalAudioList = document.getElementById('global-audio-list');
  const audioEmpty = document.getElementById('audio-empty');
  const chatMessagesEl = document.getElementById('chat-messages');
  const chatEmpty = document.getElementById('chat-empty');
  const chatChannelLabel = document.getElementById('chat-channel-label');
  const chatSendInput = document.getElementById('chat-send-input');
  const chatSendBtn = document.getElementById('chat-send-btn');
  const chatSendPlatform = document.getElementById('chat-send-platform');
  const chatFilterChips = document.getElementById('chat-filter-chips');
  const chatFloatBtn = document.getElementById('chat-float-btn');
  const chatFloatHint = document.getElementById('chat-float-hint');
  const canvasHint = document.getElementById('canvas-hint');

  let chatMessages = [];
  let chatChannel = '';
  let chatConnected = false;
  let chatCanSend = false;
  let chatStatuses = {};
  let chatPlatforms = [];
  let chatFilter = 'all';
  let chatModsOnly = false;
  let chatDedupe = false;
  const mobileSetupHost = document.getElementById('mobile-setup-checklist-host');
  const mobileRelayHealth = document.getElementById('mobile-relay-health');
  const mobileRelayHealthText = document.getElementById('mobile-relay-health-text');
  const mobileRelayRetryBtn = document.getElementById('mobile-relay-retry-btn');
  const mobileInviteShareBtn = document.getElementById('mobile-invite-share-btn');
  const mobileOauthSection = document.getElementById('mobile-oauth-section');
  const mobileOauthButtons = document.getElementById('mobile-oauth-buttons');
  const mobileOauthStatus = document.getElementById('mobile-oauth-status');
  const mobileOauthHint = document.getElementById('mobile-oauth-hint');
  let oauthPlatformsAvailable = null;
  let lastOAuthReturnHandled = false;
  let floatChatMessagesEl = null;

  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const supportsDocumentPiP = typeof documentPictureInPicture !== 'undefined';

  const CHAT_PLATFORM_LABELS = {
    twitch: 'Twitch',
    kick: 'Kick',
    youtube: 'YouTube',
    tiktok: 'TikTok'
  };

  const stateEls = {
    stream: document.getElementById('state-stream'),
    record: document.getElementById('state-record'),
    replay: document.getElementById('state-replay'),
    vcam: document.getElementById('state-vcam'),
    studio: document.getElementById('state-studio')
  };

  const client = new RelayClient(ROLES.MOBILE);
  let currentScene = '';
  let sceneLinks = [];
  let dualCanvasMode = false;
  let mobilePreviewEnabled = true;
  let obsConnected = false;
  let lastObsOnlineAt = 0;
  let obsSyncTimer = null;
  let httpObsSyncTimer = null;
  let pcLinkCheckTimer = null;
  let flyInstanceId = '';
  let cloudChatHeartbeatTimer = null;
  const CHAT_ONLY_MODE = (() => {
    try {
      return new URLSearchParams(location.search).get('mode') === 'chat';
    } catch {
      return false;
    }
  })();

  function applyChatOnlyMode() {
    if (!CHAT_ONLY_MODE) return;
    document.body.classList.add('chat-only-mode');
    if (connectSubtitle) {
      connectSubtitle.textContent =
        'Chat-only — sign in on your phone. No PC required.';
    }
    const title = document.querySelector('.connect-title');
    if (title) title.textContent = 'SwiftSync Chat';
    ensureChatOnlyPairingCode();
    refreshMobileOAuthUi();
    refreshMobileSetupChecklist();
  }

  function generateMobilePairingCode() {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  function ensureChatOnlyPairingCode() {
    if (!CHAT_ONLY_MODE || pairingCodeInput.value.trim()) return;
    pairingCodeInput.value = generateMobilePairingCode();
    saveSession(false);
  }

  function httpBaseFromPage() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return '';
    return location.origin;
  }

  function oauthReturnPath() {
    const params = new URLSearchParams(location.search);
    params.delete('oauth');
    params.delete('platform');
    params.delete('oauth_warn');
    if (CHAT_ONLY_MODE && !params.has('mode')) params.set('mode', 'chat');
    const qs = params.toString();
    return `${location.pathname}${qs ? `?${qs}` : ''}`;
  }

  function buildOAuthStartUrl(platform) {
    const code = pairingCodeInput.value.trim().toUpperCase();
    const base = httpBaseFromPage();
    if (!base || !code) return '';
    const ret = encodeURIComponent(oauthReturnPath());
    return `${base}/api/oauth/start/${platform}?code=${encodeURIComponent(code)}&return=${ret}`;
  }

  async function fetchOAuthStatus() {
    const base = httpBaseFromPage();
    if (!base) return null;
    try {
      const res = await fetch(`${base}/api/oauth/status`, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function refreshMobileOAuthUi() {
    if (!CHAT_ONLY_MODE || !mobileOauthSection) return;
    if (!oauthPlatformsAvailable) {
      oauthPlatformsAvailable = await fetchOAuthStatus();
    }
    const platforms = oauthPlatformsAvailable?.platforms || {};
    const configured = Object.entries(platforms).filter(([, ok]) => ok);
    mobileOauthSection.hidden = false;

    if (mobileOauthButtons) {
      mobileOauthButtons.innerHTML = '';
      if (!configured.length) {
        mobileOauthButtons.innerHTML =
          '<p class="panel-subtitle">Phone sign-in is not configured on this relay yet.</p>';
      } else {
        for (const [platform] of configured) {
          const btn = document.createElement('a');
          btn.className = 'tool-btn mobile-oauth-btn';
          btn.textContent = `Sign in with ${CHAT_PLATFORM_LABELS[platform] || platform}`;
          btn.href = buildOAuthStartUrl(platform);
          btn.setAttribute('rel', 'noopener');
          mobileOauthButtons.appendChild(btn);
        }
      }
    }

    const code = pairingCodeInput.value.trim().toUpperCase();
    if (code && isCloudHostedPage()) {
      try {
        const st = await fetch(
          `${httpBaseFromPage()}/api/chat-config/status?code=${encodeURIComponent(code)}`,
          { cache: 'no-store' }
        );
        if (st.ok) {
          const data = await st.json();
          if (data.ready && mobileOauthHint) {
            mobileOauthHint.textContent =
              'Signed in — tap Connect, then open Chat. Add more platforms anytime.';
          }
        }
      } catch (_) {}
    }
  }

  function setMobileOauthStatus(msg, isError) {
    if (!mobileOauthStatus) return;
    mobileOauthStatus.textContent = msg || '';
    mobileOauthStatus.classList.toggle('ok', !!msg && !isError);
    mobileOauthStatus.classList.toggle('err', !!msg && !!isError);
  }

  async function handleOAuthReturn() {
    if (lastOAuthReturnHandled) return;
    const params = new URLSearchParams(location.search);
    if (params.get('oauth') !== 'ok') return;
    lastOAuthReturnHandled = true;
    const platform = params.get('platform') || 'platform';
    const warn = params.get('oauth_warn');
    params.delete('oauth');
    params.delete('platform');
    params.delete('oauth_warn');
    const qs = params.toString();
    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
    setMobileOauthStatus(
      `${CHAT_PLATFORM_LABELS[platform] || platform} connected${warn ? ` (${warn})` : ''}.`,
      false
    );
    await refreshMobileOAuthUi();
    refreshMobileSetupChecklist();
    if (client.connected) {
      await sendCommand('connectChat');
      startCloudChatHeartbeat();
      pollChat();
      switchTab('chat');
      setStatus('Signed in — cloud chat active while this app is open.');
    } else if (pairingCodeInput.value.trim() && relayUrlInput.value.trim()) {
      setTimeout(() => connect(), 400);
    }
  }

  function stopCloudChatHeartbeat() {
    if (cloudChatHeartbeatTimer) {
      clearInterval(cloudChatHeartbeatTimer);
      cloudChatHeartbeatTimer = null;
    }
  }

  function startCloudChatHeartbeat() {
    if (!CHAT_ONLY_MODE) return;
    stopCloudChatHeartbeat();
    const tick = () => {
      if (!client.connected) return;
      client.send({ from: 'mobile', command: 'chatHeartbeat' });
    };
    tick();
    cloudChatHeartbeatTimer = setInterval(tick, 25000);
  }

  function onChatOnlyVisibility() {
    if (!CHAT_ONLY_MODE || !client.connected) return;
    if (document.visibilityState === 'hidden') {
      client.send({ from: 'mobile', command: 'stopChat' });
      stopCloudChatHeartbeat();
    } else {
      sendCommand('connectChat');
      startCloudChatHeartbeat();
    }
  }

  document.addEventListener('visibilitychange', onChatOnlyVisibility);

  function awaitCommandError(ms = 2500) {
    return new Promise((resolve) => {
      if (commandErrorWaiter) clearTimeout(commandErrorWaiter.timer);
      const timer = setTimeout(() => {
        commandErrorWaiter = null;
        resolve('');
      }, ms);
      commandErrorWaiter = { resolve, timer };
    });
  }

  function resolveCommandError(message) {
    if (!commandErrorWaiter) return;
    clearTimeout(commandErrorWaiter.timer);
    commandErrorWaiter.resolve(message || '');
    commandErrorWaiter = null;
  }

  document.getElementById('swift-logo').style.backgroundImage = `url('${LOGO_URL}')`;
  document.getElementById('corner-logo').style.backgroundImage = `url('${LOGO_URL}')`;

  function setStatus(msg, isError) {
    statusLine.textContent = msg || '';
    statusLine.style.color = isError ? '#ff4444' : '';
  }

  function setPill(el, ok, label) {
    el.textContent = label;
    el.classList.remove('ok', 'err');
    el.classList.add(ok ? 'ok' : 'err');
  }

  const SESSION_KEYS = {
    relay: 'swiftsync-mobile-relay',
    code: 'swiftsync-mobile-code',
    paired: 'swiftsync-mobile-paired'
  };

  function setCookie(name, value, maxAgeSec) {
    if (!value) return;
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSec}${secure}; SameSite=Lax`;
  }

  function getCookie(name) {
    const prefix = `${name}=`;
    for (const part of document.cookie.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith(prefix)) {
        return decodeURIComponent(trimmed.slice(prefix.length));
      }
    }
    return '';
  }

  function readStoredRelay() {
    try {
      return (
        localStorage.getItem(SESSION_KEYS.relay) ||
        getCookie(SESSION_KEYS.relay) ||
        ''
      );
    } catch {
      return getCookie(SESSION_KEYS.relay) || '';
    }
  }

  function readStoredCode() {
    try {
      return (
        localStorage.getItem(SESSION_KEYS.code) ||
        getCookie(SESSION_KEYS.code) ||
        ''
      ).toUpperCase();
    } catch {
      return (getCookie(SESSION_KEYS.code) || '').toUpperCase();
    }
  }

  function wasPairedBefore() {
    try {
      return (
        localStorage.getItem(SESSION_KEYS.paired) === '1' ||
        getCookie(SESSION_KEYS.paired) === '1'
      );
    } catch {
      return getCookie(SESSION_KEYS.paired) === '1';
    }
  }

  function saveSession(paired = wasPairedBefore()) {
    if (isCloudHostedPage() && relayFromPageOrigin()) {
      relayUrlInput.value = relayFromPageOrigin();
    }
    const relay = relayUrlInput.value.trim();
    const code = pairingCodeInput.value.trim().toUpperCase();
    const ttl = 60 * 60 * 24 * 365;
    try {
      if (relay) {
        localStorage.setItem(SESSION_KEYS.relay, relay);
        setCookie(SESSION_KEYS.relay, relay, ttl);
      }
      if (code) {
        localStorage.setItem(SESSION_KEYS.code, code);
        setCookie(SESSION_KEYS.code, code, ttl);
      }
      if (paired) {
        localStorage.setItem(SESSION_KEYS.paired, '1');
        setCookie(SESSION_KEYS.paired, '1', ttl);
      }
    } catch (_) {
      if (relay) setCookie(SESSION_KEYS.relay, relay, ttl);
      if (code) setCookie(SESSION_KEYS.code, code, ttl);
      if (paired) setCookie(SESSION_KEYS.paired, '1', ttl);
    }
  }

  function loadSession() {
    const savedRelay = readStoredRelay();
    const savedCode = readStoredCode();
    if (savedRelay && !relayUrlInput.value.trim()) {
      relayUrlInput.value = savedRelay;
    }
    if (savedCode && !pairingCodeInput.value.trim()) {
      pairingCodeInput.value = savedCode;
    }
  }

  function isCloudHostedPage() {
    const h = location.hostname;
    return (
      h &&
      h !== 'localhost' &&
      h !== '127.0.0.1' &&
      !/^192\.168\./.test(h) &&
      !/^10\./.test(h)
    );
  }

  function ensureCloudRelayDefault() {
    const originRelay = relayFromPageOrigin();
    // Cloud-hosted mobile must use the cloud relay — stale LAN URLs in storage
    // leave the phone "connected" to local cache while the PC uses cloud WS.
    if (isCloudHostedPage() && originRelay) {
      relayUrlInput.value = originRelay;
      return;
    }
    if (relayUrlInput.value.trim()) return;
    const isLocal =
      location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (originRelay && !isLocal) {
      relayUrlInput.value = originRelay;
    }
  }

  function updateRememberHint() {
    const hint = document.getElementById('remember-hint');
    if (!hint) return;
    const hasSaved = !!(readStoredCode() && (readStoredRelay() || relayFromPageOrigin()));
    if (hasSaved && wasPairedBefore()) {
      hint.textContent = 'Saved on this phone — tap Connect to reconnect.';
      hint.style.display = 'block';
    } else if (pairingCodeInput.value && relayUrlInput.value) {
      hint.textContent = 'Ready — tap Connect.';
      hint.style.display = 'block';
    } else {
      hint.style.display = 'none';
    }
  }

  function apiHeaders(extra = {}) {
    const headers = { ...extra };
    if (flyInstanceId) headers['Fly-Replay-Instance'] = flyInstanceId;
    return headers;
  }

  function rememberFlyInstance(id) {
    if (!id) return;
    flyInstanceId = String(id);
  }

  async function fetchRelayStatus() {
    const httpBase = httpBaseFromRelay(relayUrlInput.value.trim());
    const code = pairingCodeInput.value.trim().toUpperCase();
    if (!httpBase || !code) return null;
    try {
      const res = await fetch(`${httpBase}/api/relay-status?code=${encodeURIComponent(code)}`, {
        cache: 'no-store',
        headers: apiHeaders()
      });
      if (!res.ok) return null;
      const body = await res.json();
      if (body.flyInstanceId) rememberFlyInstance(body.flyInstanceId);
      return body;
    } catch (_) {
      return null;
    }
  }

  function startPcLinkCheck() {
    stopPcLinkCheck();
    pcLinkCheckTimer = setInterval(async () => {
      if (!client.connected) return;
      const status = await fetchRelayStatus();
      if (!status) return;
      if (status.pcLinked) return;
      setStatus('PC not linked to relay — open SwiftSync on your streaming PC.', true);
    }, 8000);
  }

  function stopPcLinkCheck() {
    if (pcLinkCheckTimer) {
      clearInterval(pcLinkCheckTimer);
      pcLinkCheckTimer = null;
    }
  }

  async function postMobileCommand(cmd, extra = {}) {
    const code = pairingCodeInput.value.trim().toUpperCase();
    const httpBase = httpBaseFromRelay(relayUrlInput.value.trim());
    if (!httpBase || !code) return { ok: false, skipped: true };

    const res = await fetch(`${httpBase}/api/mobile-cmd`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ pairingCode: code, command: cmd, ...extra })
    });
    const replay = res.headers.get('Fly-Replay-Instance');
    if (replay) rememberFlyInstance(replay);
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  function setObsOnline(online, hint) {
    if (online) {
      lastObsOnlineAt = Date.now();
      obsConnected = true;
      setPill(pillObs, true, 'OBS: connected');
      if (hint) setStatus(hint);
      stopObsSyncPoll();
      return;
    }

    // Ignore brief offline blips from HTTP cache / ping races.
    if (obsConnected && Date.now() - lastObsOnlineAt < 8000) return;

    obsConnected = false;
    setPill(pillObs, false, 'OBS: offline');
    if (hint) setStatus(hint, true);
  }

  function startObsSyncPoll() {
    stopObsSyncPoll();
    let attempts = 0;
    obsSyncTimer = setInterval(() => {
      if (!client.connected) {
        stopObsSyncPoll();
        return;
      }
      if (obsConnected) {
        stopObsSyncPoll();
        return;
      }
      if (attempts++ >= 20) {
        stopObsSyncPoll();
        setStatus('OBS still offline on PC — open SwiftSync Home tab and tap Connect.', true);
        return;
      }
      client.ping();
      client.getState();
    }, 1500);
  }

  function stopObsSyncPoll() {
    if (obsSyncTimer) {
      clearInterval(obsSyncTimer);
      obsSyncTimer = null;
    }
  }

  function startHttpObsSyncPoll() {
    stopHttpObsSyncPoll();
    pollHttpObsState();
    pollSceneSources();
    pollGlobalAudio();
    pollChat();
    httpObsSyncTimer = setInterval(() => {
      pollHttpObsState();
      pollSceneSources();
      pollGlobalAudio();
      pollChat();
    }, 2000);
  }

  function stopHttpObsSyncPoll() {
    if (httpObsSyncTimer) {
      clearInterval(httpObsSyncTimer);
      httpObsSyncTimer = null;
    }
  }

  async function checkRelayHealth() {
    const httpBase = httpBaseFromRelay(relayUrlInput.value.trim());
    if (!httpBase) return;
    try {
      const res = await fetch(`${httpBase}/api/health`, { cache: 'no-store' });
      if (!res.ok) {
        setStatus('Relay needs restart — on PC: close ALL SwiftSync windows, then npm start.', true);
      }
    } catch (_) {
      if (isCloudRelayHttp(httpBaseFromRelay(relayUrlInput.value.trim()))) {
        setStatus('Cannot reach cloud relay — check your connection.', true);
      } else {
        setStatus('Cannot reach PC relay over HTTP — phone on same Wi‑Fi as PC?', true);
      }
    }
  }

  async function pollHttpObsState() {
    const httpBase = httpBaseFromRelay(relayUrlInput.value.trim());
    if (!httpBase) return;
    try {
      const res = await fetch(`${httpBase}/api/obs-state${apiCodeQuery()}`, {
        cache: 'no-store',
        headers: apiHeaders()
      });
      if (res.status === 404) {
        if (isCloudRelayHttp(httpBase)) {
          if (!client.connected) {
            setStatus('Scan the QR on your PC Home tab again (code may have changed).', true);
          }
          return;
        }
        setStatus('Relay outdated — close ALL SwiftSync on PC and run npm start again.', true);
        return;
      }
      if (!res.ok) return;
      const snap = await res.json();
      const payload = snap.payload;
      const hasLiveData = !!(payload?.scenes?.length || payload?.sceneLinks?.length);
      if (payload && (snap.obsConnected || hasLiveData || obsConnected)) {
        applyObsState(payload, { fromHttp: true });
      } else if (snap.obsConnected && !obsConnected) {
        setObsOnline(true);
      }
    } catch (_) {}
  }

  function apiCodeQuery() {
    const code = pairingCodeInput.value.trim().toUpperCase();
    return code ? `?code=${encodeURIComponent(code)}` : '';
  }

  function isCloudRelayHttp(httpBase) {
    if (!httpBase) return false;
    return !/(localhost|127\.0\.0\.1|192\.168\.)/i.test(httpBase);
  }

  function buildMobileInviteUrl(code) {
    const c = (code || pairingCodeInput.value.trim()).toUpperCase();
    const relay = relayUrlInput.value.trim();
    const httpBase = httpBaseFromRelay(relay);
    if (!c || !httpBase) return '';
    if (isCloudRelayHttp(httpBase) || isCloudHostedPage()) {
      return `${httpBase}/mobile/?code=${encodeURIComponent(c)}&relay=${encodeURIComponent(relay)}`;
    }
    try {
      const ws = parseRelayUrl(relay);
      if (!ws) return `${httpBase}/mobile/?code=${encodeURIComponent(c)}`;
      const u = new URL(ws.replace(/^ws/i, 'http'));
      const host = u.hostname;
      const port = u.port || '4000';
      return `${httpBase}/mobile/?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}&code=${encodeURIComponent(c)}`;
    } catch (_) {
      return `${httpBase}/mobile/?code=${encodeURIComponent(c)}`;
    }
  }

  function parseRelayUrl(input) {
    return SwiftSyncProtocol.parseRelayUrl(input);
  }

  async function fetchPairingInvite() {
    const httpBase = httpBaseFromRelay(relayUrlInput.value.trim());
    const fallbackCode = pairingCodeInput.value.trim().toUpperCase();
    if (httpBase && fallbackCode) {
      try {
        const res = await fetch(`${httpBase}/api/pairing${apiCodeQuery()}`, {
          cache: 'no-store',
          headers: apiHeaders()
        });
        if (res.ok) {
          const data = await res.json();
          return {
            code: (data.code || fallbackCode).toUpperCase(),
            mobileUrl: data.mobileUrl || buildMobileInviteUrl(data.code || fallbackCode),
            qrDataUrl: data.qrDataUrl || ''
          };
        }
      } catch (_) {}
    }
    return {
      code: fallbackCode,
      mobileUrl: buildMobileInviteUrl(fallbackCode),
      qrDataUrl: ''
    };
  }

  function inviteQrImageUrl(url) {
    return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=10&data=${encodeURIComponent(url)}`;
  }

  function hasShareablePairing() {
    return !!(pairingCodeInput.value.trim() && relayUrlInput.value.trim());
  }

  function updateInviteSectionVisibility() {
    if (!mobileInviteSection) return;
    mobileInviteSection.hidden = !(client.connected || hasShareablePairing());
  }

  async function generateInviteQrDataUrl(url) {
    if (!url) return '';
    try {
      await loadQrLib();
      if (typeof QRCode !== 'undefined') {
        return await QRCode.toDataURL(url, { margin: 1, width: 220 });
      }
    } catch (_) {}
    return '';
  }

  function setInviteQrImage(url, dataUrl) {
    if (!mobileInviteQr || !url) return;
    mobileInviteQr.classList.add('loading');
    const fallbacks = [dataUrl, inviteQrImageUrl(url)].filter(Boolean);
    let idx = 0;
    const tryNext = () => {
      if (idx >= fallbacks.length) {
        mobileInviteQr.classList.remove('loading');
        return;
      }
      mobileInviteQr.onload = () => mobileInviteQr.classList.remove('loading');
      mobileInviteQr.onerror = () => {
        idx += 1;
        tryNext();
      };
      mobileInviteQr.src = fallbacks[idx++];
    };
    tryNext();
  }

  function loadQrLib() {
    if (typeof QRCode !== 'undefined') return Promise.resolve();
    if (qrLibPromise) return qrLibPromise;
    qrLibPromise = new Promise((resolve, reject) => {
      const bases = [
        `${location.origin}/shared/qrcode.min.js`,
        `${location.origin}/vendor/qrcode.min.js`,
        'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js'
      ];
      let idx = 0;
      const tryNext = () => {
        if (idx >= bases.length) {
          reject(new Error('QR library failed to load'));
          return;
        }
        const script = document.createElement('script');
        script.src = bases[idx++];
        script.onload = () => resolve();
        script.onerror = tryNext;
        document.head.appendChild(script);
      };
      tryNext();
    });
    return qrLibPromise;
  }

  async function refreshMobileInviteQr() {
    if (!mobileInviteSection || !hasShareablePairing()) return;
    updateInviteSectionVisibility();

    let invite = await fetchPairingInvite();
    if (!invite.code || !invite.mobileUrl) {
      const code = pairingCodeInput.value.trim().toUpperCase();
      const mobileUrl = buildMobileInviteUrl(code);
      if (!code || !mobileUrl) return;
      invite = { code, mobileUrl, qrDataUrl: '' };
    }

    lastInviteUrl = invite.mobileUrl;
    if (mobileInviteCode) mobileInviteCode.textContent = invite.code;
    if (mobileInviteUrl) mobileInviteUrl.textContent = invite.mobileUrl;

    let dataUrl = invite.qrDataUrl || '';
    if (!dataUrl) dataUrl = await generateInviteQrDataUrl(invite.mobileUrl);
    setInviteQrImage(invite.mobileUrl, dataUrl);
  }

  function setConnectedHomeUi(connected) {
    if (pairFields) pairFields.classList.toggle('connected-collapsed', connected);
    updateInviteSectionVisibility();
    if (connectSubtitle) {
      if (connected) {
        connectSubtitle.textContent =
          'Connected — scan below to add another phone, or open Scenes / Audio / Tools.';
      } else if (hasShareablePairing()) {
        connectSubtitle.textContent =
          'Pairing ready — tap Connect, or scan the QR below to add another phone.';
      } else {
        connectSubtitle.textContent = 'Scan the QR on your PC once — works on Wi‑Fi and cellular';
      }
    }
    if (connected) {
      pairBtn.style.display = 'none';
      disconnectBtn.style.display = 'inline-block';
      refreshMobileInviteQr();
    } else {
      pairBtn.style.display = 'inline-block';
      pairBtn.disabled = false;
      disconnectBtn.style.display = 'none';
      if (!hasShareablePairing()) {
        lastInviteUrl = '';
        if (mobileInviteQr) {
          mobileInviteQr.removeAttribute('src');
          mobileInviteQr.classList.remove('loading');
        }
      } else {
        refreshMobileInviteQr();
      }
    }
  }

  function relayFromPageOrigin() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return '';
    return location.origin.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  }

  function applyQueryParams() {
    const params = new URLSearchParams(window.location.search);
    const host = params.get('host');
    const port = params.get('port') || '4000';
    const code = params.get('code') || params.get('pairingCode');
    const relayParam = params.get('relay');
    const mobileUrl = params.get('mobileUrl');

    if (relayParam) {
      relayUrlInput.value = decodeURIComponent(relayParam);
    } else if (host) {
      relayUrlInput.value = `ws://${host}:${port}`;
    }

    if (code) {
      pairingCodeInput.value = code.toUpperCase();
    }
    if (mobileUrl && !code) {
      try {
        const u = new URL(mobileUrl);
        const urlRelay = u.searchParams.get('relay');
        if (urlRelay) {
          relayUrlInput.value = decodeURIComponent(urlRelay);
        } else {
          const urlHost = u.searchParams.get('host');
          const urlPort = u.searchParams.get('port') || port;
          if (urlHost) relayUrlInput.value = `ws://${urlHost}:${urlPort}`;
        }
        const c = u.searchParams.get('code');
        if (c) pairingCodeInput.value = c.toUpperCase();
      } catch (_) {}
    }

    loadSession();
    ensureCloudRelayDefault();
    if (CHAT_ONLY_MODE) ensureChatOnlyPairingCode();
    if (pairingCodeInput.value || relayUrlInput.value) {
      saveSession(!!code || !!pairingCodeInput.value);
    }
    updateInviteSectionVisibility();
    if (hasShareablePairing()) refreshMobileInviteQr();
    updateRememberHint();
  }

  let activeTab = 'connect';
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipeActive = false;

  function tabIndex(tab) {
    const idx = TAB_ORDER.indexOf(tab);
    return idx >= 0 ? idx : 0;
  }

  function syncCarouselLayout() {
    tabSlide?.snapLayout();
  }

  function moveCarouselTo(tab, { animate = true, dragOffsetPx = 0 } = {}) {
    if (!tabSlide) return;
    tabSlide.applyTransform(tab, { animate, dragPx: dragOffsetPx });
  }

  function switchTab(tab) {
    const prevTab = activeTab;
    activeTab = tab;
    document.querySelectorAll('.top-tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.carousel-page').forEach((page) => {
      page.classList.toggle('panel-active', page.id === TAB_PAGES[tab]);
    });
    if (tabSlide) {
      tabSlide.activeTab = tab;
      tabSlide.goTo(tab, { animate: prevTab !== tab });
    }
    const activePage = document.getElementById(TAB_PAGES[tab]);
    if (activePage) activePage.scrollTop = 0;
    if (tab === 'chat') {
      document.body.classList.add('connected-chat');
      pollChat();
      sendCommand('connectChat').then(() => sendCommand('getChat'));
    }
    if (tab === 'connect' && client.connected) {
      refreshMobileInviteQr();
    }
  }

  function switchTabByOffset(delta) {
    const idx = tabIndex(activeTab);
    const next = TAB_ORDER[idx + delta];
    if (next) switchTab(next);
  }

  document.querySelectorAll('.top-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  if (pageCarousel) {
    pageCarousel.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) return;
        // Don't intercept touches on controls or scene/audio cards (span inside button counts too)
        if (
          e.target?.closest(
            'input, select, button, textarea, a, label, .scene-card, .scene-switch-btn, .tab-card, .audio-card, .source-row, .chat-filter-chip, .tool-btn'
          )
        ) {
          return;
        }
        swipeStartX = e.touches[0].clientX;
        swipeStartY = e.touches[0].clientY;
        swipeActive = true;
      },
      { passive: true }
    );

    pageCarousel.addEventListener(
      'touchmove',
      (e) => {
        if (!swipeActive || e.touches.length !== 1 || !carouselTrack) return;
        const dx = e.touches[0].clientX - swipeStartX;
        const dy = e.touches[0].clientY - swipeStartY;
        if (Math.abs(dy) > Math.abs(dx)) {
          swipeActive = false;
          return;
        }
        if (Math.abs(dx) < 8) return;
        e.preventDefault();
        const idx = tabIndex(activeTab);
        carouselTrack.classList.add('dragging');
        moveCarouselTo(activeTab, { animate: false, dragOffsetPx: dx });
      },
      { passive: false }
    );

    pageCarousel.addEventListener(
      'touchend',
      (e) => {
        if (!swipeActive) return;
        swipeActive = false;
        carouselTrack?.classList.remove('dragging');
        const touch = e.changedTouches[0];
        if (!touch) {
          moveCarouselTo(activeTab);
          return;
        }
        const dx = touch.clientX - swipeStartX;
        const dy = touch.clientY - swipeStartY;
        if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy)) {
          moveCarouselTo(activeTab);
          return;
        }
        if (dx < 0) switchTabByOffset(1);
        else switchTabByOffset(-1);
      },
      { passive: true }
    );
  }

  async function pollSceneSources() {
    const httpBase = httpBaseFromRelay(relayUrlInput.value.trim());
    if (!httpBase) return;
    try {
      const res = await fetch(`${httpBase}/api/scene-sources${apiCodeQuery()}`, {
        cache: 'no-store',
        headers: apiHeaders()
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.panels?.length) renderSceneSources(data.panels);
    } catch (_) {}
  }

  async function pollGlobalAudio() {
    const httpBase = httpBaseFromRelay(relayUrlInput.value.trim());
    if (!httpBase) return;
    try {
      const res = await fetch(`${httpBase}/api/audio-inputs${apiCodeQuery()}`, {
        cache: 'no-store',
        headers: apiHeaders()
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.inputs?.length) renderGlobalAudio(data.inputs);
    } catch (_) {}
  }

  function updateChatSendPlatformSelect() {
    if (!chatSendPlatform) return;
    const sendPlatforms = Object.entries(chatStatuses)
      .filter(([, s]) => s.canSend && s.connected)
      .map(([p]) => p);
    chatSendPlatform.innerHTML = '';
    if (!sendPlatforms.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '—';
      chatSendPlatform.appendChild(opt);
      chatSendPlatform.disabled = true;
      return;
    }
    if (sendPlatforms.length >= 2) {
      const allOpt = document.createElement('option');
      allOpt.value = 'all';
      allOpt.textContent = 'All platforms';
      chatSendPlatform.appendChild(allOpt);
    }
    sendPlatforms.forEach((platform) => {
      const opt = document.createElement('option');
      opt.value = platform;
      opt.textContent = CHAT_PLATFORM_LABELS[platform] || platform;
      chatSendPlatform.appendChild(opt);
    });
    chatSendPlatform.disabled = !chatCanSend;
  }

  function formatChatLabel() {
    if (chatPlatforms.length) {
      return `Live chat — ${chatPlatforms.map((p) => CHAT_PLATFORM_LABELS[p] || p).join(', ')}`;
    }
    if (chatChannel) return `Live chat — #${chatChannel}`;
    return 'Multi-platform stream chat from your PC';
  }

  function filteredChatMessages() {
    if (typeof SwiftSyncSupport !== 'undefined') {
      return SwiftSyncSupport.filterChatMessages(chatMessages, {
        platform: chatFilter,
        modsOnly: chatModsOnly,
        dedupe: chatDedupe
      });
    }
    if (chatFilter === 'all') return chatMessages;
    return chatMessages.filter((m) => m.platform === chatFilter);
  }

  function refreshMobileSetupChecklist() {
    if (typeof SwiftSyncSupport === 'undefined' || !mobileSetupHost) return;
    if (CHAT_ONLY_MODE) {
      void refreshChatOnlySetupChecklist();
      return;
    }
    SwiftSyncSupport.renderSetupChecklist(mobileSetupHost, {
      obsWs: true,
      obsConnected: obsConnected,
      relayOnline: client.connected,
      cloud: isCloudRelayHttp(relayUrlInput.value.trim()),
      pairingReady: client.connected
    });
  }

  async function refreshChatOnlySetupChecklist() {
    if (typeof SwiftSyncSupport === 'undefined' || !mobileSetupHost) return;
    let chatSignedIn = false;
    const code = pairingCodeInput.value.trim().toUpperCase();
    const base = httpBaseFromPage();
    if (code && base) {
      try {
        const st = await fetch(
          `${base}/api/chat-config/status?code=${encodeURIComponent(code)}`,
          { cache: 'no-store' }
        );
        if (st.ok) {
          const data = await st.json();
          chatSignedIn = !!data.ready;
        }
      } catch (_) {}
    }
    const inApp = SwiftSyncSupport.detectInAppBrowser?.().inApp;
    SwiftSyncSupport.renderChatOnlySetupChecklist(mobileSetupHost, {
      inAppBrowser: !!inApp,
      chatSignedIn,
      chatActive: chatConnected && client.connected
    });
  }

  function setupInAppBrowserBanner() {
    if (typeof SwiftSyncSupport === 'undefined') return;
    const banner = document.getElementById('in-app-browser-banner');
    const copyBtn = document.getElementById('in-app-copy-link-btn');
    const openLink = document.getElementById('in-app-open-external');
    if (!banner) return;
    const detected = SwiftSyncSupport.detectInAppBrowser();
    if (!detected?.inApp) return;
    banner.hidden = false;
    document.body.classList.add('in-app-browser-active');
    const pageUrl = location.href;
    if (openLink) {
      openLink.href = pageUrl;
      openLink.target = '_blank';
      openLink.rel = 'noopener noreferrer';
    }
    copyBtn?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pageUrl);
        setStatus('Link copied — paste in Safari or Chrome.', false);
      } catch {
        setStatus('Copy failed — long-press the address bar and copy manually.', true);
      }
    });
  }

  function setupPullToRefresh() {
    const shell = document.getElementById('main-shell');
    if (!shell || !('ontouchstart' in window)) return;
    let startY = 0;
    let pulling = false;
    shell.addEventListener(
      'touchstart',
      (e) => {
        if (window.scrollY > 8) return;
        if (activeTab !== 'chat' && !CHAT_ONLY_MODE) return;
        startY = e.touches[0].clientY;
        pulling = true;
      },
      { passive: true }
    );
    shell.addEventListener(
      'touchmove',
      (e) => {
        if (!pulling) return;
        const dy = e.touches[0].clientY - startY;
        if (dy > 70 && window.scrollY <= 8) {
          pulling = false;
          if (client.connected) {
            setStatus('Refreshing…', false);
            if (CHAT_ONLY_MODE && chatConnected) {
              pollChat();
              sendCommand('connectChat').catch(() => {});
            } else {
              client.ping();
              client.getState();
            }
          } else {
            location.reload();
          }
        }
      },
      { passive: true }
    );
    shell.addEventListener('touchend', () => {
      pulling = false;
    });
  }

  function updateMobileRelayHealth(msg, { ok = false } = {}) {
    if (!mobileRelayHealth || !mobileRelayHealthText) return;
    mobileRelayHealthText.textContent = msg;
    mobileRelayHealth.classList.toggle('ok', ok);
    mobileRelayHealth.hidden = ok && !msg;
  }

  function updateChatPill() {
    if (!pillChat) return;
    const count = chatPlatforms.length || (chatConnected ? 1 : 0);
    setPill(
      pillChat,
      chatConnected,
      chatConnected ? `Chat: ${count} live` : 'Chat: offline'
    );
  }

  function scrollChatToBottom() {
    if (!chatMessagesEl) return;
    requestAnimationFrame(() => {
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    });
  }

  function appendChatRow(parent, msg) {
    const authorOf = (m) =>
      typeof SwiftSyncSupport !== 'undefined' && SwiftSyncSupport.formatChatAuthor
        ? SwiftSyncSupport.formatChatAuthor(m)
        : m.author || m.displayName || m.username || 'unknown';
    const isJoin =
      msg.kind === 'join' ||
      (typeof SwiftSyncSupport !== 'undefined' && SwiftSyncSupport.isJoinChatMessage?.(msg));
    const row = document.createElement('div');
    row.className = 'chat-msg' + (isJoin ? ' chat-msg-join' : '');
    if (msg.platform) {
      const badge = document.createElement('span');
      badge.className = `chat-platform-badge ${msg.platform}`;
      badge.textContent = CHAT_PLATFORM_LABELS[msg.platform] || msg.platform;
      row.appendChild(badge);
    }
    if (isJoin) {
      const text = document.createElement('span');
      text.className = 'chat-msg-text chat-msg-join-text';
      text.textContent = msg.text || `${authorOf(msg)} joined`;
      row.appendChild(text);
    } else {
      const author = document.createElement('span');
      author.className = 'chat-msg-author';
      author.textContent = `${authorOf(msg)}: `;
      if (msg.color) author.style.color = msg.color;
      const text = document.createElement('span');
      text.className = 'chat-msg-text';
      text.textContent = msg.text || '';
      row.append(author, text);
    }
    parent.appendChild(row);
  }

  function renderChatMessages(messages) {
    if (messages) chatMessages = Array.isArray(messages) ? messages.slice() : chatMessages;
    if (!chatMessagesEl) return;
    chatMessagesEl.innerHTML = '';

    const visible = filteredChatMessages();
    if (!visible.length) {
      if (chatEmpty) chatEmpty.style.display = 'block';
      if (chatChannelLabel) chatChannelLabel.textContent = formatChatLabel();
      updateChatPill();
      updateChatSendPlatformSelect();
      return;
    }
    if (chatEmpty) chatEmpty.style.display = 'none';

    visible.forEach((msg) => appendChatRow(chatMessagesEl, msg));

    if (chatChannelLabel) chatChannelLabel.textContent = formatChatLabel();
    if (chatSendInput) chatSendInput.disabled = !chatCanSend;
    if (chatSendBtn) chatSendBtn.disabled = !chatCanSend;
    updateChatSendPlatformSelect();
    updateChatPill();
    scrollChatToBottom();
    syncFloatChatPip();
  }

  function renderFloatChatMessagesInto(el) {
    if (!el) return;
    el.innerHTML = '';
    filteredChatMessages()
      .slice(-80)
      .forEach((msg) => appendChatRow(el, msg));
    el.scrollTop = el.scrollHeight;
  }

  function syncFloatChatPip() {
    const pipWin = documentPictureInPicture?.window;
    if (!pipWin || pipWin.closed) return;
    renderFloatChatMessagesInto(floatChatMessagesEl);
  }

  function showFloatChatHint(text) {
    if (!chatFloatHint) return;
    chatFloatHint.hidden = false;
    chatFloatHint.textContent = text;
  }

  async function openFloatingChat() {
    const pipApi = window.documentPictureInPicture;
    if (pipApi?.window && !pipApi.window.closed) {
      pipApi.window.focus();
      return;
    }
    if (!supportsDocumentPiP) {
      if (isIOS) {
        showFloatChatHint(
          'iPhone does not allow chat to float over other apps like YouTube. Use Split View (swipe up → hold SwiftSync icon) or keep SwiftSync open while you use other apps.'
        );
      } else {
        showFloatChatHint(
          'Floating chat needs Chrome on Android 116+. You can also add SwiftSync to your home screen and use split-screen.'
        );
      }
      return;
    }
    try {
      const pipWindow = await pipApi.requestWindow({
        width: Math.min(360, window.innerWidth),
        height: Math.min(480, Math.round(window.innerHeight * 0.55))
      });
      pipWindow.document.body.style.margin = '0';
      pipWindow.document.body.style.background = '#0a0a0a';
      pipWindow.document.body.style.color = '#eee';
      pipWindow.document.body.style.fontFamily = 'system-ui, sans-serif';
      pipWindow.document.body.innerHTML = `
        <style>
          .pip-head { padding: 8px 10px; border-bottom: 1px solid #222; font-size: 12px; font-weight: 700; }
          .pip-messages { height: calc(100vh - 36px); overflow-y: auto; padding: 8px; box-sizing: border-box; }
          .chat-msg { margin-bottom: 6px; font-size: 12px; line-height: 1.35; }
          .chat-platform-badge { font-size: 9px; margin-right: 6px; padding: 1px 5px; border-radius: 4px; }
          .chat-platform-badge.twitch { background: #9146ff; }
          .chat-platform-badge.kick { background: #53fc18; color: #000; }
          .chat-platform-badge.youtube { background: #f00; }
          .chat-msg-author { font-weight: 700; color: #7eb8ff; }
        </style>
        <div class="pip-head">SwiftSync Chat</div>
        <div class="pip-messages" id="pip-messages"></div>
      `;
      floatChatMessagesEl = pipWindow.document.getElementById('pip-messages');
      renderFloatChatMessagesInto(floatChatMessagesEl);
      if (chatFloatHint) chatFloatHint.hidden = true;
      if (chatFloatBtn) chatFloatBtn.textContent = 'Float chat (open)';
      pipWindow.addEventListener('pagehide', () => {
        floatChatMessagesEl = null;
        if (chatFloatBtn) chatFloatBtn.textContent = 'Float chat window';
      });
    } catch (err) {
      showFloatChatHint(err.message || 'Could not open floating window');
    }
  }

  function applyChatSnapshot(data) {
    if (!data || typeof data !== 'object') return;
    if (data.channel != null) chatChannel = String(data.channel || '');
    if (data.connected != null) chatConnected = !!data.connected;
    if (data.canSend != null) chatCanSend = !!data.canSend;
    if (data.statuses && typeof data.statuses === 'object') chatStatuses = data.statuses;
    if (Array.isArray(data.platforms)) chatPlatforms = data.platforms.slice();
    if (Array.isArray(data.messages)) renderChatMessages(data.messages);
    else {
      renderChatMessages();
      updateChatPill();
    }
  }

  async function pollChat() {
    const httpBase = httpBaseFromRelay(relayUrlInput.value.trim());
    if (!httpBase) return;
    try {
      const res = await fetch(`${httpBase}/api/chat${apiCodeQuery()}`, {
        cache: 'no-store',
        headers: apiHeaders()
      });
      if (!res.ok) return;
      const data = await res.json();
      applyChatSnapshot(data);
    } catch (_) {}
  }

  async function sendChatMessage() {
    const text = String(chatSendInput?.value || '').trim();
    if (!text) return;
    const platform = chatSendPlatform?.value || chatPlatforms[0] || 'twitch';
    const ok = await sendCommand('sendChat', { text, message: text, platform });
    if (ok && chatSendInput) chatSendInput.value = '';
  }

  async function sendCommand(cmd, extra = {}) {
    if (!client.connected) {
      setStatus('Not connected — tap Connect on Home.', true);
      return false;
    }

    const httpBase = httpBaseFromRelay(relayUrlInput.value.trim());
    const useCloudHttp = httpBase && isCloudRelayHttp(httpBase);
    let delivered = false;

    if (useCloudHttp && pairingCodeInput.value.trim()) {
      try {
        const result = await postMobileCommand(cmd, extra);
        if (result.ok) {
          delivered = true;
        } else {
          const msg =
            result.body?.message ||
            (result.status === 503
              ? 'PC not linked — open SwiftSync on your streaming PC.'
              : 'Command failed.');
          setStatus(msg, true);
          return false;
        }
      } catch (_) {}
    }

    if (!delivered) {
      const errWait = awaitCommandError();
      if (!client.command(cmd, extra)) {
        setStatus('Command failed — tap Connect on Home.', true);
        return false;
      }
      const errMsg = await errWait;
      if (errMsg) {
        setStatus(errMsg, true);
        return false;
      }
    }

    if (cmd === 'setScene' && extra.sceneName) {
      currentScene = extra.sceneName;
      setTimeout(pollSceneSources, 400);
    }
    if (['toggleStream', 'toggleRecord', 'toggleReplay', 'toggleVirtualCam', 'toggleStudioMode', 'pauseRecord', 'saveReplay'].includes(cmd)) {
      setTimeout(() => client.getState(), 400);
    }
    if (['setSourceEnabled', 'getSceneSources', 'getScenes', 'getState'].includes(cmd)) {
      setTimeout(pollSceneSources, 400);
    }
    if (['setVolume', 'toggleMute', 'setMute', 'getAudio'].includes(cmd)) {
      setTimeout(pollGlobalAudio, 400);
    }
    if (cmd === 'sendChat') {
      setTimeout(pollChat, 400);
    }
    if (cmd === 'getChat') {
      setTimeout(pollChat, 400);
    }

    return true;
  }

  function createVisualSourceRow(src) {
    const row = document.createElement('div');
    row.className = 'source-row visual' + (src.enabled !== false ? '' : ' off');

    const name = document.createElement('span');
    name.className = 'source-row-name';
    name.title = src.sourceName;
    name.textContent = src.sourceName;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'src-btn' + (src.enabled !== false ? '' : ' active-off');
    btn.textContent = src.enabled !== false ? 'Hide' : 'Show';
    btn.addEventListener('click', () => {
      sendCommand('setSourceEnabled', {
        sceneName: src.sceneName,
        sceneUuid: src.sceneUuid,
        sceneItemId: src.sceneItemId,
        canvasUuid: src.canvasUuid,
        enabled: !(src.enabled !== false)
      });
    });

    row.append(name, btn);
    return row;
  }

  function createAudioSourceRow(src) {
    const obsInputName = src.inputName || src.sourceName;
    const label = src.displayName || src.sourceName || obsInputName;

    const card = document.createElement('div');
    card.className = 'audio-card' + (src.muted ? ' muted' : '');
    card.dataset.inputName = obsInputName;

    const header = document.createElement('div');
    header.className = 'audio-card-header';

    const name = document.createElement('span');
    name.className = 'source-row-name';
    name.title = label;
    name.textContent = label;

    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'src-btn mute' + (src.muted ? ' muted' : '');
    muteBtn.textContent = src.muted ? 'Unmute' : 'Mute';
    muteBtn.dataset.role = 'mute';
    muteBtn.addEventListener('click', () => {
      sendCommand('toggleMute', { inputName: obsInputName, name: obsInputName });
    });

    header.append(name, muteBtn);

    const sliderRow = document.createElement('div');
    sliderRow.className = 'audio-slider-row';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'audio-slider-large';
    slider.dataset.role = 'volume';
    slider.min = '0';
    slider.max = '100';
    slider.value = String(Math.round((src.volumeMul ?? 1) * 100));

    const volLabel = document.createElement('span');
    volLabel.className = 'src-vol-label';
    volLabel.dataset.role = 'volume-label';
    volLabel.textContent = `${slider.value}%`;

    let debounce;
    let userIsDragging = false;
    slider.addEventListener('pointerdown', () => { userIsDragging = true; });
    slider.addEventListener('pointerup', () => { userIsDragging = false; });
    slider.addEventListener('input', () => {
      volLabel.textContent = `${slider.value}%`;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        sendCommand('setVolume', {
          inputName: obsInputName,
          name: obsInputName,
          volumeMul: Number(slider.value) / 100
        });
      }, 120);
    });
    slider.dataset.userDragging = 'false';
    Object.defineProperty(slider, '_userDragging', {
      get: () => userIsDragging
    });

    sliderRow.append(slider, volLabel);
    card.append(header, sliderRow);
    return card;
  }

  function patchAudioVolume(inputName, volumeMul) {
    if (!inputName || volumeMul == null || !globalAudioList) return;
    const card = globalAudioList.querySelector(
      `.audio-card[data-input-name="${cssEscape(inputName)}"]`
    );
    if (!card) return;
    const slider = card.querySelector('input[data-role="volume"]');
    const volLabel = card.querySelector('[data-role="volume-label"]');
    if (!slider || slider._userDragging) return;
    const pct = Math.max(0, Math.min(100, Math.round(volumeMul * 100)));
    slider.value = String(pct);
    if (volLabel) volLabel.textContent = `${pct}%`;
  }

  function patchAudioMute(inputName, muted) {
    if (!inputName || !globalAudioList) return;
    const card = globalAudioList.querySelector(
      `.audio-card[data-input-name="${cssEscape(inputName)}"]`
    );
    if (!card) return;
    card.classList.toggle('muted', !!muted);
    const muteBtn = card.querySelector('button[data-role="mute"]');
    if (muteBtn) {
      muteBtn.classList.toggle('muted', !!muted);
      muteBtn.textContent = muted ? 'Unmute' : 'Mute';
    }
  }

  function cssEscape(s) {
    return String(s).replace(/(["\\])/g, '\\$1');
  }

  function appendVisualSourceList(container, items) {
    container.innerHTML = '';
    if (!items?.length) {
      const empty = document.createElement('span');
      empty.className = 'source-chip-empty';
      empty.textContent = 'No visual sources';
      container.appendChild(empty);
      return;
    }
    items.forEach((src) => container.appendChild(createVisualSourceRow(src)));
  }

  function renderGlobalAudio(inputs) {
    if (!globalAudioList) return;
    globalAudioList.innerHTML = '';
    if (!inputs?.length) {
      if (audioEmpty) audioEmpty.style.display = 'block';
      return;
    }
    if (audioEmpty) audioEmpty.style.display = 'none';
    inputs.forEach((src) => {
      globalAudioList.appendChild(
        createAudioSourceRow({
          sourceName: src.displayName || src.inputName || src.name,
          inputName: src.inputName || src.name,
          displayName: src.displayName || src.inputName || src.name,
          volumeMul: src.volumeMul ?? 1,
          muted: !!src.muted
        })
      );
    });
  }

  function renderSceneSources(panels) {
    const visualTarget = sceneVisualList;
    if (!visualTarget) return;

    const mainPanel = panels?.find((p) => p.side === 'main') || panels?.[0];
    const verticalPanel = panels?.find((p) => p.side === 'vertical');

    if (!mainPanel) {
      if (linkedScenesHeader) linkedScenesHeader.textContent = 'Sources';
      visualTarget.innerHTML = '';
      if (sceneSourcesEmpty) sceneSourcesEmpty.style.display = 'none';
      return;
    }

    if (linkedScenesHeader) {
      linkedScenesHeader.textContent = verticalPanel
        ? `Sources — ${mainPanel.sceneName || '—'} + ${verticalPanel.sceneName || '—'}`
        : `Sources — ${mainPanel.sceneName || '—'}`;
    }

    visualTarget.innerHTML = '';

    appendPanelGroup(visualTarget, mainPanel, 'Main');
    if (verticalPanel) {
      appendPanelGroup(visualTarget, verticalPanel, verticalPanel.canvasName || 'Vertical');
    }

    const totalSources =
      (mainPanel.visual?.length || 0) + (verticalPanel?.visual?.length || 0);
    if (sceneSourcesEmpty) sceneSourcesEmpty.style.display = totalSources === 0 ? 'block' : 'none';
  }

  function appendPanelGroup(container, panel, label) {
    const group = document.createElement('div');
    group.className = 'mobile-source-group';
    group.dataset.side = panel.side;

    const header = document.createElement('p');
    header.className = 'mobile-source-group-label';
    header.textContent = `${label} — ${panel.sceneName || '—'}`;
    group.appendChild(header);

    const list = document.createElement('div');
    list.className = 'source-rows scene-source-rows';
    appendVisualSourceList(list, panel.visual);
    group.appendChild(list);

    container.appendChild(group);
  }

  function createSceneCard(mainName, scenes, active) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'tab-card scene-card main-pane' + (active ? ' active' : '');
    card.innerHTML = `<span class="scene-card-label">Scene</span><span class="scene-card-switch-hint">Tap to switch OBS</span><span class="scene-card-name">${escapeHtml(mainName)}</span>`;
    card.addEventListener('click', async () => {
      const ok = await sendCommand('setScene', { sceneName: mainName });
      if (ok) {
        currentScene = mainName;
        renderScenes(scenes);
      }
    });
    return card;
  }

  function renderScenes(scenes) {
    sceneList.innerHTML = '';
    sceneList.className = 'scene-grid-mobile';

    const names = sceneLinks.length
      ? sceneLinks.map((link) => (typeof link.main === 'string' ? link.main : link.main?.sceneName))
      : scenes || [];

    if (!names.length) {
      sceneList.innerHTML = '<p class="empty-hint">No scenes from PC yet.</p>';
      return;
    }

    names.forEach((mainName) => {
      if (!mainName) return;
      sceneList.appendChild(createSceneCard(mainName, scenes, mainName === currentScene));
    });
  }

  function updateTools(tools) {
    if (!tools) return;
    setToolState(stateEls.stream, tools.stream, 'live', 'Live', 'Off');
    setToolState(stateEls.record, tools.record, 'on', 'Recording', 'Off');
    setToolState(stateEls.replay, tools.replay, 'on', 'On', 'Off');
    setToolState(stateEls.vcam, tools.vcam, 'on', 'On', 'Off');
    setToolState(stateEls.studio, tools.studio, 'on', 'On', 'Off');
  }

  function setToolState(el, active, cls, onLabel, offLabel) {
    if (!el) return;
    el.textContent = active ? onLabel : offLabel;
    el.classList.toggle('live', cls === 'live' && active);
    el.classList.toggle('on', cls === 'on' && active);
  }

  function applyObsState(data, opts = {}) {
    const hasSceneData = !!(data.scenes?.length || data.sceneLinks?.length);
    const explicitlyOffline =
      data.type === 'obsDisconnected' ||
      (data.type === 'obsState' && data.obsConnected === false && data.obsOnline === false && !hasSceneData);
    const explicitlyOnline =
      data.type === 'obsConnected' ||
      (data.type === 'obsState' && (data.obsOnline === true || data.obsConnected === true)) ||
      hasSceneData;

    if (explicitlyOffline && !opts.fromHttp) {
      setObsOnline(false, data.message);
      return;
    }

    if (explicitlyOnline) setObsOnline(true);

    if (data.currentScene) currentScene = data.currentScene;
    if (data.sceneLinks) {
      sceneLinks = data.sceneLinks.map((link) => ({
        main: typeof link.main === 'string' ? link.main : link.main?.sceneName,
        vertical: link.vertical ? (typeof link.vertical === 'string' ? link.vertical : link.vertical?.sceneName) : null
      }));
    }
    if (data.dualCanvasMode != null) dualCanvasMode = !!data.dualCanvasMode;
    if (data.canvasHint) canvasHint.textContent = data.canvasHint;
    else if (dualCanvasMode && currentScene) {
      canvasHint.textContent = `Main + vertical linked · active: ${currentScene}`;
    }
    if (data.scenes || data.sceneLinks) renderScenes(data.scenes);
    if (data.audio?.length) renderGlobalAudio(data.audio);
    if (data.tools) updateTools(data.tools);
    else if (data.streamActive != null || data.recordActive != null) {
      updateTools({ stream: data.streamActive, record: data.recordActive });
    }
    if (currentScene) {
      pollSceneSources();
      pollGlobalAudio();
    }
  }

  function handleMessage(data) {
    switch (data.type) {
      case 'paired':
        rememberFlyInstance(data.flyInstanceId);
        setConnectedHomeUi(true);
        if (data.cloudChat) {
          setPill(pillRelay, true, 'Relay: cloud chat');
        }
        if (data.setupRequired) {
          setStatus('Sign in below, then tap Connect again — or we will connect chat automatically.', false);
          refreshMobileOAuthUi();
        }
        if (data.pcLinked === false && !data.chatOnly && !data.cloudChat) {
          setStatus('Paired to relay but PC app is not linked — open SwiftSync on your PC.', true);
        }
        break;
      case 'obsConnected':
      case 'obsState':
        applyObsState(data);
        break;
      case 'obsDisconnected':
        applyObsState(data);
        break;
      case 'pong':
        if (data.obsConnected) {
          setObsOnline(true);
          client.getState();
        }
        break;
      case 'scenes':
        if (data.scenes?.length || data.sceneLinks?.length) setObsOnline(true);
        else if (data.obsConnected === false) setObsOnline(false);
        if (data.current) currentScene = data.current;
        if (data.sceneLinks) {
          sceneLinks = data.sceneLinks.map((link) => ({
            main: link.main,
            vertical: link.vertical || null
          }));
        }
        if (data.dualCanvasMode != null) dualCanvasMode = !!data.dualCanvasMode;
        renderScenes(data.scenes);
        break;
      case 'sceneSources':
        renderSceneSources(data.panels);
        break;
      case 'audio':
        renderGlobalAudio(data.inputs);
        break;
      case 'chat':
      case 'chatBatch':
        applyChatSnapshot(data);
        break;
      case 'chatMessage':
        if (data.message) {
          chatMessages.push(data.message);
          while (chatMessages.length > 300) chatMessages.shift();
          renderChatMessages(chatMessages);
        }
        break;
      case 'chatStatus':
        if (data.channel != null) chatChannel = String(data.channel || '');
        if (data.connected != null) chatConnected = !!data.connected;
        if (data.canSend != null) chatCanSend = !!data.canSend;
        if (data.statuses && typeof data.statuses === 'object') chatStatuses = data.statuses;
        if (Array.isArray(data.platforms)) chatPlatforms = data.platforms.slice();
        updateChatPill();
        if (chatChannelLabel) chatChannelLabel.textContent = formatChatLabel();
        if (chatSendInput) chatSendInput.disabled = !chatCanSend;
        if (chatSendBtn) chatSendBtn.disabled = !chatCanSend;
        updateChatSendPlatformSelect();
        break;
      case 'error':
        lastRelayError = data.message || 'Command failed';
        resolveCommandError(lastRelayError);
        setStatus(lastRelayError, true);
        break;
      case 'sceneChanged':
        currentScene = data.sceneName || currentScene;
        renderScenes(sceneLinks.map((l) => l.main).filter(Boolean));
        pollSceneSources();
        break;
      case 'canvasPreview':
        if (mobilePreviewEnabled) applyCanvasPreview(data.image);
        break;
      case 'previewToggle':
        mobilePreviewEnabled = !!data.enabled;
        updatePreviewToggleBtn();
        if (!mobilePreviewEnabled) applyCanvasPreview(null);
        break;
      case 'streamState':
        if (stateEls.stream) setToolState(stateEls.stream, data.active, 'live', 'Live', 'Off');
        break;
      case 'recordState':
        if (stateEls.record) setToolState(stateEls.record, data.active, 'on', 'Recording', 'Off');
        break;
      case 'volumeChanged':
        if (data.volumeMul != null) {
          patchAudioVolume(data.inputName, data.volumeMul);
        } else if (data.volumeDb != null) {
          patchAudioVolume(data.inputName, dbToMul(data.volumeDb));
        }
        break;
      case 'muteChanged':
        patchAudioMute(data.inputName, data.muted);
        break;
      default:
        break;
    }
  }

  client.onMessage(handleMessage);

  async function connect() {
    const relay = relayUrlInput.value.trim();
    const code = pairingCodeInput.value.trim().toUpperCase();
    if (!relay || !code) {
      setStatus('Enter relay URL and pairing code.', true);
      return;
    }

    pairBtn.disabled = true;
    setStatus('Connecting…');

    try {
      await client.connect(relay, {
        pairingCode: code,
        autoReconnect: true,
        reconnectMs: 5000,
        chatOnly: CHAT_ONLY_MODE
      });
      saveSession(true);
      setPill(pillRelay, true, 'Relay: connected');
      updateMobileRelayHealth('Connected to relay.', { ok: true });
      refreshMobileSetupChecklist();
      setConnectedHomeUi(true);

      if (CHAT_ONLY_MODE) {
        setPill(pillObs, false, 'OBS: n/a');
        setPill(pillChat, false, 'Chat: connecting…');
        const chatOk = await sendCommand('connectChat');
        if (!chatOk) {
          setStatus('Sign in to a platform below, then tap Connect again.', false);
          refreshMobileOAuthUi();
          switchTab('connect');
          pairBtn.disabled = false;
          return;
        }
        startCloudChatHeartbeat();
        pollChat();
        switchTab('chat');
        setStatus('Cloud chat active while this app is open — PC not required.');
        pairBtn.disabled = false;
        return;
      }

      const linkStatus = await fetchRelayStatus();
      if (linkStatus && !linkStatus.pcLinked) {
        setPill(pillRelay, false, 'Relay: no PC');
        setStatus(
          'Phone reached the relay but your PC is not connected — open SwiftSync on your streaming PC, confirm Cloud relay: online, then tap Connect again.',
          true
        );
        pairBtn.disabled = false;
        return;
      }
      setStatus('Paired with PC. Scan below to add another phone, or open Scenes / Audio / Tools.');
      switchTab('connect');
      client.ping();
      client.getState();
      client.command('getScenes');
      startObsSyncPoll();
      startHttpObsSyncPoll();
      startPcLinkCheck();
      checkRelayHealth();
      setTimeout(pollSceneSources, 600);
      setTimeout(pollGlobalAudio, 600);
      setTimeout(pollChat, 600);
      sendCommand('getChat');
    } catch (err) {
      setPill(pillRelay, false, 'Relay: offline');
      setStatus(err.message || 'Connection failed', true);
      pairBtn.disabled = false;
    }
  }

  function disconnect() {
    stopObsSyncPoll();
    stopHttpObsSyncPoll();
    stopPcLinkCheck();
    stopCloudChatHeartbeat();
    if (CHAT_ONLY_MODE && client.connected) {
      client.send({ from: 'mobile', command: 'stopChat' });
    }
    flyInstanceId = '';
    client.disconnect();
    setObsOnline(false);
    setPill(pillRelay, false, 'Relay: offline');
    updateMobileRelayHealth('Disconnected — tap Connect or Retry.');
    refreshMobileSetupChecklist();
    setConnectedHomeUi(false);
    setStatus('Disconnected');
    switchTab('connect');
  }

  pairBtn.addEventListener('click', connect);
  disconnectBtn.addEventListener('click', disconnect);

  mobileInviteShareBtn?.addEventListener('click', async () => {
    const url = lastInviteUrl || buildMobileInviteUrl();
    if (!url) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'SwiftSync', text: 'Join my stream control', url });
        setStatus('Invite shared.');
        return;
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setStatus('Invite link copied.');
    } catch (_) {
      setStatus(url);
    }
  });

  mobileRelayRetryBtn?.addEventListener('click', () => connect());

  mobileInviteCopyBtn?.addEventListener('click', async () => {
    const url = lastInviteUrl || buildMobileInviteUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setStatus('Invite link copied — send or AirDrop to another phone.');
    } catch (_) {
      setStatus(url);
    }
  });

  pairingCodeInput.addEventListener('input', () => {
    saveSession(false);
    updateRememberHint();
  });
  relayUrlInput.addEventListener('input', () => {
    saveSession(false);
    updateRememberHint();
  });
  pairingCodeInput.addEventListener('change', () => {
    saveSession(false);
    updateRememberHint();
  });
  relayUrlInput.addEventListener('change', () => {
    saveSession(false);
    updateRememberHint();
  });

  document.getElementById('mobile-chat-mods-only')?.addEventListener('change', (e) => {
    chatModsOnly = !!e.target.checked;
    renderChatMessages(chatMessages);
  });
  document.getElementById('mobile-chat-dedupe')?.addEventListener('change', (e) => {
    chatDedupe = !!e.target.checked;
    renderChatMessages(chatMessages);
  });

  const MACRO_SCENES = { starting: 'Starting Soon', brb: 'BRB', live: 'Live' };
  document.querySelectorAll('[data-macro]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.macro;
      const name = MACRO_SCENES[key] || key;
      await sendCommand('setScene', { sceneName: name });
    });
  });

  function classifyAudioGroup(name) {
    const n = String(name || '').toLowerCase();
    if (/mic|voice|podcast|input/i.test(n)) return 'mic';
    if (/game|desktop|display|chrome|obs/i.test(n)) return 'game';
    if (/music|spotify|browser/i.test(n)) return 'music';
    return 'other';
  }

  document.querySelectorAll('[data-audio-group]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const group = btn.dataset.audioGroup;
      if (!globalAudioList) return;
      const cards = [...globalAudioList.querySelectorAll('.audio-card')];
      for (const card of cards) {
        const inputName = card.dataset.inputName;
        if (!inputName) continue;
        const g = classifyAudioGroup(inputName);
        const mute = group !== 'all' && g === group;
        if (group === 'all' || g === group) {
          await sendCommand('setMute', { inputName, muted: group === 'all' ? false : mute });
        }
      }
      setTimeout(pollGlobalAudio, 500);
    });
  });

  window.addEventListener('online', () => {
    if (!client.connected && pairingCodeInput.value.trim() && relayUrlInput.value.trim()) {
      connect();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'visible' &&
      !client.connected &&
      pairingCodeInput.value.trim() &&
      relayUrlInput.value.trim()
    ) {
      connect();
    }
    if (document.visibilityState === 'visible' && client.connected) {
      client.ping();
      pollChat();
    }
  });

  window.addEventListener('pagehide', () => {
    if (CHAT_ONLY_MODE && client.connected) {
      client.send({ from: 'mobile', command: 'stopChat' });
    }
    saveSession(wasPairedBefore() || client.connected);
  });

  document.getElementById('refresh-scenes-btn').addEventListener('click', async () => {
    await sendCommand('getScenes');
    await sendCommand('getState');
    pollSceneSources();
  });
  document.getElementById('refresh-audio-btn').addEventListener('click', async () => {
    await sendCommand('getAudio');
    pollGlobalAudio();
  });
  document.getElementById('refresh-tools-btn').addEventListener('click', () => sendCommand('getState'));
  document.getElementById('refresh-chat-btn')?.addEventListener('click', async () => {
    const ok = await sendCommand('connectChat');
    if (ok) await sendCommand('getChat');
  });

  if (isIOS && chatFloatHint) {
    showFloatChatHint(
      'Tip: On iPhone, use Split View to keep chat visible while using other apps — true floating-over-apps is only for video on iOS.'
    );
  } else if (!supportsDocumentPiP && chatFloatHint) {
    chatFloatHint.hidden = true;
  }

  chatFloatBtn?.addEventListener('click', () => openFloatingChat());

  chatSendBtn?.addEventListener('click', () => sendChatMessage());
  chatSendInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendChatMessage();
    }
  });

  chatFilterChips?.querySelectorAll('.chat-filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      chatFilter = chip.dataset.filter || 'all';
      chatFilterChips.querySelectorAll('.chat-filter-chip').forEach((c) => {
        c.classList.toggle('active', c === chip);
      });
      renderChatMessages();
    });
  });

  document.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', () => sendCommand(btn.dataset.cmd));
  });

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function dbToMul(db) {
    if (db == null) return 1;
    if (db <= -100) return 0;
    return Math.pow(10, db / 20);
  }

  function applyCanvasPreview(dataUrl) {
    const wrap = document.getElementById('canvas-preview');
    const img = document.getElementById('canvas-preview-img');
    if (!wrap || !img) return;
    if (dataUrl && typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
      img.src = dataUrl;
      wrap.classList.add('has-image');
    } else {
      img.removeAttribute('src');
      wrap.classList.remove('has-image');
    }
  }

  function updatePreviewToggleBtn() {
    const btn = document.getElementById('preview-toggle-btn');
    if (btn) btn.textContent = mobilePreviewEnabled ? 'Preview: On' : 'Preview: Off';
  }

  const mobilePreviewBtn = document.getElementById('preview-toggle-btn');
  if (mobilePreviewBtn) {
    mobilePreviewBtn.addEventListener('click', () => {
      mobilePreviewEnabled = !mobilePreviewEnabled;
      updatePreviewToggleBtn();
      if (!mobilePreviewEnabled) applyCanvasPreview(null);
      sendCommand('togglePreview', { enabled: mobilePreviewEnabled });
    });
  }

  function setupHomescreenIconHint() {
    const box = document.getElementById('homescreen-icon-hint');
    const img = document.getElementById('homescreen-icon-preview');
    const text = document.getElementById('homescreen-icon-text');
    if (!box || !img || !text) return;

    const iconUrl = `${location.origin}/mobile/apple-touch-icon.png`;
    const onCloudHost = isCloudHostedPage();

    const show = (message, ok) => {
      box.hidden = false;
      text.textContent = message;
      box.classList.toggle('icon-ok', !!ok);
      box.classList.toggle('icon-bad', !ok);
    };

    img.onload = () => {
      if (onCloudHost) {
        show(
          'Logo loaded. Remove any old home screen shortcut, then Add to Home Screen from this page (Safari Share menu).',
          true
        );
      } else {
        show(
          'For the logo on your home screen: delete the old SwiftSync shortcut, open this page from the PC QR (http://…:4000/mobile/), then Add to Home Screen.',
          true
        );
      }
    };
    img.onerror = () => {
      if (onCloudHost) {
        show(
          'Home screen logo is not available on this cloud URL yet. On Wi‑Fi, scan the LAN QR on your PC (http://192.168.x.x:4000/mobile/) instead.',
          false
        );
      } else {
        show(
          'Could not load the app icon from this server. Restart SwiftSync on the PC (npm start), then reload this page.',
          false
        );
      }
    };
    img.src = iconUrl;
  }

  applyQueryParams();
  applyChatOnlyMode();
  setupInAppBrowserBanner();
  handleOAuthReturn();
  setupHomescreenIconHint();
  setupPullToRefresh();

  syncCarouselLayout();
  window.addEventListener('resize', syncCarouselLayout);
  requestAnimationFrame(() => {
    syncCarouselLayout();
    requestAnimationFrame(syncCarouselLayout);
  });

  if (pairingCodeInput.value && relayUrlInput.value) {
    setStatus(wasPairedBefore() ? 'Reconnecting…' : 'Connecting…');
    setTimeout(() => connect(), 300);
  } else {
    updateRememberHint();
  }
})();

(function () {
  const statusEl = document.getElementById('dock-status');
  const helpEl = document.getElementById('dock-help');
  const messagesEl = document.getElementById('dock-messages');
  const platformSelect = document.getElementById('dock-send-platform');
  const sendInput = document.getElementById('dock-send-input');
  const sendBtn = document.getElementById('dock-send-btn');

  const params = new URLSearchParams(location.search);
  const port = params.get('port') || location.port || '4000';
  if (params.get('compact') === '1') document.body.classList.add('dock-compact');

  document.querySelectorAll('.dock-toolbar button[data-font]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.body.classList.remove('dock-compact', 'dock-large');
      const mode = btn.dataset.font;
      if (mode === 'compact') document.body.classList.add('dock-compact');
      if (mode === 'large') document.body.classList.add('dock-large');
      document.querySelectorAll('.dock-toolbar button[data-font]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
    });
  });

  const wsUrl = `ws://${location.hostname || '127.0.0.1'}:${port}`;
  const httpBase = `http://${location.hostname || '127.0.0.1'}:${port}`;

  let ws = null;
  let messages = [];
  let canSend = false;
  let sendPlatforms = [];

  function authorOf(m) {
    if (!m || typeof m !== 'object') return 'unknown';
    if (typeof SwiftSyncSupport !== 'undefined' && SwiftSyncSupport.formatChatAuthor) {
      return SwiftSyncSupport.formatChatAuthor(m);
    }
    const user = m.user;
    if (user && typeof user === 'object') {
      const nested =
        user.username || user.displayName || user.display_name || user.name || user.slug;
      if (nested && String(nested).trim()) return String(nested).trim();
    }
    const name = m.author || m.displayName || m.username || m.user;
    const s = String(name || '').trim();
    return s || 'unknown';
  }

  function isJoin(m) {
    if (!m || typeof m !== 'object') return false;
    if (m.kind === 'join') return true;
    if (typeof SwiftSyncSupport !== 'undefined' && SwiftSyncSupport.isJoinChatMessage) {
      return SwiftSyncSupport.isJoinChatMessage(m);
    }
    const t = String(m.text || '');
    return (
      /\bjoined (the )?(chat|channel|stream|live)\b/i.test(t) ||
      /\bhas joined\b/i.test(t) ||
      /\bwelcome\b.*\bto the stream\b/i.test(t)
    );
  }

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'dock-status' + (cls ? ' ' + cls : '');
  }

  function showHelp(text) {
    if (!helpEl) return;
    if (!text) {
      helpEl.hidden = true;
      helpEl.textContent = '';
      return;
    }
    helpEl.hidden = false;
    helpEl.textContent = text;
  }

  function platformClass(p) {
    return String(p || '').toLowerCase();
  }

  function isMod(m) {
    if (m.isModerator || m.isMod || m.isBroadcaster) return true;
    const badges = m.badges || m.userBadges || [];
    return Array.isArray(badges) && badges.some((b) => /mod|moderator|broadcaster/i.test(String(b)));
  }

  function renderMessages() {
    if (!messagesEl) return;
    messagesEl.innerHTML = '';
    for (const m of messages.slice(-200)) {
      const row = document.createElement('div');
      const join = isJoin(m);
      row.className = 'chat-msg' + (isMod(m) ? ' mod' : '') + (join ? ' chat-msg-join' : '');

      const plat = document.createElement('span');
      plat.className = 'platform ' + platformClass(m.platform);
      plat.textContent = m.platform || '?';

      if (join) {
        const text = document.createElement('span');
        text.className = 'join-text';
        text.textContent = m.text || `${authorOf(m)} joined`;
        row.append(plat, text);
      } else {
        const user = document.createElement('span');
        user.className = 'user';
        user.textContent = authorOf(m) + ': ';
        const text = document.createElement('span');
        text.textContent = m.text || '';
        row.append(plat, user, text);
      }
      messagesEl.appendChild(row);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function deriveSendPlatforms(data) {
    if (Array.isArray(data.sendPlatforms) && data.sendPlatforms.length) {
      return data.sendPlatforms;
    }
    const statuses = data.statuses || {};
    const fromStatuses = Object.entries(statuses)
      .filter(([, s]) => s && s.connected && s.canSend)
      .map(([p]) => p);
    if (fromStatuses.length) return fromStatuses;
    return Array.isArray(data.platforms) ? data.platforms : [];
  }

  function applyChatPayload(data) {
    if (Array.isArray(data.messages)) messages = data.messages;
    canSend = !!data.canSend;
    sendPlatforms = deriveSendPlatforms(data);
    if (platformSelect) {
      platformSelect.innerHTML = '';
      const opts = sendPlatforms.length ? sendPlatforms : ['all'];
      for (const p of opts) {
        const o = document.createElement('option');
        o.value = p;
        o.textContent = p === 'all' ? 'All' : p;
        platformSelect.appendChild(o);
      }
    }
    if (sendInput) sendInput.disabled = !canSend;
    if (sendBtn) sendBtn.disabled = !canSend;
    renderMessages();
  }

  async function pollChat() {
    try {
      const res = await fetch(`${httpBase}/api/chat`);
      if (res.ok) applyChatPayload(await res.json());
    } catch {
      /* PC may be starting */
    }
  }

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'role', role: 'dock' }));
    };
    ws.onmessage = (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (data.type === 'paired') {
        setStatus('Live — SwiftSync PC connected', 'ok');
        showHelp('');
        pollChat();
        return;
      }
      if (data.type === 'error') {
        setStatus(data.message || 'Error', 'err');
        return;
      }
      if (data.type === 'chat' || data.type === 'chatBatch') {
        applyChatPayload(data);
        return;
      }
      if (data.type === 'chatMessage' && data.message) {
        messages.push(data.message);
        while (messages.length > 300) messages.shift();
        renderMessages();
        return;
      }
      if (data.type === 'chatStatus') {
        applyChatPayload(data);
      }
    };
    ws.onclose = () => {
      setStatus('Disconnected — is SwiftSync PC running?', 'err');
      showHelp(
        'SwiftSync must run on this PC. Connect chat in the app, then refresh this dock (⋮ → Refresh).'
      );
      setTimeout(connect, 3000);
    };
    ws.onerror = () => setStatus('Relay connection failed', 'err');
  }

  async function sendMessage() {
    const text = (sendInput?.value || '').trim();
    if (!text || !canSend) return;
    const platform = platformSelect?.value || 'all';
    try {
      const res = await fetch(`${httpBase}/api/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, platform })
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setStatus(body.message || 'Send failed', 'err');
        return;
      }
      sendInput.value = '';
    } catch (e) {
      setStatus(e.message || 'Send failed', 'err');
    }
  }

  sendBtn?.addEventListener('click', sendMessage);
  sendInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });

  setStatus('Connecting to SwiftSync…');
  connect();
  setInterval(pollChat, 4000);
})();

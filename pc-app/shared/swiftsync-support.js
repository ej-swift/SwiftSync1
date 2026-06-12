/**
 * Diagnostics, setup checklist, version check — PC + mobile.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SwiftSyncSupport = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_LOG = 400;
  const logLines = [];

  function ts() {
    return new Date().toISOString();
  }

  function diag(message, level = 'info') {
    const line = `[${ts()}] [${level}] ${message}`;
    logLines.push(line);
    if (logLines.length > MAX_LOG) logLines.shift();
    if (level === 'error') console.error(line);
    else console.log(line);
  }

  function getLogText(extra = {}) {
    const header = [
      `SwiftSync ${extra.version || '?'}`,
      `Platform: ${typeof navigator !== 'undefined' ? navigator.userAgent : process.platform}`,
      `Relay: ${extra.relay || '?'}`,
      `OBS: ${extra.obs || '?'}`,
      `Cloud: ${extra.cloud ? 'yes' : 'no'}`,
      '---'
    ];
    return header.concat(logLines).join('\n');
  }

  async function copyDiagnostics(extra = {}) {
    const text = getLogText(extra);
    try {
      if (typeof require !== 'undefined') {
        const { clipboard } = require('electron');
        clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  function formatChatAuthor(msg) {
    if (!msg || typeof msg !== 'object') return 'unknown';
    const user = msg.user;
    if (user && typeof user === 'object') {
      const nested =
        user.username || user.displayName || user.display_name || user.name || user.slug;
      if (nested && String(nested).trim()) return String(nested).trim();
    }
    const name = msg.author || msg.displayName || msg.username || msg.user;
    const s = String(name || '').trim();
    return s || 'unknown';
  }

  function isJoinChatMessage(msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.kind === 'join') return true;
    const t = String(msg.text || '');
    return (
      /\bjoined (the )?(chat|channel|stream|live)\b/i.test(t) ||
      /\bhas joined\b/i.test(t) ||
      /\bwelcome\b.*\bto the stream\b/i.test(t)
    );
  }

  function detectInAppBrowser() {
    if (typeof navigator === 'undefined') return { inApp: false, label: '' };
    const ua = navigator.userAgent || '';
    if (/BytedanceWebview|TikTok|musical_ly|Instagram|FBAN|FBAV|Twitter|LinkedInApp|Snapchat|Line\//i.test(ua)) {
      return { inApp: true, label: 'social app browser' };
    }
    if (/Android/i.test(ua) && /;\s*wv\)/.test(ua)) {
      return { inApp: true, label: 'in-app WebView' };
    }
    return { inApp: false, label: '' };
  }

  function renderChatOnlySetupChecklist(container, state) {
    if (!container) return;
    const steps = [
      {
        id: 'browser',
        label: 'Open in Safari or Chrome (not TikTok / Instagram in-app browser)',
        done: !state.inAppBrowser
      },
      {
        id: 'signin',
        label: 'Sign in to at least one platform below',
        done: !!state.chatSignedIn
      },
      {
        id: 'connect',
        label: 'Tap Connect — chat runs while this page is open',
        done: !!state.chatActive
      }
    ];
    container.innerHTML = '';
    const title = document.createElement('h3');
    title.className = 'setup-checklist-title';
    title.textContent = 'Chat-only setup';
    container.appendChild(title);
    const list = document.createElement('ol');
    list.className = 'setup-checklist';
    steps.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'setup-checklist-item' + (s.done ? ' done' : '');
      li.dataset.step = s.id;
      li.textContent = s.label;
      list.appendChild(li);
    });
    container.appendChild(list);
    const doneCount = steps.filter((s) => s.done).length;
    if (doneCount === steps.length) {
      const ok = document.createElement('p');
      ok.className = 'setup-checklist-all-done';
      ok.textContent = 'Ready — open the Chat tab to read and send messages.';
      container.appendChild(ok);
    }
  }

  function renderSetupChecklist(container, state) {
    if (!container) return;
    const steps = [
      {
        id: 'obs-ws',
        label: 'OBS WebSocket enabled (Tools → WebSocket Server Settings)',
        done: !!state.obsWs
      },
      {
        id: 'obs',
        label: 'Connected to OBS on this PC',
        done: !!state.obsConnected
      },
      {
        id: 'relay',
        label: state.cloud ? 'Cloud relay online' : 'Local relay online (port 4000)',
        done: !!state.relayOnline
      },
      {
        id: 'qr',
        label: 'Pair mobile — scan QR or copy link',
        done: !!state.pairingReady
      }
    ];
    container.innerHTML = '';
    const title = document.createElement('h3');
    title.className = 'setup-checklist-title';
    title.textContent = 'Quick setup';
    container.appendChild(title);
    const list = document.createElement('ol');
    list.className = 'setup-checklist';
    steps.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'setup-checklist-item' + (s.done ? ' done' : '');
      li.dataset.step = s.id;
      li.textContent = s.label;
      list.appendChild(li);
    });
    container.appendChild(list);
    const doneCount = steps.filter((s) => s.done).length;
    if (doneCount === steps.length) {
      const ok = document.createElement('p');
      ok.className = 'setup-checklist-all-done';
      ok.textContent = 'All set — open Scenes, Audio, or Chat from the sidebar.';
      container.appendChild(ok);
    }
  }

  async function checkForUpdates(opts = {}) {
    const current = opts.currentVersion || '0.0.0';
    const repo = (opts.githubRepo || '').trim();
    if (!repo) return { checked: false, updateAvailable: false };

    const tagUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    try {
      const res = await fetch(tagUrl, {
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (!res.ok) return { checked: true, updateAvailable: false, error: res.status };
      const data = await res.json();
      const latest = String(data.tag_name || '').replace(/^v/, '');
      const updateAvailable = latest && latest !== current && compareSemver(latest, current) > 0;
      return {
        checked: true,
        updateAvailable,
        latestVersion: latest,
        releaseUrl: data.html_url || ''
      };
    } catch (e) {
      return { checked: true, updateAvailable: false, error: e.message };
    }
  }

  function compareSemver(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i += 1) {
      if ((pa[i] || 0) > (pb[i] || 0)) return 1;
      if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
  }

  function filterChatMessages(messages, opts = {}) {
    let list = Array.isArray(messages) ? messages.slice() : [];
    const platform = opts.platform || 'all';
    if (platform !== 'all') {
      list = list.filter((m) => m.platform === platform);
    }
    if (opts.modsOnly) {
      list = list.filter((m) => isModMessage(m));
    }
    if (opts.dedupe) {
      const seen = new Set();
      list = list.filter((m) => {
        const key = `${m.platform}|${m.author}|${m.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return list;
  }

  function isModMessage(m) {
    const badges = m.badges || m.userBadges || [];
    if (Array.isArray(badges)) {
      return badges.some((b) => /mod|moderator|broadcaster|owner/i.test(String(b)));
    }
    const flags = m.isModerator || m.isMod || m.isBroadcaster || m.isOwner;
    if (flags) return true;
    const text = `${m.author || ''} ${m.displayName || ''}`.toLowerCase();
    return false;
  }

  return {
    diag,
    getLogText,
    copyDiagnostics,
    detectInAppBrowser,
    formatChatAuthor,
    isJoinChatMessage,
    renderSetupChecklist,
    renderChatOnlySetupChecklist,
    checkForUpdates,
    filterChatMessages,
    isModMessage
  };
});

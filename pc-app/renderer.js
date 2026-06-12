/**
 * SwiftSync PC App — renderer.js
 * OBS WebSocket v5, linked scenes, source controls, mobile relay (:4000)
 */

const OBSWebSocket = require('obs-websocket-js').default;
const { loadObsWebSocketSettings, getObsFieldFromDisk, getPrimaryLanIp } = require('./obs-config');

let QRCode = null;
try {
  QRCode = require('qrcode');
} catch {
  console.warn('qrcode package not installed — QR pairing disabled until npm install');
}

// ---------------------------------------------------------------------------
// ObsController
// ---------------------------------------------------------------------------

class ObsController {
  constructor() {
    this.client = new OBSWebSocket();
    this.state = 'disconnected';
    this.manualDisconnect = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.config = null;
    this.versionInfo = null;
    this.RECONNECT_BASE_MS = 3000;
    this.RECONNECT_MAX_MS = 30000;
    this._listeners = {};
    this._bindEvents();
  }

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }

  _emit(event, data) {
    (this._listeners[event] || []).forEach((fn) => fn(data));
  }

  get connected() {
    return this.client.identified === true;
  }

  /** True when OBS session is usable (UI + mobile relay). */
  get isOnline() {
    return this.connected || this.state === 'connected';
  }

  _bindEvents() {
    const c = this.client;
    c.removeAllListeners?.();
    c.on('ConnectionClosed', () => this._onConnectionClosed());
    c.on('CurrentProgramSceneChanged', (d) => this._emit('programSceneChanged', d));
    c.on('SceneListChanged', () => this._emit('sceneListChanged'));
    c.on('SceneCreated', () => this._emit('sceneListChanged'));
    c.on('SceneRemoved', () => this._emit('sceneListChanged'));
    c.on('SceneNameChanged', () => this._emit('sceneListChanged'));
    c.on('InputCreated', () => this._emit('audioInputsChanged'));
    c.on('InputRemoved', () => this._emit('audioInputsChanged'));
    c.on('InputNameChanged', () => this._emit('audioInputsChanged'));
    c.on('InputVolumeChanged', (d) => this._emit('inputVolumeChanged', d));
    c.on('InputMuteStateChanged', (d) => this._emit('inputMuteChanged', d));
    c.on('StreamStateChanged', (d) => this._emit('streamStateChanged', d));
    c.on('RecordStateChanged', (d) => this._emit('recordStateChanged', d));
    c.on('ReplayBufferStateChanged', (d) => this._emit('replayStateChanged', d));
    c.on('VirtualcamStateChanged', (d) => this._emit('vcamStateChanged', d));
    c.on('SceneItemCreated', (d) => this._emit('sceneItemsChanged', d));
    c.on('SceneItemRemoved', (d) => this._emit('sceneItemsChanged', d));
    c.on('SceneItemEnableStateChanged', (d) => this._emit('sceneItemsChanged', d));
    c.on('SceneItemListReindexed', (d) => this._emit('sceneItemsChanged', d));
    c.on('CanvasCreated', () => this._emit('canvasesChanged'));
    c.on('CanvasRemoved', () => this._emit('canvasesChanged'));
    c.on('CanvasNameChanged', () => this._emit('canvasesChanged'));
  }

  _resetClient() {
    try {
      this.client.removeAllListeners?.();
      if (this.client.identified) this.client.disconnect().catch(() => {});
    } catch { /* ignore */ }
    this.client = new OBSWebSocket();
    this._bindEvents();
  }

  async connect(host, port, password, force = false) {
    this._clearReconnectTimer();
    this.manualDisconnect = false;

    if (!force && (this.state === 'connecting' || this.connected)) return;

    if (!this.connected) this._resetClient();

    this.config = { host, port, password: password || '' };
    this.state = 'connecting';
    this._emit('state', { state: this.state });

    try {
      await this.client.connect(`ws://${host}:${port}`, password || undefined);
      this.state = 'connected';
      this.reconnectAttempt = 0;
      this._clearReconnectTimer();
      this.versionInfo = await this.call('GetVersion');
      this._emit('state', { state: this.state, version: this.versionInfo });
      this._emit('connected', this.versionInfo);
    } catch (err) {
      this.state = 'disconnected';
      this._emit('state', { state: this.state });
      this._emit('error', this._formatConnectError(err));
      if (!this.manualDisconnect) this._scheduleReconnect();
      throw err;
    }
  }

  async call(requestType, requestData = {}) {
    if (!this.connected) throw new Error('OBS not connected');
    try {
      return await this.client.call(requestType, requestData);
    } catch (err) {
      throw new Error(`${requestType}: ${err.message || err}`);
    }
  }

  _formatConnectError(err) {
    const msg = err?.message || String(err);
    if (/authentication/i.test(msg) || err?.code === 4009) {
      return 'OBS auth failed — check WebSocket password.';
    }
    if (/ECONNREFUSED|Failed to connect|connect/i.test(msg)) {
      return 'Cannot reach OBS — enable WebSocket in OBS settings.';
    }
    return msg;
  }

  async disconnect() {
    this.manualDisconnect = true;
    this._clearReconnectTimer();
    this.state = 'disconnected';
    try {
      if (this.client.identified) await this.client.disconnect();
    } catch { /* ignore */ }
    this._emit('state', { state: this.state });
    this._emit('disconnected');
  }

  _onConnectionClosed() {
    if (this.manualDisconnect) {
      this.state = 'disconnected';
      this._emit('state', { state: this.state });
      return;
    }
    this.state = 'reconnecting';
    this._emit('state', { state: this.state });
    this._emit('connectionLost');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.manualDisconnect || !this.config || this.reconnectTimer) return;
    const delay = Math.min(
      this.RECONNECT_BASE_MS * Math.pow(1.5, this.reconnectAttempt),
      this.RECONNECT_MAX_MS
    );
    this.reconnectAttempt += 1;
    this.state = 'reconnecting';
    this._emit('state', { state: this.state, retryInMs: delay });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.manualDisconnect || !this.config) return;
      try {
        if (typeof refreshObsConnectionConfig === 'function') {
          const latest = refreshObsConnectionConfig();
          this.config = { host: latest.host, port: latest.port, password: latest.password };
        }
        const { host, port, password } = this.config;
        await this.connect(host, port, password, true);
        this._emit('reconnected');
      } catch { /* connect schedules next retry */ }
    }, delay);
  }

  _clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  static AUDIO_KINDS = new Set([
    'wasapi_input_capture',
    'wasapi_output_capture',
    'pulse_input_capture',
    'pulse_output_capture',
    'coreaudio_input_capture',
    'coreaudio_output_capture',
    'alsa_input_capture'
  ]);

  static VIDEO_CAPTURE_KINDS = new Set([
    'dshow_input',
    'av_capture_input',
    'av_capture',
    'video_capture',
    'decklink_input',
    'ndi_source',
    'camera'
  ]);

  static isAudioInput(input) {
    const k = (input.inputKind || '').toLowerCase();
    if (ObsController.VIDEO_CAPTURE_KINDS.has(k)) return false;
    if (ObsController.AUDIO_KINDS.has(k)) return true;
    if (k.includes('audio')) return true;
    if (/wasapi|pulse|coreaudio|alsa|application.*audio|process.*audio/.test(k)) {
      return k.includes('capture') || k.includes('input') || k.includes('output') || k.includes('audio');
    }
    return false;
  }

  /**
   * SE.Live vertical audio copies — separate scene sources for the same mic/input.
   * Examples: me1, meV1, meV 1, spotifyV 2 (not bare "me" on main canvas).
   */
  static looksLikeVerticalAudioName(sourceName) {
    return !!ObsController.parseVerticalAudioLink(sourceName);
  }

  /** Parse SE.Live vertical audio source name → { base, index, variant }. */
  static parseVerticalAudioLink(sourceName) {
    const n = String(sourceName || '').trim();
    if (!n) return null;

    const bases = '(me|spotify|mic|audio|voice|music|desktop|game)';

    // meV 1, spotifyV 2 (SE.Live: base + V + space + copy number)
    let m = n.match(new RegExp(`^${bases}v\\s+(\\d+)\\s*$`, 'i'));
    if (m) {
      return { base: m[1].toLowerCase(), index: m[2], variant: n };
    }

    // me V 1 (spaced variant)
    m = n.match(new RegExp(`^${bases}\\s+v\\s+(\\d+)\\s*$`, 'i'));
    if (m) {
      return { base: m[1].toLowerCase(), index: m[2], variant: n };
    }

    // meV1, meV, spotifyV
    m = n.match(new RegExp(`^${bases}v(\\d*)$`, 'i'));
    if (m) {
      return { base: m[1].toLowerCase(), index: m[2] || null, variant: n };
    }

    // Legacy: me1, spotify2
    m = n.match(new RegExp(`^${bases}(\\d+)$`, 'i'));
    if (m) {
      return { base: m[1].toLowerCase(), index: m[2], variant: n };
    }

    m = n.match(new RegExp(`^${bases}[\\s_.-]+(\\d+)$`, 'i'));
    if (m) {
      return { base: m[1].toLowerCase(), index: m[2], variant: n };
    }

    return null;
  }

  /** Main-scene audio name that pairs with a vertical copy (meV 1 → me). */
  static mainAudioNameForVerticalSource(verticalSourceName) {
    const link = ObsController.parseVerticalAudioLink(verticalSourceName);
    if (!link) return null;
    return link.base;
  }

  /** SE.Live internal / vertical-canvas inputs — hide from global audio tab. */
  static isSeliveInternalAudioInput(input) {
    const name = String(input.inputName || input.name || '').trim();
    const kind = String(input.inputKind || '').toLowerCase();
    const lower = name.toLowerCase();
    if (!name) return true;

    if (/se\.?\s*live\s*audio\s*wrapper/i.test(name)) return true;
    if (/streamelements.*audio.*wrapper/i.test(lower)) return true;
    if (/streamelements.*wrapper/i.test(lower)) return true;
    if (kind.includes('streamelements') && (kind.includes('wrapper') || kind.includes('audio'))) {
      return true;
    }
    if (ObsController.looksLikeVerticalAudioName(name)) return true;

    return false;
  }

  static isVisualKind(inputKind = '', sourceType = '') {
    const k = (inputKind || '').toLowerCase();
    const t = (sourceType || '').toLowerCase();
    if (t.includes('scene') || t.includes('group')) return true;
    if (ObsController.VIDEO_CAPTURE_KINDS.has(k)) return true;
    if (/camera|webcam|video|dshow|v4l2|decklink|ndi|capture card/i.test(k)) return true;
    if (ObsController.isAudioInput({ inputKind: k })) {
      return k.includes('browser') || k.includes('ffmpeg') || k.includes('vlc');
    }
    return true;
  }

  static normalizeCanvas(raw, index = 0) {
    const name = raw.canvasName || raw.name || `Canvas ${index + 1}`;
    const width = raw.baseWidth ?? raw.canvasWidth ?? raw.width ?? null;
    const height = raw.baseHeight ?? raw.canvasHeight ?? raw.height ?? null;
    const flags = raw.canvasFlags ?? raw.flags ?? 0;
    const lower = name.toLowerCase();
    const landscapeByName = isLikelyLandscapeCanvasName(name);
    const verticalByName =
      !landscapeByName &&
      (isSeliveVerticalCanvasName(name) ||
        /^aitum vertical$/i.test(name) ||
        /vertical|portrait|9:16|shorts|tiktok|mobile|phone/.test(lower));
    const verticalBySize = width && height ? height > width * 1.05 : false;
    const landscapeBySize = width && height ? width >= height * 1.05 : false;
    return {
      uuid: raw.canvasUuid || raw.uuid || raw.id || null,
      name,
      width,
      height,
      flags,
      isMain:
        landscapeByName ||
        landscapeBySize ||
        (!verticalByName &&
          !verticalBySize &&
          (flags === 1 || flags === '1' || lower === 'main' || index === 0)),
      isVertical: verticalByName || (verticalBySize && !landscapeByName && !landscapeBySize)
    };
  }

  async getCanvasList() {
    try {
      const { canvases } = await this.call('GetCanvasList');
      return (canvases || []).map((c, i) => ObsController.normalizeCanvas(c, i));
    } catch {
      return [];
    }
  }

  async getSceneList(canvasUuid = null, canvasName = null) {
    const data = {};
    if (canvasUuid) data.canvasUuid = canvasUuid;
    if (canvasName) data.canvasName = canvasName;
    return this.call('GetSceneList', Object.keys(data).length ? data : undefined);
  }

  async getSceneNamesForCanvas(canvas) {
    const scenes = await this.getScenesForCanvas(canvas);
    return scenes.map((s) => s.sceneName);
  }

  static mapScenesFromList(list) {
    return (list?.scenes || [])
      .map((s) => ({
        sceneName: s.sceneName || s.name || null,
        sceneUuid: s.sceneUuid || s.uuid || s.scene_uuid || null
      }))
      .filter((s) => s.sceneName);
  }

  async getScenesForCanvas(canvas, { allowMainFallback = true } = {}) {
    const uuid = canvas?.uuid ?? (typeof canvas === 'string' ? canvas : null);

    if (uuid) {
      try {
        const list = await this.getSceneList(uuid);
        const scenes = ObsController.mapScenesFromList(list);
        if (scenes.length) return scenes;

        const rawCount = list?.scenes?.length || 0;
        if (rawCount > 0) {
          console.warn(
            '[SwiftSync vertical] GetSceneList returned scenes but none mapped — check sceneName/name fields',
            canvas?.name || uuid
          );
        }
      } catch (err) {
        console.warn('GetSceneList failed for canvas', canvas?.name || uuid, err.message || err);
      }

      if (!allowMainFallback) return [];
    }

    if (!allowMainFallback) return [];

    try {
      const list = await this.getSceneList(null);
      return ObsController.mapScenesFromList(list);
    } catch {
      return [];
    }
  }

  async setProgramScene(sceneName, canvasUuid = null, sceneUuid = null, canvasName = null) {
    const data = {};
    if (sceneUuid) data.sceneUuid = sceneUuid;
    else if (sceneName) data.sceneName = sceneName;
    if (canvasUuid) data.canvasUuid = canvasUuid;
    if (canvasName) data.canvasName = canvasName;
    return this.call('SetCurrentProgramScene', data);
  }

  /**
   * Capture a screenshot of any scene or source as a data URL (PNG/JPEG).
   * Used for the live preview thumbnail on PC and mobile.
   */
  async getSourceScreenshot(sourceName, { width = 480, height = 270, format = 'jpeg', quality = 60 } = {}) {
    if (!sourceName) return null;
    try {
      const args = {
        sourceName,
        imageFormat: format,
        imageWidth: width,
        imageHeight: height
      };
      if (format === 'jpeg') args.imageCompressionQuality = quality;
      const res = await this.call('GetSourceScreenshot', args);
      return res?.imageData || null;
    } catch {
      return null;
    }
  }

  /** Current program scene for a canvas (SE.Live multi-canvas). */
  async getCurrentProgramScene(canvasUuid = null) {
    if (canvasUuid) {
      try {
        const direct = await this.call('GetCurrentProgramScene', { canvasUuid });
        const sceneName = direct?.sceneName || direct?.currentProgramSceneName || null;
        const sceneUuid = direct?.sceneUuid || direct?.currentProgramSceneUuid || null;
        if (sceneName || sceneUuid) return { sceneName, sceneUuid };
      } catch {
        /* SE.Live may only expose program scene via GetSceneList per canvas */
      }
    } else {
      try {
        const direct = await this.call('GetCurrentProgramScene', {});
        const sceneName = direct?.sceneName || direct?.currentProgramSceneName || null;
        const sceneUuid = direct?.sceneUuid || direct?.currentProgramSceneUuid || null;
        if (sceneName || sceneUuid) return { sceneName, sceneUuid };
      } catch {
        /* fall through to GetSceneList */
      }
    }

    try {
      const list = await this.getSceneList(canvasUuid || undefined);
      const sceneName = list?.currentProgramSceneName || null;
      const sceneUuid = list?.currentProgramSceneUuid || null;
      if (sceneName || sceneUuid) return { sceneName, sceneUuid };
    } catch {
      /* ignore */
    }

    return null;
  }

  async getSceneItemList(sceneName, canvasUuid = null, sceneUuid = null, canvasName = null) {
    const data = {};
    if (sceneUuid) data.sceneUuid = sceneUuid;
    else if (sceneName) data.sceneName = sceneName;
    if (canvasUuid) data.canvasUuid = canvasUuid;
    if (canvasName) data.canvasName = canvasName;
    return this.call('GetSceneItemList', data);
  }

  async getGroupSceneItemList(sceneName, canvasUuid = null, sceneUuid = null, canvasName = null) {
    const data = {};
    if (sceneUuid) data.sceneUuid = sceneUuid;
    else if (sceneName) data.sceneName = sceneName;
    if (canvasUuid) data.canvasUuid = canvasUuid;
    if (canvasName) data.canvasName = canvasName;
    return this.call('GetGroupSceneItemList', data);
  }

  async callVendorRequest(vendorName, requestType, requestData = {}) {
    return this.call('CallVendorRequest', { vendorName, requestType, requestData });
  }

  static AITUM_VENDOR_NAMES = ['aitum-stream-suite', 'obs-aitum-stream-suite'];

  async callAitumVendor(requestType, requestData = {}) {
    let lastErr;
    for (const vendorName of ObsController.AITUM_VENDOR_NAMES) {
      try {
        const res = await this.callVendorRequest(vendorName, requestType, requestData);
        const data = res?.responseData ?? res ?? {};
        if (data.success === false) continue;
        return { vendorName, data };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error(`Aitum vendor ${requestType} unavailable`);
  }

  async getAitumCanvases() {
    try {
      const { data } = await this.callAitumVendor('get_canvas', {});
      const raw = data.canvas || data.canvases || [];
      return (Array.isArray(raw) ? raw : []).map((c, i) => ({
        ...ObsController.normalizeCanvas(
          {
            canvasName: c.name || c.canvasName,
            canvasUuid: c.uuid || c.canvasUuid,
            baseWidth: c.width,
            baseHeight: c.height
          },
          i
        ),
        fromAitum: true,
        aitumType: c.type || null
      }));
    } catch {
      return [];
    }
  }

  async getAitumScenes(canvasRef) {
    const canvas =
      typeof canvasRef === 'string'
        ? canvasRef
        : canvasRef?.uuid || canvasRef?.name || null;
    if (!canvas) return [];

    const requestPayloads = [{ canvas }];
    if (typeof canvas === 'string') {
      if (/^[0-9a-f-]{32,}$/i.test(canvas)) {
        requestPayloads.push({ canvasUuid: canvas }, { canvas: canvas });
      } else {
        requestPayloads.push({ canvasName: canvas }, { canvas: canvas });
      }
    }

    const seen = new Set();
    for (const requestData of requestPayloads) {
      const key = JSON.stringify(requestData);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const { data } = await this.callAitumVendor('get_scenes', requestData);
        const raw = data.scenes || [];
        const scenes = (Array.isArray(raw) ? raw : [])
          .map((s) => ({
            sceneName: s.name || s.sceneName,
            sceneUuid: s.uuid || s.sceneUuid || null
          }))
          .filter((s) => s.sceneName);
        if (scenes.length) return scenes;
      } catch {
        /* try next payload shape */
      }
    }
    return [];
  }

  async getAitumCurrentScene(canvasRef) {
    const canvas =
      typeof canvasRef === 'string'
        ? canvasRef
        : canvasRef?.uuid || canvasRef?.name || null;
    if (!canvas) return null;
    try {
      const { data } = await this.callAitumVendor('current_scene', { canvas });
      const sceneName = data.scene || data.sceneName || null;
      const sceneUuid = data.scene_uuid || data.sceneUuid || null;
      if (sceneName || sceneUuid) return { sceneName, sceneUuid };
    } catch {
      /* vendor unavailable */
    }
    return null;
  }

  async getInputKind(inputName) {
    try {
      return await this.call('GetInputKind', { inputName });
    } catch {
      return { inputKind: '', inputKindCaps: 0 };
    }
  }

  async sourceHasVolume(inputName) {
    try {
      await this.call('GetInputVolume', { inputName });
      return true;
    } catch {
      return false;
    }
  }

  async getSceneSourcesDirect(sceneName, canvasUuid = null, sceneUuid = null, canvasName = null) {
    const { sceneItems = [] } = await this.getSceneItemList(
      sceneName,
      canvasUuid,
      sceneUuid,
      canvasName
    );

    const visual = [];
    const audio = [];

    for (const item of sceneItems) {
      const sourceName = item.sourceName || item.name;
      if (!sourceName) continue;

      const entry = await this._sceneItemToSourceEntry(item, sceneName, sceneUuid, canvasUuid);
      const base = {
        sourceName,
        inputKind: item.inputKind || entry.data.inputKind || '',
        sourceType: item.sourceType || entry.data.sourceType || '',
        enabled: item.sceneItemEnabled !== false,
        sceneItemId: item.sceneItemId,
        sceneName,
        sceneUuid,
        canvasUuid,
        canvasName: canvasName || getCanvasNameForUuid(canvasUuid) || null
      };

      if (entry.isAudio) {
        audio.push({ ...entry.data, ...base });
      }
      if (entry.isVisual) {
        visual.push({ ...entry.data, ...base });
      }
      if (!entry.isVisual && !entry.isAudio) {
        if (ObsController.looksLikeVerticalAudioName(sourceName)) {
          audio.push({ ...base, volumeDb: 0, volumeMul: 1, muted: false });
        } else {
          visual.push(base);
        }
      }
    }

    return { visual, audio, sceneName, rawItemCount: sceneItems.length };
  }

  async getSceneSources(sceneName, canvasUuid = null, sceneUuid = null, canvasName = null, options = {}) {
    const expandNestedScenes = options.expandNestedScenes !== false;
    const expandGroups = options.expandGroups !== false;
    const depth = options.depth ?? 0;
    if (depth > 4) return { visual: [], audio: [], sceneName };

    const listOpts = { sceneName, canvasUuid, sceneUuid, canvasName };
    let sceneItems = [];
    try {
      ({ sceneItems = [] } = await this.getSceneItemList(
        listOpts.sceneName,
        listOpts.canvasUuid,
        listOpts.sceneUuid,
        listOpts.canvasName
      ));
    } catch (err) {
      if (depth === 0) throw err;
      return { visual: [], audio: [], sceneName };
    }

    const visual = [];
    const audio = [];
    const includeUnclassified = options.includeUnclassified === true;
    const seen = new Set();
    const nestedTasks = [];

    for (const item of sceneItems) {
      const sourceName = item.sourceName;
      const itemKey =
        item.sceneItemId != null ? `id:${item.sceneItemId}` : `name:${sourceName}`;
      if (!sourceName || seen.has(itemKey)) continue;

      const sourceType = String(item.sourceType || item.inputKind || '').toLowerCase();
      if (sourceType === 'group' && expandGroups) {
        nestedTasks.push(
          this.getGroupSceneItemList(sourceName, canvasUuid, null, canvasName)
            .then(({ sceneItems: groupItems = [] }) => groupItems)
            .catch(() => [])
        );
        continue;
      }
      if (sourceType === 'scene') {
        if (expandNestedScenes) {
          nestedTasks.push(
            (async () => {
              const nestedUuid = await resolveSceneUuidForCanvas(sourceName, canvasUuid);
              const { sceneItems: nestedItems = [] } = await this.getSceneItemList(
                sourceName,
                canvasUuid,
                nestedUuid,
                canvasName
              );
              return nestedItems;
            })().catch(() => [])
          );
        } else {
          seen.add(itemKey);
          visual.push({
            sourceName,
            inputKind: 'scene',
            sourceType: item.sourceType || 'scene',
            enabled: item.sceneItemEnabled !== false,
            sceneItemId: item.sceneItemId,
            sceneName,
            sceneUuid,
            canvasUuid
          });
        }
        continue;
      }

      seen.add(itemKey);
      const entry = await this._sceneItemToSourceEntry(item, sceneName, sceneUuid, canvasUuid);
      if (entry.isVisual) visual.push(entry.data);
      if (entry.isAudio) audio.push(entry.data);
      else if (includeUnclassified && depth === 0) {
        visual.push({
          ...entry.data,
          enabled: item.sceneItemEnabled !== false
        });
      }
    }

    if (nestedTasks.length) {
      const nestedLists = await Promise.all(nestedTasks);
      for (const nestedItems of nestedLists) {
        for (const item of nestedItems) {
          const sourceName = item.sourceName;
          const itemKey =
            item.sceneItemId != null ? `id:${item.sceneItemId}` : `name:${sourceName}`;
          if (!sourceName || seen.has(itemKey)) continue;
          seen.add(itemKey);
          const entry = await this._sceneItemToSourceEntry(item, sceneName, sceneUuid, canvasUuid);
          if (entry.isVisual) visual.push(entry.data);
          if (entry.isAudio) audio.push(entry.data);
          else if (includeUnclassified && depth === 0) {
            visual.push({
              ...entry.data,
              enabled: item.sceneItemEnabled !== false
            });
          }
        }
      }
    }

    if (includeUnclassified && depth === 0 && !visual.length && !audio.length && sceneItems.length) {
      for (const item of sceneItems) {
        const sourceName = item.sourceName || item.name;
        if (!sourceName) continue;
        visual.push({
          sourceName,
          inputKind: item.inputKind || item.sourceType || '',
          sourceType: item.sourceType || item.inputKind || '',
          enabled: item.sceneItemEnabled !== false,
          sceneItemId: item.sceneItemId ?? item.id ?? null,
          sceneName,
          sceneUuid,
          canvasUuid
        });
      }
    }

    return { visual, audio, sceneName };
  }

  async _sceneItemToSourceEntry(item, sceneName, sceneUuid, canvasUuid) {
    const sourceName = item.sourceName;
    const enabled = item.sceneItemEnabled !== false;
    const sourceType = item.sourceType || item.inputKind || '';
    let inputKind = item.inputKind || '';
    if (!inputKind) {
      try {
        const kind = await this.getInputKind(sourceName);
        inputKind = kind.inputKind || '';
      } catch {
        inputKind = '';
      }
    }

    const hasVolume = await this.sourceHasVolume(sourceName);
    const namedVerticalAudio = ObsController.looksLikeVerticalAudioName(sourceName);
    const looksLikeCamera =
      !namedVerticalAudio &&
      /emeet|webcam|elgato|facecam|camera|cam\b|capture card|dshow/i.test(String(sourceName));

    let isVisual =
      ObsController.isVisualKind(inputKind, sourceType) || looksLikeCamera;
    let isAudioOnly = ObsController.isAudioInput({ inputKind }) && !isVisual;
    let isAudio = isAudioOnly || (hasVolume && !isAudioOnly);

    if (namedVerticalAudio && (hasVolume || ObsController.isAudioInput({ inputKind }))) {
      isAudio = true;
      isVisual = false;
    }

    const entry = {
      sourceName,
      inputKind,
      sourceType,
      enabled,
      sceneItemId: item.sceneItemId,
      sceneName,
      sceneUuid,
      canvasUuid
    };

    if (isAudio) {
      try {
        const vol = await this.getInputVolume(sourceName);
        entry.volumeDb = vol.inputVolumeDb ?? 0;
        entry.volumeMul = vol.inputVolumeMul ?? 1;
        entry.muted = (await this.getInputMute(sourceName)).inputMuted;
      } catch {
        entry.volumeDb = 0;
        entry.volumeMul = 1;
        entry.muted = false;
      }
    }

    return { isVisual, isAudio, data: entry };
  }

  async setSceneItemEnabled(sceneName, sceneItemId, enabled, canvasUuid = null, sceneUuid = null, canvasName = null) {
    const attempts = [];
    const vCanvas = getVerticalCanvasUuid();
    const mCanvas = mainCanvasUuid;
    const isVerticalCanvas =
      canvasUuid && vCanvas && canvasUuid === vCanvas && canvasUuid !== mCanvas;

    const withCanvas = (base) => {
      const data = { ...base };
      if (canvasUuid) data.canvasUuid = canvasUuid;
      if (canvasName) data.canvasName = canvasName;
      return data;
    };

    if (isVerticalCanvas) {
      if (sceneUuid) attempts.push(withCanvas({ sceneUuid }));
      if (sceneName) attempts.push(withCanvas({ sceneName }));
      if (!attempts.length) {
        throw new Error('Vertical source toggle requires sceneName or sceneUuid with canvasUuid');
      }
    } else {
      if (sceneUuid) {
        attempts.push(withCanvas({ sceneUuid }));
        attempts.push({ sceneUuid, canvasUuid: undefined });
      }
      if (sceneName) {
        attempts.push(withCanvas({ sceneName }));
        if (canvasUuid || canvasName) attempts.push({ sceneName });
      }
    }

    let lastErr;
    for (const scope of attempts) {
      const data = { sceneItemId, sceneItemEnabled: enabled, ...scope };
      if (data.canvasUuid === undefined) delete data.canvasUuid;
      if (data.canvasName === undefined) delete data.canvasName;
      try {
        return await this.call('SetSceneItemEnabled', data);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('SetSceneItemEnabled failed');
  }

  async setSceneItemEnabledForSource(src, enabled) {
    return this.setSceneItemEnabled(
      src.sceneName,
      src.sceneItemId,
      enabled,
      src.canvasUuid || null,
      src.sceneUuid || null,
      src.canvasName || getCanvasNameForUuid(src.canvasUuid) || null
    );
  }

  async getAudioInputs() {
    const { inputs } = await this.call('GetInputList');
    const audioInputs = [];
    for (const input of inputs || []) {
      if (ObsController.isAudioInput(input)) {
        audioInputs.push(input);
        continue;
      }
      try {
        await this.call('GetInputVolume', { inputName: input.inputName });
        audioInputs.push(input);
      } catch { /* not a volume source */ }
    }
    return audioInputs;
  }

  async getInputVolume(name) { return this.call('GetInputVolume', { inputName: name }); }
  async setInputVolumeDb(name, db) {
    return this.call('SetInputVolume', { inputName: name, inputVolumeDb: db });
  }
  async setInputVolume(name, mul) { return this.call('SetInputVolume', { inputName: name, inputVolumeMul: mul }); }
  async getInputMute(name) { return this.call('GetInputMute', { inputName: name }); }
  async toggleInputMute(name) { return this.call('ToggleInputMute', { inputName: name }); }
  async setInputMute(name, muted) { return this.call('SetInputMute', { inputName: name, inputMuted: muted }); }
  async getStreamStatus() { return this.call('GetStreamStatus'); }
  async getRecordStatus() { return this.call('GetRecordStatus'); }
  async getReplayBufferStatus() { return this.call('GetReplayBufferStatus'); }
  async getVirtualCamStatus() { return this.call('GetVirtualCamStatus'); }
  async getStudioModeEnabled() { return this.call('GetStudioModeEnabled'); }
  async toggleStream() { return this.call('ToggleStream'); }
  async toggleRecord() { return this.call('ToggleRecord'); }
  async pauseRecord() { return this.call('PauseRecord'); }
  async toggleReplayBuffer() { return this.call('ToggleReplayBuffer'); }
  async saveReplayBuffer() { return this.call('SaveReplayBuffer'); }
  async toggleVirtualCam() { return this.call('ToggleVirtualCam'); }
  async setStudioModeEnabled(enabled) { return this.call('SetStudioModeEnabled', { studioModeEnabled: enabled }); }
}

const obsController = new ObsController();

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const { loadRelayConfig, useCloudRelay } = require('./relay-config');
const { getPersistentPairingCode, rotatePersistentPairingCode, getLockedPairingQr, setLockedPairingQr } = require('./pairing-store');
require('./chat/electron-http').installElectronHttp();
const { createChatHub, normalizeChannel } = require('./chat-service');
const { loadChatConfig, saveChatConfig } = require('./chat-config');
const { prepareChatConfig } = require('./chat/prepare-config');
const { normalizeSlug: normalizeKickChannelInput } = require('./chat/kick');
const {
  isOAuthConfigured,
  loadOAuthApps,
  saveOAuthApps,
  ensureOAuthAppsFile,
  getUserDataOAuthPath,
  getOAuthSetupStatus,
  oauthAppsHaveRealCredentials,
  DEFAULT_REDIRECT
} = require('./chat-oauth-apps');
const { shell, ipcRenderer } = require('electron');
const RELAY_RECONNECT_MS = 2000;
let relayRuntime = null;
let relayConnectUrl = '';

function refreshRelayRuntime() {
  const cfg = loadRelayConfig();
  const port = Number(window.SWIFTSYNC_RELAY_PORT) || 4000;
  const cloudUrl = (cfg.cloudRelayUrl || window.SWIFTSYNC_CLOUD_RELAY_URL || '').trim();
  const cloudPublic = (cfg.cloudPublicUrl || window.SWIFTSYNC_CLOUD_PUBLIC_URL || '').trim().replace(/\/$/, '');
  const useCloud =
    useCloudRelay(cfg) ||
    useCloudRelay({ cloudRelayUrl: cloudUrl, cloudPublicUrl: cloudPublic }) ||
    window.SWIFTSYNC_USE_CLOUD_RELAY === true ||
    window.SWIFTSYNC_USE_CLOUD_RELAY === 'true';
  const relayUrl = useCloud && cloudUrl ? cloudUrl : `ws://127.0.0.1:${port}`;
  relayRuntime = {
    cfg,
    port,
    cloudUrl,
    cloudPublic,
    useCloud,
    relayUrl,
    external: window.SWIFTSYNC_RELAY_EXTERNAL === true || window.SWIFTSYNC_RELAY_EXTERNAL === 'true',
    attached: window.SWIFTSYNC_RELAY_ATTACHED === true || window.SWIFTSYNC_RELAY_ATTACHED === 'true'
  };
  return relayRuntime;
}

async function syncRelayConfigFromMain() {
  try {
    const s = await ipcRenderer.invoke('swiftsync:get-relay-status');
    if (!s) return;
    window.SWIFTSYNC_RELAY_PORT = s.port;
    window.SWIFTSYNC_RELAY_EXTERNAL = s.external ? 'true' : 'false';
    window.SWIFTSYNC_RELAY_EMBEDDED = s.embedded ? 'true' : 'false';
    window.SWIFTSYNC_RELAY_ATTACHED = s.attached ? 'true' : 'false';
  } catch (_) {}
}

function getRelayHttpBase() {
  const rt = relayRuntime || refreshRelayRuntime();
  if (rt.useCloud && rt.cloudPublic) return rt.cloudPublic;
  if (rt.useCloud && rt.cloudUrl) {
    return rt.cloudUrl.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
  }
  return `http://127.0.0.1:${rt.port}`;
}

function getRelayHttpBases() {
  const rt = relayRuntime || refreshRelayRuntime();
  const local = `http://127.0.0.1:${rt.port}`;
  const bases = [local];
  const cloud = getRelayHttpBase();
  if (cloud && !bases.includes(cloud)) bases.push(cloud);
  return bases;
}

function getRelayPort() {
  return (relayRuntime || refreshRelayRuntime()).port;
}

const setupChecklistHost = document.getElementById('setup-checklist-host');
const relayHealthEl = document.getElementById('relay-health');
const relayHealthText = document.getElementById('relay-health-text');
const relayRetryBtn = document.getElementById('relay-retry-btn');
const copyDiagnosticsBtn = document.getElementById('copy-diagnostics-btn');
const versionBanner = document.getElementById('version-banner');
let relayOnline = false;
let chatFilterPlatform = 'all';
let chatModsOnly = false;
let chatDedupe = false;

function supportDiag(msg, level) {
  if (typeof SwiftSyncSupport !== 'undefined') SwiftSyncSupport.diag(msg, level);
}

function refreshSetupChecklist() {
  if (typeof SwiftSyncSupport === 'undefined' || !setupChecklistHost) return;
  const rt = relayRuntime || refreshRelayRuntime();
  SwiftSyncSupport.renderSetupChecklist(setupChecklistHost, {
    obsWs: getObsSettings().serverEnabled !== false,
    obsConnected: obsController.connected,
    relayOnline,
    cloud: rt.useCloud,
    pairingReady: !!(pairingCodeEl && pairingCodeEl.textContent && pairingCodeEl.textContent !== '------')
  });
}

function updateRelayHealth(message, { ok = false, show = true } = {}) {
  if (!relayHealthEl || !relayHealthText) return;
  relayHealthText.textContent = message || '';
  relayHealthEl.classList.toggle('ok', !!ok);
  if (ok) {
    relayHealthEl.hidden = !show;
    return;
  }
  relayHealthEl.hidden = !show;
}

function updateCanvasVerticalStatus() {
  if (!canvasHintEl) return;
  if (!obsController.connected) {
    canvasHintEl.textContent = 'Connect to OBS on Home — then tap a scene card to switch live.';
    return;
  }
  if (!dualCanvasMode) {
    canvasHintEl.textContent = `Program scene — tap a card to switch OBS · active: ${activeSceneName || '—'}`;
    return;
  }
  const link = getActiveSceneLink();
  const vert = link?.vertical?.sceneName;
  canvasHintEl.textContent = vert
    ? `Main + vertical linked · ${activeSceneName || '—'} ↔ ${vert} — tap a card to switch both`
    : `Dual canvas — tap a card to switch OBS on main + vertical`;
}

relayRetryBtn?.addEventListener('click', async () => {
  supportDiag('User retry relay');
  localRelayIpcReady = false;
  relayCloudIpcReady = false;
  ipcRenderer.invoke('swiftsync:local-relay-disconnect').catch(() => {});
  ipcRenderer.invoke('swiftsync:cloud-relay-disconnect').catch(() => {});
  try {
    const restarted = await ipcRenderer.invoke('swiftsync:restart-relay');
    if (restarted?.port != null) {
      window.SWIFTSYNC_RELAY_PORT = restarted.port;
      window.SWIFTSYNC_RELAY_EXTERNAL = restarted.external ? 'true' : 'false';
      window.SWIFTSYNC_RELAY_EMBEDDED = restarted.ok ? 'true' : 'false';
      window.SWIFTSYNC_RELAY_ATTACHED = restarted.attached ? 'true' : 'false';
    }
  } catch (e) {
    supportDiag(`Restart relay failed: ${e?.message || e}`, 'warn');
  }
  refreshRelayRuntime();
  connectRelay();
});

copyDiagnosticsBtn?.addEventListener('click', async () => {
  const rt = relayRuntime || refreshRelayRuntime();
  const ok = await SwiftSyncSupport?.copyDiagnostics({
    version: window.SWIFTSYNC_VERSION,
    relay: relayOnline ? (rt.useCloud ? 'cloud online' : 'local online') : 'offline',
    obs: obsController.connected ? 'connected' : 'offline',
    cloud: rt.useCloud
  });
  setStatus(ok ? 'Diagnostics copied to clipboard' : 'Could not copy diagnostics', ok ? '#00ff85' : '#ff4444');
});

document.querySelectorAll('#chat-filter-row .chat-filter-chip')?.forEach((chip) => {
  chip.addEventListener('click', () => {
    chatFilterPlatform = chip.dataset.filter || 'all';
    document.querySelectorAll('#chat-filter-row .chat-filter-chip').forEach((c) => {
      c.classList.toggle('active', c === chip);
    });
    syncChatFromHub();
  });
});
document.getElementById('chat-mods-only')?.addEventListener('change', (e) => {
  chatModsOnly = !!e.target.checked;
  syncChatFromHub();
});
document.getElementById('chat-dedupe')?.addEventListener('change', (e) => {
  chatDedupe = !!e.target.checked;
  syncChatFromHub();
});

async function checkAppVersion() {
  if (!versionBanner || typeof SwiftSyncSupport === 'undefined') return;
  const repo = (window.SWIFTSYNC_GITHUB_REPO || '').trim();
  if (!repo) return;
  const result = await SwiftSyncSupport.checkForUpdates({
    currentVersion: window.SWIFTSYNC_VERSION || '1.0.1',
    githubRepo: repo
  });
  if (result.updateAvailable && result.releaseUrl) {
    versionBanner.hidden = false;
    versionBanner.innerHTML = `Update available: v${result.latestVersion} — <a href="${result.releaseUrl}" target="_blank" rel="noopener">Download</a>`;
  }
}

function logRelayMode() {
  const rt = relayRuntime || refreshRelayRuntime();
  if (rt.useCloud && rt.cloudUrl) {
    console.log('[SwiftSync] Cloud relay:', rt.cloudUrl);
  } else if (rt.external) {
    console.warn('[SwiftSync] Using existing relay on port', rt.port, '— close other SwiftSync windows if pairing fails');
  } else {
    console.log('[SwiftSync] Local relay: ws://127.0.0.1:' + rt.port);
  }
}

const PANELS = {
  connect: document.getElementById('connect-screen'),
  scenes: document.getElementById('scenes'),
  audio: document.getElementById('audio-panel'),
  chat: document.getElementById('chat-panel'),
  tools: document.getElementById('tools-panel')
};

const connectScreen = PANELS.connect;
const scenesPanel = document.getElementById('scenes');
const sceneListEl = document.getElementById('scene-list');
const statusText = document.getElementById('status');
const obsInfoEl = document.getElementById('obs-info');
const ipInput = document.getElementById('ip');
const portInput = document.getElementById('port');
const passwordInput = document.getElementById('password');
const connectBtn = document.getElementById('connect-btn');
const reconnectBtn = document.getElementById('reconnect-btn');
const pillRelay = document.getElementById('pill-relay');
const pillObs = document.getElementById('pill-obs');
const pillChat = document.getElementById('pill-chat');
const mobilePill = document.getElementById('mobile-pill');
const pageViewport = document.getElementById('page-viewport');
const pcTabTrack = document.getElementById('pc-cube-track');

const PC_TAB_ORDER = ['connect', 'scenes', 'audio', 'chat', 'tools'];
const PC_TAB_PAGES = {
  connect: 'connect-screen',
  scenes: 'scenes',
  audio: 'audio-panel',
  chat: 'chat-panel',
  tools: 'tools-panel'
};

/** PC uses simple show/hide tabs — horizontal tab-slide breaks scrolling in Electron. */
const pcTabSlide = null;

function initPcSimpleTabs() {
  if (pcTabTrack) {
    pcTabTrack.style.cssText = '';
    pcTabTrack.classList.remove('tab-slide-track', 'dragging');
  }
  if (pageViewport) {
    pageViewport.classList.remove('tab-slide-viewport', 'tab-slide-scroll-viewport');
  }
  PC_TAB_ORDER.forEach((tab) => {
    const page = document.getElementById(PC_TAB_PAGES[tab]);
    if (!page) return;
    page.style.cssText = '';
    page.classList.remove('tab-slide-page', 'tab-slide-active');
  });
}

function scrollPcViewportBy(deltaY) {
  if (!pageViewport || !deltaY) return false;
  const max = pageViewport.scrollHeight - pageViewport.clientHeight;
  if (max <= 0) return false;
  const next = Math.max(0, Math.min(max, pageViewport.scrollTop + deltaY));
  if (next === pageViewport.scrollTop) return false;
  pageViewport.scrollTop = next;
  return true;
}

function installPcViewportWheelScroll() {
  if (!pageViewport) return;
  const mainShell = document.getElementById('main-shell');

  window.addEventListener(
    'wheel',
    (e) => {
      if (!document.body.classList.contains('pc-simple-tabs')) return;
      if (!mainShell?.contains(e.target)) return;

      let node = e.target;
      while (node && node !== pageViewport) {
        if (node !== pageViewport && node.scrollHeight > node.clientHeight + 1) {
          const oy = getComputedStyle(node).overflowY;
          if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
            const max = node.scrollHeight - node.clientHeight;
            if (e.deltaY > 0 && node.scrollTop < max - 1) return;
            if (e.deltaY < 0 && node.scrollTop > 0) return;
          }
        }
        node = node.parentElement;
      }

      if (scrollPcViewportBy(e.deltaY)) e.preventDefault();
    },
    { passive: false }
  );
}

initPcSimpleTabs();
installPcViewportWheelScroll();
const pairingQrEl = document.getElementById('pairing-qr');
const pairingCodeEl = document.getElementById('pairing-code');
const pairingUrlEl = document.getElementById('pairing-url');
const regeneratePairingBtn = document.getElementById('regenerate-pairing-btn');
const refreshScenesBtn = document.getElementById('refresh-scenes-btn');
const refreshAudioBtn = document.getElementById('refresh-audio-btn');
const refreshToolsBtn = document.getElementById('refresh-tools-btn');
const globalAudioListEl = document.getElementById('global-audio-list');
const scenePageAudioListEl = document.getElementById('scene-page-audio-list');
const sceneAudioSectionEl = document.getElementById('scene-audio-section');
const canvasHintEl = document.getElementById('canvas-hint');
const linkedScenesHeaderEl = document.getElementById('linked-scenes-header');
const linkedSourcesPanelEl = document.getElementById('linked-sources-panel');
const sceneSourcesEmptyEl = document.getElementById('scene-sources-empty');
const stateStream = document.getElementById('state-stream');
const stateRecord = document.getElementById('state-record');
const stateReplay = document.getElementById('state-replay');
const stateVcam = document.getElementById('state-vcam');
const stateStudio = document.getElementById('state-studio');
const streamToggleBtn = document.getElementById('stream-toggle-btn');
const recordToggleBtn = document.getElementById('record-toggle-btn');
const recordPauseBtn = document.getElementById('record-pause-btn');
const replayToggleBtn = document.getElementById('replay-toggle-btn');
const replaySaveBtn = document.getElementById('replay-save-btn');
const vcamToggleBtn = document.getElementById('vcam-toggle-btn');
const studioToggleBtn = document.getElementById('studio-toggle-btn');
const tabButtons = document.querySelectorAll('.tab-btn');
const chatEnableTwitch = document.getElementById('chat-enable-twitch');
const chatEnableKick = document.getElementById('chat-enable-kick');
const chatEnableYoutube = document.getElementById('chat-enable-youtube');
const chatEnableTiktok = document.getElementById('chat-enable-tiktok');
const chatTwitchChannel = document.getElementById('chat-twitch-channel');
const chatTwitchUsername = document.getElementById('chat-twitch-username');
const chatTwitchOauth = document.getElementById('chat-twitch-oauth');
const chatKickChannel = document.getElementById('chat-kick-channel');
const chatYoutubeChannelId = document.getElementById('chat-youtube-channel-id');
const chatYoutubeApiKey = document.getElementById('chat-youtube-api-key');
const chatTiktokUsername = document.getElementById('chat-tiktok-username');
const chatTiktokApiKey = document.getElementById('chat-tiktok-api-key');
const chatConnectBtn = document.getElementById('chat-connect-btn');
const chatSaveConfigBtn = document.getElementById('chat-save-config-btn');
const chatStatusLine = document.getElementById('chat-status-line');
const chatSigninFeedback = document.getElementById('chat-signin-feedback');
const chatMessagesEl = document.getElementById('chat-messages');
const chatSendInput = document.getElementById('chat-send-input');
const chatSendBtn = document.getElementById('chat-send-btn');
const chatSendPlatform = document.getElementById('chat-send-platform');
const chatAccountEls = {
  twitch: document.getElementById('chat-account-twitch'),
  kick: document.getElementById('chat-account-kick'),
  youtube: document.getElementById('chat-account-youtube'),
  tiktok: document.getElementById('chat-account-tiktok')
};
const chatLoginBtns = document.querySelectorAll('.chat-login-btn[data-oauth]');
const chatLogoutBtns = document.querySelectorAll('.chat-logout-btn[data-oauth]');
const chatOauthRedirectUri = document.getElementById('chat-oauth-redirect-uri');
const oauthTwitchClientId = document.getElementById('oauth-twitch-client-id');
const oauthTwitchClientSecret = document.getElementById('oauth-twitch-client-secret');
const oauthKickClientId = document.getElementById('oauth-kick-client-id');
const oauthKickClientSecret = document.getElementById('oauth-kick-client-secret');
const oauthYoutubeClientId = document.getElementById('oauth-youtube-client-id');
const oauthYoutubeClientSecret = document.getElementById('oauth-youtube-client-secret');
const oauthTiktokClientKey = document.getElementById('oauth-tiktok-client-key');
const oauthTiktokClientSecret = document.getElementById('oauth-tiktok-client-secret');
const oauthSaveBtn = document.getElementById('oauth-save-btn');
const oauthOpenFolderBtn = document.getElementById('oauth-open-folder-btn');
const oauthPortalLinks = document.querySelectorAll('.chat-oauth-portal-link');

const chatHub = createChatHub();
let chatConfig = loadChatConfig();
let chatConnected = false;
let chatCanSend = false;
let chatStatuses = {};
let chatAutoConnectTimer = null;
let chatAutoConnectInFlight = false;
let chatKeepAliveTimer = null;
let lastChatConnectAttemptAt = 0;
const CHAT_AUTO_DEBOUNCE_MS = 8000;
const CHAT_KEEPALIVE_MS = 45000;

let relaySocket = null;
let localRelayBridgeSocket = null;
let relayReconnectTimer = null;
let relayConnectTimeout = null;
let relayTransport = 'none';
let relayCloudIpcReady = false;
let localRelayIpcReady = false;
let localRelayBridgeOnline = false;
const RELAY_CONNECT_TIMEOUT_MS = 15000;
let mobileLinked = false;
let mobileSyncTimer = null;
let activeTab = 'connect';
/** Set when user picks a sidebar tab — stops OBS events from yanking them back to Home/Scenes. */
let userHasChosenTab = false;
let canvasOptions = [];
let mainCanvasUuid = null;
let verticalCanvasUuid = null;
let dualCanvasMode = false;
/** @type {Array<{ main: { sceneName: string, canvasUuid: string|null }, vertical: { sceneName: string, canvasUuid: string|null }|null }>} */
let sceneLinks = [];
let lastVerticalScenes = [];
/** @type {Array<{ sceneName: string, sceneUuid: string|null }|string>} */
let lastVerticalEntries = [];
/** @type {Array<{ uuid: string|null, name: string, fromAitum?: boolean }>} */
let aitumCanvasCache = [];
/** @type {{ sceneName: string|null, strategies: Array<{ label: string, count: number, error?: string }> }|null} */
let lastVerticalFetchDebug = null;
const verticalSceneNameProbeCache = new Map();
let activeSceneName = null;

const VERTICAL_CANVAS_NAME_HINTS = [
  'V - StreamElements Canvas',
  'StreamElements Canvas',
  'Vertical',
  'Portrait',
  'SE.Live'
];

function isSeliveVerticalCanvasName(name) {
  const raw = String(name || '').trim();
  const lower = raw.toLowerCase();
  if (!lower) return false;
  return (
    /^v\s*[-–—]\s*/.test(lower) ||
    /streamelements/.test(lower) ||
    /stream elements canvas/.test(lower) ||
    /^vertical$/i.test(raw) ||
    /^portrait$/i.test(raw) ||
    /selive|se\.live|9:16|shorts|tiktok|stream suite/.test(lower)
  );
}

function isLikelyLandscapeCanvasName(name) {
  const lower = String(name || '').trim().toLowerCase();
  if (!lower || isSeliveVerticalCanvasName(name)) return false;
  return (
    lower === 'main' ||
    /landscape|16:9|16\s*:\s*9|horizontal|program|primary|1920|1080|hd stream|main stream/.test(
      lower
    )
  );
}

function isLikelyMainCanvasName(name) {
  return isLikelyLandscapeCanvasName(name);
}
let obsAutoConnectTimer = null;
const OBS_AUTO_RETRY_MS = 4000;

function getObsSettings() {
  let disk = window.SWIFTSYNC_OBS_CONFIG;
  try {
    disk = loadObsWebSocketSettings();
    window.SWIFTSYNC_OBS_CONFIG = disk;
  } catch {
    disk = disk || null;
  }

  const savedIp = localStorage.getItem('obs_ip');
  const savedPort = localStorage.getItem('obs_port');
  const savedPassword = localStorage.getItem('obs_password') || '';

  // OBS config on disk wins over stale saved values (especially after network changes).
  const host = disk?.host || savedIp || '127.0.0.1';
  const port = disk?.port || savedPort || '4455';
  const password = disk?.password ?? savedPassword;

  return {
    host,
    port: String(port),
    password,
    serverEnabled: disk?.serverEnabled !== false,
    foundOnDisk: !!disk?.foundOnDisk,
    source: disk?.source || null,
    lanIp: disk?.lanIp || getPrimaryLanIp()
  };
}

function grabObsField(field) {
  const disk = loadObsWebSocketSettings();
  window.SWIFTSYNC_OBS_CONFIG = disk;
  const grabbed = getObsFieldFromDisk(field);

  if (field === 'host') {
    ipInput.value = grabbed.value;
    localStorage.removeItem('obs_ip');
  } else if (field === 'port') {
    portInput.value = grabbed.value;
    localStorage.removeItem('obs_port');
  } else if (field === 'password') {
    passwordInput.value = grabbed.value;
    localStorage.removeItem('obs_password');
  }

  if (obsController.config) {
    obsController.config = {
      host: ipInput.value.trim() || '127.0.0.1',
      port: portInput.value.trim() || '4455',
      password: passwordInput.value
    };
  }

  const lanIp = disk.lanIp || getPrimaryLanIp();
  let message = grabbed.hint;
  if (field === 'host' && grabbed.value === '127.0.0.1' && lanIp && lanIp !== '127.0.0.1') {
    message += ` — this PC is now ${lanIp} on your network`;
  }

  setStatus(message, grabbed.foundOnDisk ? '#00ff85' : '#f0c14b');
}

function applyObsSettingsToForm(settings = getObsSettings()) {
  ipInput.value = settings.host;
  portInput.value = settings.port;
  passwordInput.value = settings.password;
  return settings;
}

function refreshObsConnectionConfig() {
  return applyObsSettingsToForm(getObsSettings());
}

function clearObsAutoConnectTimer() {
  if (obsAutoConnectTimer) {
    clearTimeout(obsAutoConnectTimer);
    obsAutoConnectTimer = null;
  }
}

function scheduleObsAutoConnect(reason) {
  if (obsController.manualDisconnect || obsController.connected) return;
  if (obsAutoConnectTimer) return;
  obsAutoConnectTimer = setTimeout(() => {
    obsAutoConnectTimer = null;
    autoConnectObs(reason).catch(() => {});
  }, OBS_AUTO_RETRY_MS);
}

async function autoConnectObs(reason = 'startup') {
  if (obsController.manualDisconnect) return;
  if (obsController.connected || obsController.state === 'connecting') return;

  const settings = applyObsSettingsToForm(getObsSettings());

  if (settings.serverEnabled === false) {
    setStatus('OBS WebSocket is disabled — enable it in OBS → Tools → WebSocket Server Settings', '#f0c14b');
    scheduleObsAutoConnect('websocket-disabled');
    return;
  }

  const hint = settings.foundOnDisk
    ? 'Loaded OBS WebSocket settings — connecting…'
    : 'Connecting to OBS…';
  setStatus(reason === 'retry' ? 'Retrying OBS connection…' : hint, '#ccc');

  try {
    await obsController.connect(settings.host, settings.port, settings.password, true);
  } catch {
    setStatus(
      settings.foundOnDisk
        ? 'Waiting for OBS… (start OBS or check WebSocket settings)'
        : 'Cannot reach OBS — start OBS and enable WebSocket (Tools menu)',
      '#f0c14b'
    );
  }
}

// Logo (corner + Home hero)
(function initLogo() {
  const path = require('path');
  const fs = require('fs');
  const logoPath = path.join(__dirname, 'assets', 'Copilot_20260522_174446.png');
  if (!fs.existsSync(logoPath)) return;
  const dataUrl = `url("data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}")`;
  document.querySelectorAll('.swift-brand-logo').forEach((el) => {
    el.style.backgroundImage = dataUrl;
  });
})();

// Saved settings — refreshed from OBS config on connect
const startupObsSettings = applyObsSettingsToForm(getObsSettings());
if (startupObsSettings.foundOnDisk) {
  setObsInfo('Port & password loaded from OBS WebSocket settings');
}

// Clipboard support for Home fields (Electron fallback)
(function enableConnectInputClipboard() {
  const { clipboard } = require('electron');
  const inputs = document.querySelectorAll('#connect-screen input');

  inputs.forEach((input) => {
    input.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      const key = e.key.toLowerCase();

      if (key === 'v') {
        e.preventDefault();
        const text = clipboard.readText();
        if (!text) return;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        input.value = input.value.slice(0, start) + text.trim() + input.value.slice(end);
        const pos = start + text.trim().length;
        input.setSelectionRange(pos, pos);
        return;
      }

      if (key === 'c') {
        const start = input.selectionStart ?? 0;
        const end = input.selectionEnd ?? 0;
        if (start === end) return;
        e.preventDefault();
        clipboard.writeText(input.value.slice(start, end));
        return;
      }

      if (key === 'x') {
        const start = input.selectionStart ?? 0;
        const end = input.selectionEnd ?? 0;
        if (start === end) return;
        e.preventDefault();
        clipboard.writeText(input.value.slice(start, end));
        input.value = input.value.slice(0, start) + input.value.slice(end);
        input.setSelectionRange(start, start);
        return;
      }

      if (key === 'a') {
        e.preventDefault();
        input.select();
      }
    });
  });
})();

function setStatus(text, color = 'white') {
  if (statusText) {
    statusText.textContent = text;
    statusText.style.color = color;
  }
}

function setChatFeedback(text, color = '#f0c14b') {
  if (chatStatusLine) chatStatusLine.textContent = text;
  if (chatSigninFeedback) {
    chatSigninFeedback.textContent = text;
    chatSigninFeedback.style.color = color;
    chatSigninFeedback.style.borderColor =
      color === '#ff4444' ? '#633' : color === '#00ff85' ? '#1a4d32' : '#444';
  }
  setStatus(text, color);
}

function setChatPlatformSignInHint(platform, text, color = '#f0c14b') {
  setChatFeedback(text, color);
  const el = chatAccountEls[platform];
  if (el && text) {
    el.textContent = text;
    el.style.color = color;
  }
}

function setPill(el, label, ok) {
  if (!el) return;
  el.textContent = label;
  el.classList.toggle('ok', ok);
  el.classList.toggle('err', !ok);
}

function setObsInfo(text) {
  if (!obsInfoEl) return;
  obsInfoEl.textContent = text || '';
}

const VOLUME_DB_MIN = -100;
const VOLUME_DB_MAX = 20;
const VOLUME_DB_STEP = 0.1;

function clampVolumeDb(db) {
  const n = Number(db);
  if (Number.isNaN(n)) return 0;
  return Math.max(VOLUME_DB_MIN, Math.min(VOLUME_DB_MAX, n));
}

function formatVolumeDb(db) {
  const n = clampVolumeDb(db);
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)} dB`;
}

function clampVolume(mul) {
  const n = Number(mul);
  if (Number.isNaN(n)) return 1;
  return Math.max(0, Math.min(20, n));
}

function showTab(tabId) {
  activeTab = tabId;
  Object.entries(PANELS).forEach(([id, el]) => {
    if (!el) return;
    el.classList.toggle('panel-active', id === tabId);
  });
  if (pageViewport) pageViewport.scrollTop = 0;
  tabButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
}

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    userHasChosenTab = true;
    showTab(tab);
    if (tab !== 'connect' && tab !== 'chat' && !obsController.connected) {
      setStatus('Connect to OBS on Home for scenes, audio, and tools.', '#f0c14b');
      return;
    }
    if (tab === 'tools' && obsController.connected) refreshToolsUi().catch(console.error);
    if (tab === 'scenes' && obsController.connected) refreshScenes().catch(console.error);
    if (tab === 'audio' && obsController.connected) refreshGlobalAudio().catch(console.error);
    if (tab === 'chat') scrollChatToBottom();
  });
});

// ---------------------------------------------------------------------------
// OBS UI
// ---------------------------------------------------------------------------

obsController.on('state', ({ state, version, retryInMs }) => {
  if (state === 'connecting') setPill(pillObs, 'OBS: connecting…', false);
  else if (state === 'connected' && version) {
    setPill(pillObs, 'OBS: online', true);
    setObsInfo(`OBS ${version.obsVersion || '?'} · WS ${version.obsWebSocketVersion || '?'}`);
    refreshSetupChecklist();
  } else if (state === 'reconnecting') {
    setPill(pillObs, 'OBS: reconnecting…', false);
    if (retryInMs) setStatus(`OBS reconnecting in ${Math.round(retryInMs / 1000)}s…`, '#f0c14b');
  } else {
    setPill(pillObs, 'OBS: offline', false);
    setObsInfo('');
  }
});

obsController.on('connected', async () => {
  clearObsAutoConnectTimer();
  setStatus('Connected!', '#00ff85');
  refreshSetupChecklist();
  reconnectBtn.style.display = 'block';
  localStorage.setItem('obs_ip', ipInput.value);
  localStorage.setItem('obs_port', portInput.value);
  localStorage.setItem('obs_password', passwordInput.value);
  await refreshScenes();
  await refreshToolsUi();
  await refreshGlobalAudio();
  await pushObsStateToMobile();
  scheduleAutoChatConnect('obs');
  if (!userHasChosenTab && activeTab === 'connect') {
    showTab('scenes');
  }
});

obsController.on('reconnected', async () => {
  setStatus('Reconnected to OBS', '#00ff85');
  reconnectBtn.style.display = 'block';
  await refreshScenes();
  await refreshToolsUi();
  await refreshGlobalAudio();
  await pushObsStateToMobile();
  scheduleAutoChatConnect('obs');
});

obsController.on('connectionLost', () => {
  setStatus('OBS disconnected — reconnecting…', '#f0c14b');
  reconnectBtn.style.display = 'block';
  sendToMobile({ type: 'obsDisconnected' });
});

obsController.on('disconnected', () => {
  sendToMobile({ type: 'obsDisconnected' });
  setStatus('Disconnected — click Connect or Reconnect', '#888');
  sceneListEl.innerHTML = '';
  canvasOptions = [];
  sceneLinks = [];
  mainCanvasUuid = null;
  verticalCanvasUuid = null;
  aitumCanvasCache = [];
  lastVerticalFetchDebug = null;
  lastVerticalEntries = [];
  lastVerticalScenes = [];
  activeSceneName = null;
  if (linkedSourcesPanelEl) linkedSourcesPanelEl.innerHTML = '';
  if (linkedScenesHeaderEl) linkedScenesHeaderEl.textContent = 'Select a scene above';
  renderLinkedSourcesPanel([]);
  if (obsController.manualDisconnect) {
    showTab('connect');
    userHasChosenTab = false;
  }
  if (!obsController.manualDisconnect) scheduleObsAutoConnect('retry');
});

obsController.on('error', (msg) => setStatus(msg, '#ff4444'));

// ── Live canvas preview ──────────────────────────────────────────────────────
// Periodically capture a thumbnail of the active program scene and push to PC
// UI + mobile clients. Works any time OBS is connected — streaming not required.
let previewTimer = null;
let previewEnabled = true;
const PREVIEW_INTERVAL_MS = 1500;
let lastPreviewSceneName = null;

async function capturePreviewOnce() {
  if (!obsController.connected || !previewEnabled) return;
  const link = getActiveSceneLink();
  let sceneName = link?.main?.sceneName || activeSceneName;
  if (!sceneName) {
    // activeSceneName not populated yet — ask OBS directly
    try {
      const current = await obsController.getCurrentProgramScene(null);
      sceneName = current?.sceneName || null;
    } catch { /* ignore */ }
  }
  if (!sceneName) return;
  const dataUrl = await obsController.getSourceScreenshot(sceneName, {
    width: 480,
    height: 270,
    format: 'jpeg',
    quality: 50
  });
  if (!dataUrl) return;
  lastPreviewSceneName = sceneName;
  updateCanvasPreviewUi(sceneName, dataUrl);
  sendToMobile({ type: 'canvasPreview', sceneName, image: dataUrl });
}

function startCanvasPreviewLoop() {
  if (previewTimer) return;
  if (previewEnabled) capturePreviewOnce().catch(() => {});
  previewTimer = setInterval(() => {
    capturePreviewOnce().catch(() => {});
  }, PREVIEW_INTERVAL_MS);
}

function stopCanvasPreviewLoop() {
  if (previewTimer) {
    clearInterval(previewTimer);
    previewTimer = null;
  }
  updateCanvasPreviewUi(null, null);
}

function setPreviewEnabled(enabled) {
  previewEnabled = enabled;
  const btn = document.getElementById('preview-toggle-btn');
  if (btn) btn.textContent = enabled ? 'Preview: On' : 'Preview: Off';
  sendToMobile({ type: 'previewToggle', enabled });
  if (enabled) {
    capturePreviewOnce().catch(() => {});
  } else {
    updateCanvasPreviewUi(null, null);
  }
}

const previewToggleBtn = document.getElementById('preview-toggle-btn');
if (previewToggleBtn) {
  previewToggleBtn.addEventListener('click', () => setPreviewEnabled(!previewEnabled));
}

function updateCanvasPreviewUi(sceneName, dataUrl) {
  const imgEl = document.getElementById('canvas-preview-img');
  const wrapEl = document.getElementById('canvas-preview');
  if (!imgEl || !wrapEl) return;
  if (dataUrl) {
    imgEl.src = dataUrl;
    wrapEl.classList.add('has-image');
  } else {
    imgEl.removeAttribute('src');
    wrapEl.classList.remove('has-image');
  }
}

const VERTICAL_MAPPING_KEY = 'swiftsync.verticalSceneMap';

function loadVerticalSceneMap() {
  try {
    const raw = localStorage.getItem(VERTICAL_MAPPING_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function saveVerticalSceneMap(map) {
  try {
    localStorage.setItem(VERTICAL_MAPPING_KEY, JSON.stringify(map || {}));
  } catch (e) {
    console.warn('[SwiftSync vertical] saveVerticalSceneMap failed', e);
  }
}

function getMappedVerticalName(mainName) {
  if (!mainName) return null;
  const map = loadVerticalSceneMap();
  const v = map[mainName];
  return v && typeof v === 'string' && v.trim() ? v.trim() : null;
}

function renderVerticalMappingUi(mainSceneNames = []) {
  const section = document.getElementById('vertical-mapping-section');
  const list = document.getElementById('vertical-mapping-list');
  if (!section || !list) return;

  if (!mainSceneNames.length || !dualCanvasMode) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  const map = loadVerticalSceneMap();
  list.innerHTML = '';

  mainSceneNames.forEach((mainName) => {
    const mainEl = document.createElement('div');
    mainEl.className = 'vmap-main';
    mainEl.textContent = mainName;

    const arrowEl = document.createElement('div');
    arrowEl.className = 'vmap-arrow';
    arrowEl.textContent = '→';

    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'vmap-vert';
    inputEl.placeholder = 'auto (leave blank)';
    inputEl.dataset.mainName = mainName;
    inputEl.value = map[mainName] || '';

    list.appendChild(mainEl);
    list.appendChild(arrowEl);
    list.appendChild(inputEl);
  });
}

function bindVerticalMappingActions() {
  const saveBtn = document.getElementById('vertical-mapping-save');
  const clearBtn = document.getElementById('vertical-mapping-clear');
  if (saveBtn && !saveBtn.dataset.bound) {
    saveBtn.dataset.bound = '1';
    saveBtn.addEventListener('click', () => {
      const inputs = document.querySelectorAll('#vertical-mapping-list input.vmap-vert');
      const next = {};
      inputs.forEach((el) => {
        const main = el.dataset.mainName;
        const vert = (el.value || '').trim();
        if (main && vert) next[main] = vert;
      });
      saveVerticalSceneMap(next);
      saveBtn.textContent = 'Saved! Refreshing…';
      setTimeout(() => {
        saveBtn.textContent = 'Save mapping';
      }, 1200);
      if (typeof refreshScenes === 'function') refreshScenes().catch(console.error);
    });
  }
  if (clearBtn && !clearBtn.dataset.bound) {
    clearBtn.dataset.bound = '1';
    clearBtn.addEventListener('click', () => {
      saveVerticalSceneMap({});
      const inputs = document.querySelectorAll('#vertical-mapping-list input.vmap-vert');
      inputs.forEach((el) => { el.value = ''; });
      if (typeof refreshScenes === 'function') refreshScenes().catch(console.error);
    });
  }
}
bindVerticalMappingActions();

function updateCanvasDiagnostic(info) {
  const wrap = document.getElementById('canvas-diagnostic');
  const text = document.getElementById('canvas-diagnostic-text');
  if (!wrap || !text) return;
  wrap.style.display = 'block';
  wrap.classList.remove('success', 'warning');

  if (info.rawCount === 0) {
    wrap.classList.add('warning');
    text.textContent =
      'OBS returned no canvases via GetCanvasList — multi-canvas plugin (SE.Live/Aitum) may not be active. Single-canvas mode.';
    return;
  }

  const allNames = (info.canvases || []).map((c) => `"${c.name}"`).join(', ');

  if (info.dualCanvasMode && info.vertical) {
    const mode = info.verticalMode || 'enumerated';
    let modeText = '';
    if (mode === 'probed') {
      modeText = ' (matched by probing — SE.Live linked scenes)';
    } else if (mode === 'synthetic') {
      modeText =
        ' (assumed identical names — if your vertical scenes have different names, sources may appear empty)';
    }

    if (info.verticalSceneCount === 0 && mode !== 'synthetic') {
      wrap.classList.add('warning');
      text.textContent =
        `Found vertical canvas "${info.vertical.name}" but no vertical scenes are accessible via OBS API. ` +
        `If you have vertical scenes in the SE.Live dock, this is a known SE.Live limitation. ` +
        `Try: (1) renaming vertical scenes to match main scene names, or (2) use Aitum Vertical instead.`;
    } else {
      wrap.classList.add('success');
      text.textContent =
        `Dual canvas detected — main: "${info.main?.name}" (${info.mainSceneCount} scenes) · ` +
        `vertical: "${info.vertical.name}" (${info.verticalSceneCount} scenes)${modeText}. ` +
        `All canvases: ${allNames}`;
    }
  } else if (info.canvases?.length >= 2) {
    wrap.classList.add('warning');
    text.textContent =
      `Found ${info.canvases.length} canvases but couldn't identify a vertical one. ` +
      `All canvases: ${allNames}. ` +
      `(Pair-detection picks based on names like "Vertical", "V-", "StreamElements". Click Refresh on Scenes tab if the vertical canvas was just added.)`;
  } else {
    text.textContent = `Single canvas: ${allNames || '"Main"'}.`;
  }
}

obsController.on('connected', () => startCanvasPreviewLoop());
obsController.on('disconnected', () => stopCanvasPreviewLoop());

function isSceneInActiveLink(sceneName) {
  if (!sceneName || !activeSceneName) return false;
  const link = getActiveSceneLink();
  if (!link) return sceneName === activeSceneName;
  return (
    sceneName === link.main.sceneName ||
    sceneName === link.vertical?.sceneName
  );
}

let sceneSwitchInProgress = false;

obsController.on('programSceneChanged', (data) => {
  const sceneName = data.sceneName;
  const mainLink = sceneLinks.find((l) => l.main.sceneName === sceneName);
  const verticalOnlyLink = sceneLinks.find(
    (l) => l.vertical?.sceneName === sceneName && l.main.sceneName !== sceneName
  );

  if (mainLink) {
    activeSceneName = sceneName;
    highlightActiveScene(sceneName);
  } else if (verticalOnlyLink) {
    activeSceneName = verticalOnlyLink.main.sceneName;
    highlightActiveScene(activeSceneName);
  } else {
    activeSceneName = sceneName;
    highlightActiveScene(sceneName);
  }

  if (!sceneSwitchInProgress) {
    refreshSceneSources().catch(console.error);
  }

  const link = getActiveSceneLink();
  sendToMobile({
    type: 'sceneChanged',
    sceneName: activeSceneName,
    linkedSceneName: link?.vertical?.sceneName || null
  });
});

obsController.on('sceneListChanged', () => {
  if (obsController.connected) refreshScenes().catch(console.error);
});

obsController.on('sceneItemsChanged', (data) => {
  if (!data?.sceneName || isSceneInActiveLink(data.sceneName)) {
    refreshSceneSources().catch(console.error);
  }
});

obsController.on('canvasesChanged', () => {
  if (obsController.connected) refreshScenes().catch(console.error);
});

obsController.on('audioInputsChanged', () => {
  if (obsController.connected) refreshGlobalAudio().catch(console.error);
});

obsController.on('inputVolumeChanged', (d) => {
  updateSourceVolumeUi(d.inputName, d.inputVolumeDb);
  sendToMobile({
    type: 'volumeChanged',
    inputName: d.inputName,
    volumeDb: d.inputVolumeDb,
    volumeMul: d.inputVolumeMul ?? null
  });
});
obsController.on('inputMuteChanged', (d) => {
  updateSourceMuteUi(d.inputName, d.inputMuted);
  sendToMobile({
    type: 'muteChanged',
    inputName: d.inputName,
    muted: !!d.inputMuted
  });
});

obsController.on('streamStateChanged', (d) => {
  setToolState(stateStream, d.outputActive, 'LIVE', 'offline', 'live');
  if (streamToggleBtn) streamToggleBtn.classList.toggle('live', d.outputActive);
  sendToMobile({ type: 'streamState', active: d.outputActive });
  if (d.outputActive) {
    scheduleAutoChatConnect('stream-live');
    startChatKeepAlive();
    if (obsController.isOnline) refreshScenes().catch(() => {});
  }
});

obsController.on('recordStateChanged', (d) => {
  setToolState(stateRecord, d.outputActive, 'ON', 'off', 'on');
  if (recordToggleBtn) recordToggleBtn.classList.toggle('live', d.outputActive);
  sendToMobile({ type: 'recordState', active: d.outputActive });
});

obsController.on('replayStateChanged', (d) => {
  setToolState(stateReplay, d.outputActive, 'ON', 'off', 'on');
  if (replayToggleBtn) replayToggleBtn.classList.toggle('live', d.outputActive);
});

obsController.on('vcamStateChanged', (d) => {
  setToolState(stateVcam, d.outputActive, 'ON', 'off', 'on');
  if (vcamToggleBtn) vcamToggleBtn.classList.toggle('live', d.outputActive);
});

async function connectOBS(isReconnect = false) {
  obsController.manualDisconnect = false;
  clearObsAutoConnectTimer();
  const settings = applyObsSettingsToForm(getObsSettings());
  setStatus(isReconnect ? 'Reconnecting…' : 'Connecting…', '#ccc');
  try {
    await obsController.connect(settings.host, settings.port, settings.password, true);
  } catch { /* ObsController retries with refreshed config */ }
}

// Linked scenes (Main + SE.Live vertical canvas)
function resolveCanvasOptions(rawCanvases) {
  if (!rawCanvases.length) {
    return [{ uuid: null, name: 'Main', isMain: true, isVertical: false, label: 'Main', index: 0 }];
  }
  return rawCanvases.map((c, index) => ({ ...c, label: c.name, index }));
}

function mergeCanvasOptionsWithAitum(obsOptions, aitumCanvases) {
  const merged = obsOptions.map((c) => ({ ...c }));
  for (const ac of aitumCanvases) {
    const byUuid = ac.uuid ? merged.find((c) => c.uuid === ac.uuid) : null;
    const byName = merged.find(
      (c) => c.name?.toLowerCase() === ac.name?.toLowerCase()
    );
    if (byUuid) {
      Object.assign(byUuid, {
        name: ac.name || byUuid.name,
        width: ac.width ?? byUuid.width,
        height: ac.height ?? byUuid.height,
        isVertical: byUuid.isVertical || ac.isVertical,
        fromAitum: true
      });
    } else if (byName) {
      byName.uuid = ac.uuid || byName.uuid;
      byName.width = ac.width ?? byName.width;
      byName.height = ac.height ?? byName.height;
      byName.isVertical = byName.isVertical || ac.isVertical;
      byName.fromAitum = true;
    } else {
      merged.push({ ...ac, label: ac.name, index: merged.length });
    }
  }
  return merged.map((c, index) => ({ ...c, index }));
}

function pickMainAndVerticalCanvases(options) {
  if (!options.length) return { main: null, vertical: null };
  if (options.length === 1) return { main: options[0], vertical: null };

  const byLandscapeSize = (c) => c.width && c.height && c.width >= c.height * 1.02;
  const byVerticalSize = (c) => c.width && c.height && c.height > c.width * 1.02;

  const main =
    options.find((c) => c.isMain && !c.isVertical) ||
    options.find((c) => isLikelyLandscapeCanvasName(c.name)) ||
    options.find((c) => byLandscapeSize(c) && !c.isVertical) ||
    options.find((c) => !c.isVertical && !isSeliveVerticalCanvasName(c.name)) ||
    options.find((c) => c.isMain) ||
    options[0];

  const vertical =
    options.find((c) => c !== main && isSeliveVerticalCanvasName(c.name)) ||
    options.find((c) => c !== main && /^vertical$/i.test(c.name)) ||
    options.find((c) => c !== main && /^portrait$/i.test(c.name)) ||
    options.find((c) => c !== main && /selive|se\.live/i.test(c.name)) ||
    options.find((c) => c !== main && c.isVertical) ||
    options.find((c) => c !== main && byVerticalSize(c)) ||
    options.find(
      (c) =>
        c !== main &&
        /vertical|portrait|9:16|shorts|tiktok|mobile|phone/i.test(c.name)
    ) ||
    options.find((c) => c !== main && !isLikelyLandscapeCanvasName(c.name)) ||
    options.find((c) => c !== main) ||
    null;

  if (main && vertical && main === vertical) {
    const altVertical = options.find((c) => c !== main && (c.isVertical || byVerticalSize(c)));
    if (altVertical) return { main, vertical: altVertical };
  }

  return { main, vertical };
}

function resolveCanvasPair(options) {
  const { main, vertical } = pickMainAndVerticalCanvases(options);
  return {
    mainUuid: main?.uuid ?? null,
    verticalUuid: vertical?.uuid ?? null,
    mainLabel: main?.name || 'Main',
    verticalLabel: vertical?.name || 'Vertical'
  };
}

function getVerticalCanvasUuid() {
  if (verticalCanvasUuid && verticalCanvasUuid !== mainCanvasUuid) return verticalCanvasUuid;

  const picked = pickMainAndVerticalCanvases(canvasOptions);
  const candidate = picked.vertical?.uuid;
  if (candidate && candidate !== mainCanvasUuid) {
    verticalCanvasUuid = candidate;
    return candidate;
  }

  for (const canvas of canvasOptions) {
    const uuid = canvas.uuid;
    if (uuid && uuid !== mainCanvasUuid && canvas !== picked.main) {
      verticalCanvasUuid = uuid;
      return uuid;
    }
  }

  return null;
}

function verticalCanvasUuidForLink(link) {
  const mainUuid = link?.main?.canvasUuid ?? mainCanvasUuid ?? null;
  const fromLink = link?.vertical?.canvasUuid;
  if (fromLink && fromLink !== mainUuid) return fromLink;
  return getVerticalCanvasUuid();
}

function sceneEntryName(entry) {
  return typeof entry === 'string' ? entry : entry?.sceneName || null;
}

function sceneEntryUuid(entry) {
  return typeof entry === 'object' && entry?.sceneUuid ? entry.sceneUuid : null;
}

function findSceneEntry(entries, sceneName) {
  if (!sceneName || !entries?.length) return null;
  return entries.find((entry) => sceneEntryName(entry) === sceneName) || null;
}

function getCanvasNameForUuid(canvasUuid) {
  if (!canvasUuid) return null;
  const match = canvasOptions.find((c) => c.uuid === canvasUuid);
  return match?.name || null;
}

function verticalCanvasNameForLink(link) {
  const fromLink = link?.vertical?.canvasUuid;
  const uuid = fromLink && fromLink !== link?.main?.canvasUuid ? fromLink : getVerticalCanvasUuid();
  return getCanvasNameForUuid(uuid);
}

async function resolveSceneUuidForCanvas(sceneName, canvasUuid, canvasName = null) {
  if (!sceneName) return null;
  try {
    const list = await obsController.getSceneList(canvasUuid || undefined);
    const match = (list.scenes || []).find(
      (s) => (s.sceneName || s.name) === sceneName
    );
    if (match) return match?.sceneUuid || match?.uuid || match?.scene_uuid || null;
  } catch {
    /* OBS GetSceneList failed — optional Aitum fallback below */
  }
  const aitumRef = canvasName || canvasUuid;
  if (aitumRef) {
    try {
      const aitumScenes = await obsController.getAitumScenes(aitumRef);
      const match = aitumScenes.find((s) => s.sceneName === sceneName);
      if (match?.sceneUuid) return match.sceneUuid;
    } catch {
      /* Aitum vendor unavailable */
    }
  }
  return null;
}

async function tryAitumGetScenes(canvasRef) {
  const refs = [];
  const addRef = (ref) => {
    if (ref != null && ref !== '') refs.push(ref);
  };

  if (typeof canvasRef === 'object' && canvasRef) {
    addRef(canvasRef.uuid);
    addRef(canvasRef.name);
  } else {
    addRef(canvasRef);
  }

  const picked = pickMainAndVerticalCanvases(canvasOptions).vertical;
  addRef(picked?.uuid);
  addRef(picked?.name);
  for (const hint of VERTICAL_CANVAS_NAME_HINTS) addRef(hint);
  for (const c of aitumCanvasCache) {
    addRef(c.uuid);
    addRef(c.name);
  }

  const seen = new Set();
  for (const ref of refs) {
    const key = String(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const scenes = await obsController.getAitumScenes(ref);
    if (scenes.length) {
      const aitumCanvas =
        aitumCanvasCache.find(
          (c) => c.uuid === ref || c.name?.toLowerCase() === String(ref).toLowerCase()
        ) || null;
      return {
        scenes,
        canvasRef: ref,
        canvasUuid: aitumCanvas?.uuid || (typeof ref === 'string' && /^[0-9a-f-]{32,}$/i.test(ref) ? ref : picked?.uuid || null),
        canvasName: aitumCanvas?.name || (typeof ref === 'string' && !/^[0-9a-f-]{32,}$/i.test(ref) ? ref : picked?.name || null)
      };
    }
  }

  return { scenes: [], canvasRef: null, canvasUuid: null, canvasName: null };
}

function verticalSceneAtLinkIndex(scenes, linkIndex, sceneName, sceneUuid) {
  if (sceneName) {
    const exact = scenes.find((s) => s.sceneName === sceneName);
    if (exact) return exact;

    const caseInsensitive = scenes.find(
      (s) => s.sceneName?.toLowerCase() === sceneName.toLowerCase()
    );
    if (caseInsensitive) return caseInsensitive;
  }

  if (sceneUuid) {
    const byUuid = scenes.find((s) => s.sceneUuid === sceneUuid);
    if (byUuid) return byUuid;
  }

  if (linkIndex >= 0 && linkIndex < scenes.length) {
    return scenes[linkIndex];
  }

  if (sceneName) {
    const bySuffix = scenes.find((s) => verticalSceneMatchesMain(s.sceneName, stripVerticalSuffix(sceneName)));
    if (bySuffix) return bySuffix;
  }

  return null;
}

async function loadVerticalSceneEntries(verticalCanvas, mainEntries = []) {
  if (!verticalCanvas) return [];

  const uuid = verticalCanvas.uuid || null;
  let entries = await obsController.getScenesForCanvas(verticalCanvas, { allowMainFallback: false });

  if (!entries.length && uuid) {
    try {
      const list = await obsController.getSceneList(uuid);
      entries = ObsController.mapScenesFromList(list);
    } catch (e) {
      console.warn('[SwiftSync vertical] loadVerticalSceneEntries GetSceneList', e.message || e);
    }
  }

  if (!entries.length) {
    try {
      entries = await obsController.getAitumScenes(uuid || verticalCanvas.name);
    } catch {
      /* SE.Live vendor optional */
    }
  }

  // SE.Live often hides its vertical scenes from the standard GetSceneList API.
  // As a last resort, probe the vertical canvas with each main scene name —
  // SE.Live's most common pattern is identical scene names on both canvases.
  // Also honor any user-defined manual mapping (overrides auto-detection).
  if (!entries.length && uuid && mainEntries.length) {
    const userMap = loadVerticalSceneMap();
    const manualCount = Object.keys(userMap).filter((k) => userMap[k]).length;
    console.log(
      `[SwiftSync vertical] GetSceneList returned 0 for vertical canvas — probing ${mainEntries.length} main scenes ` +
        `by name${manualCount ? ` (with ${manualCount} manual override(s))` : ''}…`
    );
    for (const mainEntry of mainEntries) {
      const mainName = sceneEntryName(mainEntry);
      if (!mainName) continue;
      const manualName = userMap[mainName];
      const candidates = manualName
        ? [manualName]
        : [mainName, ...verticalNameCandidatesForMain(mainName)];
      let matched = false;
      for (const candidate of candidates) {
        try {
          const items = await obsController.call('GetSceneItemList', {
            sceneName: candidate,
            canvasUuid: uuid
          });
          if (items?.sceneItems) {
            entries.push({
              sceneName: candidate,
              sceneUuid: null,
              canvasUuid: uuid,
              _probed: true,
              _manuallyMapped: !!manualName,
              _pairedToMainName: mainName
            });
            matched = true;
            break;
          }
        } catch {
          /* try next candidate */
        }
      }
      if (!matched) {
        if (manualName) {
          // User explicitly mapped this — trust them even if probe failed
          // (manual name may exist on a canvas the probe didn't reach).
          entries.push({
            sceneName: manualName,
            sceneUuid: null,
            canvasUuid: uuid,
            _probed: false,
            _manuallyMapped: true,
            _pairedToMainName: mainName
          });
          console.log(
            `[SwiftSync vertical] Manual mapping "${mainName}" → "${manualName}" kept despite probe miss`
          );
        }
      }
    }
    if (entries.length) {
      console.log(
        `[SwiftSync vertical] Probe found ${entries.length} vertical scene(s) by name match`
      );
    }
  }

  return entries;
}

function verticalSceneUuidLooksLikeMain(sceneUuid, link) {
  if (!sceneUuid || !link?.main?.sceneUuid) return false;
  return sceneUuid === link.main.sceneUuid;
}

async function resolveVerticalSceneForLink(link, linkIndex = -1) {
  const canvasUuid = verticalCanvasUuidForLink(link);
  const canvasName = getCanvasNameForUuid(canvasUuid);
  const sceneNameFromLink = link?.vertical?.sceneName || null;
  let sceneUuidFromLink = link?.vertical?.sceneUuid || null;

  if (verticalSceneUuidLooksLikeMain(sceneUuidFromLink, link)) {
    sceneUuidFromLink = null;
  }

  const finish = (sceneName, sceneUuid, source = 'link') => {
    if (!sceneName && !sceneUuid) return null;
    let uuid = sceneUuid;
    if (verticalSceneUuidLooksLikeMain(uuid, link)) uuid = null;
    console.log(
      `[SwiftSync vertical] resolved (${source}) canvas="${canvasName || '?'}" scene="${sceneName || '?'}" uuid=${(uuid || '?').slice?.(0, 8) || '?'}…`
    );
    return {
      sceneName: sceneName || sceneNameFromLink,
      sceneUuid: uuid || null,
      canvasUuid: canvasUuid || link?.vertical?.canvasUuid || null,
      canvasName
    };
  };

  // SE.Live: GetSceneList(vertical) often returns 0 scenes — linked v-name may differ (brbv vs brb v)
  if (sceneNameFromLink && canvasUuid) {
    const mainName = link?.main?.sceneName || stripVerticalSuffix(sceneNameFromLink);
    const probed = await probeVerticalSceneNameOnCanvas(mainName, canvasUuid, [sceneNameFromLink]);
    const resolvedName = probed || sceneNameFromLink;

    let uuid = sceneUuidFromLink;
    if (!uuid) {
      uuid = await resolveSceneUuidForCanvas(resolvedName, canvasUuid, canvasName);
    }
    if (verticalSceneUuidLooksLikeMain(uuid, link)) uuid = null;

    return finish(resolvedName, uuid, probed ? 'probe-vertical-name' : 'link-vertical-name');
  }

  if (canvasUuid) {
    try {
      const list = await obsController.getSceneList(canvasUuid, canvasName);
      const scenes = ObsController.mapScenesFromList(list);

      if (scenes.length) {
        let match = verticalSceneAtLinkIndex(
          scenes,
          linkIndex,
          sceneNameFromLink,
          sceneUuidFromLink
        );

        if (!match && sceneUuidFromLink && !verticalSceneUuidLooksLikeMain(sceneUuidFromLink, link)) {
          match = scenes.find((s) => s.sceneUuid === sceneUuidFromLink) || null;
        }

        if (match) return finish(match.sceneName, match.sceneUuid, 'GetSceneList');
      }
    } catch (e) {
      console.warn('[SwiftSync vertical] GetSceneList failed', canvasName || canvasUuid, e.message || e);
    }
  }

  if (linkIndex >= 0 && lastVerticalEntries[linkIndex]) {
    const entry = lastVerticalEntries[linkIndex];
    const name = sceneEntryName(entry);
    const uuid = sceneEntryUuid(entry);
    if (name) return finish(name, verticalSceneUuidLooksLikeMain(uuid, link) ? null : uuid, 'lastVerticalEntries');
  }

  return null;
}

function shouldShowVerticalSourcePanel(link) {
  return !!(dualCanvasMode || getVerticalCanvasUuid() || link?.vertical?.sceneName);
}

function buildEmptyVerticalPanel(link, linkIndex, verticalLabel, hint) {
  const sceneName =
    link?.vertical?.sceneName ||
    lastVerticalScenes[linkIndex] ||
    '(no vertical scene)';
  const canvasUuid = verticalCanvasUuidForLink(link) || getVerticalCanvasUuid();
  return {
    side: 'vertical',
    title: verticalLabel,
    sceneName,
    sceneUuid: link?.vertical?.sceneUuid || null,
    canvasUuid,
    canvasName: getCanvasNameForUuid(canvasUuid),
    visual: [],
    audio: [],
    emptyHint: hint
  };
}

function panelSourceKeySet(panel) {
  return new Set(
    [...(panel?.visual || []), ...(panel?.audio || [])].map(
      (s) => `${s.sceneItemId}:${s.sourceName}`
    )
  );
}

function panelItemCount(panel) {
  return (panel?.visual?.length || 0) + (panel?.audio?.length || 0);
}

function panelHasVerticalSpecificSources(panel) {
  return [...(panel?.visual || []), ...(panel?.audio || [])].some((s) =>
    ObsController.looksLikeVerticalAudioName(s.sourceName)
  );
}

function verticalPanelLooksLikeMainDuplicate(mainPanel, result) {
  if (!mainPanel || !result) return false;
  const mainItems = [...(mainPanel.visual || []), ...(mainPanel.audio || [])];
  const candItems = [...(result.visual || []), ...(result.audio || [])];
  if (!candItems.length || !mainItems.length) return false;

  // Same source names on vertical are normal for SE.Live — only duplicate if item IDs match too.
  const mainKeys = panelSourceKeySet(mainPanel);
  const matches = candItems.filter((s) => mainKeys.has(`${s.sceneItemId}:${s.sourceName}`));
  return matches.length === candItems.length;
}

function scoreVerticalPanelResult(mainPanel, result) {
  if (!result || panelItemCount(result) === 0) return -1;
  let score = panelItemCount(result);
  if (panelHasVerticalSpecificSources(result)) score += 100;

  const mainNames = new Set(
    [...(mainPanel?.visual || []), ...(mainPanel?.audio || [])].map((s) => s.sourceName)
  );
  for (const s of [...(result.visual || []), ...(result.audio || [])]) {
    if (!mainNames.has(s.sourceName)) score += 10;
  }

  if (verticalPanelLooksLikeMainDuplicate(mainPanel, result)) score -= 1000;
  return score;
}

function isPlausibleVerticalPanel(mainPanel, result, strategy = {}) {
  const count = panelItemCount(result);
  if (count === 0) return false;
  const vCanvas = getVerticalCanvasUuid();
  const strategyCanvas = strategy.canvasUuid ?? null;
  // SE.Live: any items returned with vertical canvasUuid are real vertical sources.
  if (vCanvas && strategyCanvas === vCanvas) return true;
  return scoreVerticalPanelResult(mainPanel, result) > 0;
}

function annotateVerticalSourceEntries(items, fallbackSceneName, vUuid, vCanvasName = null) {
  const canvasName = vCanvasName || getCanvasNameForUuid(vUuid) || null;
  return (items || []).map((s) => ({
    ...s,
    sceneName: s.sceneName || fallbackSceneName,
    canvasUuid: vUuid || s.canvasUuid || null,
    canvasName: canvasName || s.canvasName || null,
    sceneUuid: s.sceneUuid || null
  }));
}

function panelLooksLikeDuplicate(mainPanel, candidatePanel) {
  if (!mainPanel || !candidatePanel) return false;
  if (candidatePanel.side === 'vertical') return false;

  const vCanvas = getVerticalCanvasUuid();
  const mCanvas = mainPanel.canvasUuid ?? mainCanvasUuid;
  const candCanvas = candidatePanel.canvasUuid ?? null;

  // SE.Live vertical scenes often mirror main sources — never dedupe across canvases.
  if (
    vCanvas &&
    candCanvas &&
    candCanvas === vCanvas &&
    candCanvas !== mCanvas
  ) {
    return false;
  }
  if (
    candidatePanel.side === 'vertical' &&
    candCanvas &&
    mCanvas &&
    candCanvas !== mCanvas
  ) {
    return false;
  }

  const mainItems = [...(mainPanel.visual || []), ...(mainPanel.audio || [])];
  const candItems = [...(candidatePanel.visual || []), ...(candidatePanel.audio || [])];
  if (!candItems.length) return false;

  const mainKeys = panelSourceKeySet(mainPanel);
  const matches = candItems.filter((s) => mainKeys.has(`${s.sceneItemId}:${s.sourceName}`));
  const allCandMatchMain = matches.length === candItems.length;

  return allCandMatchMain && mainItems.length > 0;
}

function strategyLabel(strategy) {
  const parts = [];
  if (strategy.sceneUuid) parts.push(`uuid=${String(strategy.sceneUuid).slice(0, 8)}…`);
  if (strategy.sceneName) parts.push(`scene="${strategy.sceneName}"`);
  if (strategy.canvasUuid) parts.push(`canvasUuid=${String(strategy.canvasUuid).slice(0, 8)}…`);
  if (strategy.canvasName) parts.push(`canvas="${strategy.canvasName}"`);
  return parts.join(' ') || 'default';
}

async function tryAitumCurrentScene(canvasUuid, canvasName) {
  const refs = [canvasName, canvasUuid, ...VERTICAL_CANVAS_NAME_HINTS].filter(Boolean);
  for (const ref of [...new Set(refs)]) {
    const res = await obsController.getAitumCurrentScene(ref);
    if (res?.sceneName || res?.sceneUuid) return res;
  }
  return null;
}

function verticalCanvasNameCandidates(task) {
  const names = new Set(VERTICAL_CANVAS_NAME_HINTS);
  if (task.canvasName) names.add(task.canvasName);
  if (task.verticalScene?.canvasName) names.add(task.verticalScene.canvasName);
  for (const c of canvasOptions) {
    if (c.name && c !== pickMainAndVerticalCanvases(canvasOptions).main) {
      names.add(c.name);
    }
    if (c.isVertical && c.name) names.add(c.name);
  }
  return [...names];
}

function verticalCanvasUuidCandidates(task) {
  const uuids = new Set();
  if (task.canvasUuid) uuids.add(task.canvasUuid);
  if (task.verticalScene?.canvasUuid) uuids.add(task.verticalScene.canvasUuid);
  const picked = pickMainAndVerticalCanvases(canvasOptions).vertical;
  if (picked?.uuid) uuids.add(picked.uuid);
  const vUuid = getVerticalCanvasUuid();
  if (vUuid) uuids.add(vUuid);
  return [...uuids];
}

function stripVerticalSuffix(name) {
  return String(name)
    .trim()
    .replace(/\s+[vV]\s*$/i, '')
    .replace(/[vV]\s*$/i, '')
    .trim();
}

/** SE.Live links vertical scenes as main name + "V" (e.g. game ↔ gameV, reactions ↔ reactionsV). */
function verticalSceneMatchesMain(verticalName, mainName) {
  const v = String(verticalName || '').trim();
  const m = String(mainName || '').trim();
  if (!v || !m) return false;

  if (v === m) return true;
  if (v === `${m}V` || v === `${m}v`) return true;
  if (v === `${m} V` || v === `${m} v`) return true;

  const vl = v.toLowerCase();
  const ml = m.toLowerCase();

  if (vl === ml) return true;
  if (vl === `${ml}v`) return true;
  if (vl === `${ml} v`) return true;
  if (stripVerticalSuffix(vl) === ml) return true;
  if (normalizeSceneKey(stripVerticalSuffix(v)) === normalizeSceneKey(m)) return true;

  return false;
}

function verticalNameCandidatesForMain(mainName) {
  const m = String(mainName || '').trim();
  if (!m) return [];
  const base = stripVerticalSuffix(m);
  return [
    `${base}V`,
    `${base}v`,
    `${base} V`,
    `${base} v`,
    m,
    base,
    `${base} (V)`,
    `${base} (v)`,
    `${base} (vertical)`,
    // Prefix variants (common in SE.Live and Aitum)
    `V ${base}`,
    `v ${base}`,
    `V-${base}`,
    `V - ${base}`,
    `V_${base}`,
    `Vertical ${base}`,
    `vertical ${base}`,
    `Vert ${base}`,
    `[V] ${base}`,
    `[v] ${base}`
  ];
}

function sceneListErrorLooksLikeMissingScene(err) {
  const msg = String(err?.message || err).toLowerCase();
  return /no source was found|not found|unknown scene|invalid scene|could not find/i.test(msg);
}

/** SE.Live GetSceneList(vertical) often returns 0 — probe which scene name OBS accepts on that canvas. */
async function probeVerticalSceneNameOnCanvas(mainName, canvasUuid, preferredNames = [], opts = {}) {
  if (!mainName || !canvasUuid) return null;

  const canvasName = opts.canvasName || getCanvasNameForUuid(canvasUuid) || null;
  const mainSceneUuid = opts.mainSceneUuid || null;
  const cacheKey = `${canvasUuid}|${mainName.toLowerCase()}|${(mainSceneUuid || '').slice(0, 8)}`;
  if (verticalSceneNameProbeCache.has(cacheKey)) {
    return verticalSceneNameProbeCache.get(cacheKey);
  }

  if (mainSceneUuid) {
    try {
      const { sceneItems = [] } = await obsController.getSceneItemList(
        null,
        canvasUuid,
        mainSceneUuid,
        canvasName
      );
      if (sceneItems.length > 0) {
        const fromPreferred = preferredNames.find(Boolean);
        const resolved = fromPreferred || linkVerticalNameFromMain(mainName) || mainName;
        verticalSceneNameProbeCache.set(cacheKey, resolved);
        console.log(
          `[SwiftSync vertical] probed OK via main uuid canvas=${canvasUuid.slice(0, 8)}… (${sceneItems.length} items, scene="${resolved}")`
        );
        return resolved;
      }
    } catch {
      /* fall through to name probes */
    }
  }

  const candidates = [];
  const add = (n) => {
    const s = String(n || '').trim();
    if (s && !candidates.some((x) => x.toLowerCase() === s.toLowerCase())) candidates.push(s);
  };

  for (const n of preferredNames) add(n);
  for (const n of verticalNameCandidatesForMain(mainName)) add(n);
  for (const vs of lastVerticalScenes) {
    if (verticalSceneMatchesMain(vs, mainName)) add(vs);
  }
  for (const entry of lastVerticalEntries) {
    const n = sceneEntryName(entry);
    if (n && verticalSceneMatchesMain(n, mainName)) add(n);
  }

  for (const sceneName of candidates) {
    try {
      const { sceneItems = [] } = await obsController.getSceneItemList(
        sceneName,
        canvasUuid,
        null,
        canvasName
      );
      if (sceneItems.length > 0) {
        verticalSceneNameProbeCache.set(cacheKey, sceneName);
        console.log(
          `[SwiftSync vertical] probed OK canvas=${canvasUuid.slice(0, 8)}… scene="${sceneName}" (${sceneItems.length} items, main="${mainName}")`
        );
        return sceneName;
      }
    } catch (e) {
      if (!sceneListErrorLooksLikeMissingScene(e)) {
        console.warn('[SwiftSync vertical] probe error', sceneName, e.message || e);
        continue;
      }
      try {
        await obsController.setProgramScene(sceneName, canvasUuid, null, canvasName);
        const { sceneItems = [] } = await obsController.getSceneItemList(
          sceneName,
          canvasUuid,
          null,
          canvasName
        );
        if (sceneItems.length > 0) {
          verticalSceneNameProbeCache.set(cacheKey, sceneName);
          console.log(
            `[SwiftSync vertical] probed OK after switch canvas=${canvasUuid.slice(0, 8)}… scene="${sceneName}" (${sceneItems.length} items)`
          );
          return sceneName;
        }
      } catch {
        /* try next candidate */
      }
    }
  }

  // Fall back to first name OBS accepts even if empty (scene exists but has no items yet).
  for (const sceneName of candidates) {
    try {
      await obsController.getSceneItemList(sceneName, canvasUuid, null, canvasName);
      verticalSceneNameProbeCache.set(cacheKey, sceneName);
      return sceneName;
    } catch {
      /* try next */
    }
  }

  verticalSceneNameProbeCache.set(cacheKey, null);
  return null;
}

async function refreshVerticalSceneNamesFromProbe() {
  const vUuid = getVerticalCanvasUuid();
  if (!vUuid) return;

  for (const link of sceneLinks) {
    const mainName = link?.main?.sceneName;
    if (!mainName) continue;

    const preferred = link.vertical?.sceneName ? [link.vertical.sceneName] : [];
    const probed = await probeVerticalSceneNameOnCanvas(mainName, vUuid, preferred);
    if (!probed) continue;

    if (!link.vertical) {
      link.vertical = { sceneName: probed, sceneUuid: null, canvasUuid: vUuid };
    } else {
      link.vertical.sceneName = probed;
      link.vertical.canvasUuid = vUuid;
    }
  }
}

function isLikelyVerticalSceneName(name) {
  const s = String(name).trim();
  if (/vertical|portrait|9:16|shorts|tiktok|mobile|phone|\(v\)/i.test(s)) return true;
  if (/[vV]\s*$/i.test(s) && s.length > 2) {
    const base = stripVerticalSuffix(s);
    return base.length >= 2 && base.toLowerCase() !== s.toLowerCase();
  }
  return false;
}

function splitMainAndVerticalSceneNames(allScenes) {
  const verticalNames = allScenes.filter(isLikelyVerticalSceneName);
  const mainNames = allScenes.filter((n) => !isLikelyVerticalSceneName(n));
  return {
    mainScenes: mainNames.length ? mainNames : allScenes,
    verticalScenes: verticalNames.length ? verticalNames : allScenes
  };
}

function normalizeSceneKey(name) {
  return String(name)
    .toLowerCase()
    .replace(/\s*[\(\[].*(vertical|horizontal|portrait|landscape|main|tiktok|shorts|mobile|phone|9:16|16:9).*[\)\]]\s*/gi, '')
    .replace(/\s+(vertical|horizontal|portrait|landscape)$/i, '')
    .trim();
}

function findVerticalPartner(mainName, mainIndex, verticalScenes, usedIndices, verticalEntries = null) {
  if (!verticalScenes?.length) return null;

  const entries = verticalEntries || verticalScenes.map((name) => ({ sceneName: name }));

  // 1. SE.Live V-suffix link (game ↔ gameV, reactions ↔ reactionsV)
  for (let i = 0; i < entries.length; i++) {
    if (usedIndices.has(i)) continue;
    const vName = sceneEntryName(entries[i]);
    if (verticalSceneMatchesMain(vName, mainName)) {
      usedIndices.add(i);
      return vName;
    }
  }

  // 2. Explicit name candidates
  for (const candidate of verticalNameCandidatesForMain(mainName)) {
    for (let i = 0; i < entries.length; i++) {
      if (usedIndices.has(i)) continue;
      if (sceneEntryName(entries[i]) === candidate) {
        usedIndices.add(i);
        return candidate;
      }
    }
  }

  // 3. Same name on vertical canvas
  for (let i = 0; i < verticalScenes.length; i++) {
    if (usedIndices.has(i)) continue;
    if (verticalScenes[i] === mainName) {
      usedIndices.add(i);
      return verticalScenes[i];
    }
  }

  const key = normalizeSceneKey(mainName);
  for (let i = 0; i < verticalScenes.length; i++) {
    if (usedIndices.has(i)) continue;
    if (normalizeSceneKey(verticalScenes[i]) === key) {
      usedIndices.add(i);
      return verticalScenes[i];
    }
  }

  for (let i = 0; i < verticalScenes.length; i++) {
    if (usedIndices.has(i)) continue;
    const ck = normalizeSceneKey(stripVerticalSuffix(verticalScenes[i]));
    if (ck === key || ck.startsWith(key) || key.startsWith(ck)) {
      usedIndices.add(i);
      return verticalScenes[i];
    }
  }

  // 4. Index fallback (scene 1 ↔ scene 1) when names do not match
  if (mainIndex < verticalScenes.length && verticalScenes[mainIndex]) {
    usedIndices.add(mainIndex);
    return verticalScenes[mainIndex];
  }

  return null;
}

function findVerticalPartnerEntry(mainName, mainIndex, verticalEntries, usedIndices) {
  // Honor explicit pairing first (from probing or manual mapping).
  for (let i = 0; i < (verticalEntries || []).length; i++) {
    if (usedIndices.has(i)) continue;
    const entry = verticalEntries[i];
    if (entry && entry._pairedToMainName === mainName) {
      usedIndices.add(i);
      return entry;
    }
  }
  const vertNames = (verticalEntries || []).map(sceneEntryName).filter(Boolean);
  const partnerName = findVerticalPartner(mainName, mainIndex, vertNames, usedIndices, verticalEntries);
  return partnerName ? findSceneEntry(verticalEntries, partnerName) : null;
}

function pairAllSceneLinks(mainEntries, verticalEntries, mainUuid, verticalUuid, useDualCanvas) {
  const mainNames = (mainEntries || []).map(sceneEntryName).filter(Boolean);
  if (!mainNames.length) return [];

  if (useDualCanvas) {
    const vUuid = getVerticalCanvasUuid();
    const usedIndices = new Set();

    return mainEntries.map((entry, index) => {
      const sceneName = sceneEntryName(entry);
      const partnerEntry = findVerticalPartnerEntry(sceneName, index, verticalEntries, usedIndices);

      return {
        main: {
          sceneName,
          sceneUuid: sceneEntryUuid(entry),
          canvasUuid: mainUuid
        },
        vertical: partnerEntry
          ? {
              sceneName: sceneEntryName(partnerEntry),
              sceneUuid: sceneEntryUuid(partnerEntry),
              canvasUuid: vUuid
            }
          : null
      };
    });
  }

  const vertNames = (verticalEntries || []).map(sceneEntryName).filter(Boolean);
  const allNames = [...new Set([...mainNames, ...vertNames])];
  const split = splitMainAndVerticalSceneNames(allNames.length ? allNames : mainNames);
  const mains = split.mainScenes.length ? split.mainScenes : mainNames;
  const verts = split.verticalScenes;
  const usedIndices = new Set();

  return mains.map((sceneName, index) => {
    const mainEntry = findSceneEntry(mainEntries, sceneName) || mainEntries[index];
    const partner = findVerticalPartner(sceneName, index, verts, usedIndices);
    const partnerEntry = partner ? findSceneEntry(verticalEntries, partner) : null;
    return {
      main: {
        sceneName,
        sceneUuid: sceneEntryUuid(mainEntry),
        canvasUuid: mainUuid
      },
      vertical: partner
        ? {
            sceneName: partner,
            sceneUuid: sceneEntryUuid(partnerEntry),
            canvasUuid: verticalUuid || mainUuid
          }
        : null
    };
  });
}

function createVisualSourceRow(src) {
  const row = document.createElement('div');
  row.className = 'source-row visual' + (src.enabled ? '' : ' off');
  row.dataset.sourceName = src.sourceName;

  const name = document.createElement('span');
  name.className = 'source-row-name';
  name.title = src.sourceName;
  name.textContent = src.sourceName;

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'src-btn' + (src.enabled ? '' : ' active-off');
  toggleBtn.textContent = src.enabled ? 'Hide' : 'Show';

  toggleBtn.addEventListener('click', async () => {
    try {
      const next = !src.enabled;
      await obsController.setSceneItemEnabledForSource(src, next);
      src.enabled = next;
      row.classList.toggle('off', !next);
      toggleBtn.classList.toggle('active-off', !next);
      toggleBtn.textContent = next ? 'Hide' : 'Show';
    } catch (e) {
      setStatus(e.message, '#ff4444');
    }
  });

  row.append(name, toggleBtn);
  return row;
}

function createAudioSourceRow(src) {
  const obsInputName = src.inputName || src.sourceName;
  const label = src.displayName || src.sourceName || obsInputName;

  const row = document.createElement('div');
  row.className = 'source-row audio' + (src.muted ? ' muted' : '');
  row.dataset.inputName = obsInputName;

  const name = document.createElement('span');
  name.className = 'source-row-name';
  name.title = label;
  name.textContent = label;

  const controls = document.createElement('div');
  controls.className = 'source-row-controls';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(VOLUME_DB_MIN);
  slider.max = String(VOLUME_DB_MAX);
  slider.step = String(VOLUME_DB_STEP);
  slider.value = String(clampVolumeDb(src.volumeDb ?? 0));
  slider.dataset.role = 'volume';

  const volLabel = document.createElement('span');
  volLabel.className = 'src-vol-label';
  volLabel.dataset.role = 'vol-label';
  volLabel.textContent = formatVolumeDb(slider.value);

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'src-btn mute' + (src.muted ? ' muted' : '');
  muteBtn.dataset.role = 'mute';
  muteBtn.textContent = src.muted ? 'Unmute' : 'Mute';

  async function setVolumeDb(db) {
    const clamped = clampVolumeDb(db);
    slider.value = String(clamped);
    volLabel.textContent = formatVolumeDb(clamped);
    await obsController.setInputVolumeDb(obsInputName, clamped);
    sendToMobile({
      type: 'volumeChanged',
      inputName: obsInputName,
      volumeDb: clamped
    });
  }

  slider.addEventListener('input', () => {
    volLabel.textContent = formatVolumeDb(slider.value);
  });
  slider.addEventListener('change', async () => {
    try {
      await setVolumeDb(Number(slider.value));
    } catch (e) {
      setStatus(e.message, '#ff4444');
    }
  });

  muteBtn.addEventListener('click', async () => {
    try {
      await obsController.toggleInputMute(obsInputName);
      const m = await obsController.getInputMute(obsInputName);
      src.muted = m.inputMuted;
      updateSourceMuteUi(obsInputName, m.inputMuted);
      sendToMobile({ type: 'muteChanged', inputName: obsInputName, muted: m.inputMuted });
    } catch (e) {
      setStatus(e.message, '#ff4444');
    }
  });

  controls.append(slider, volLabel, muteBtn);
  row.append(name, controls);
  return row;
}

function renderSourceList(container, sources, type, emptyMessage) {
  container.innerHTML = '';
  if (!sources.length) {
    const empty = document.createElement('div');
    empty.className = 'source-chip-empty';
    empty.textContent = emptyMessage || (type === 'audio' ? 'No audio sources' : 'No visual sources');
    container.appendChild(empty);
    return;
  }
  for (const src of sources) {
    container.appendChild(
      type === 'audio' ? createAudioSourceRow(src) : createVisualSourceRow(src)
    );
  }
}

function audioUiContainers() {
  return [globalAudioListEl, linkedSourcesPanelEl].filter(Boolean);
}

function updateSourceVolumeUi(inputName, volumeDb) {
  const db = clampVolumeDb(volumeDb);
  audioUiContainers().forEach((container) => {
    container.querySelectorAll('.source-row.audio').forEach((row) => {
      if (row.dataset.inputName !== inputName) return;
      const slider = row.querySelector('[data-role="volume"]');
      const label = row.querySelector('[data-role="vol-label"]');
      if (slider) slider.value = String(db);
      if (label) label.textContent = formatVolumeDb(db);
    });
  });
}

function updateSourceMuteUi(inputName, muted) {
  audioUiContainers().forEach((container) => {
    container.querySelectorAll('.source-row.audio').forEach((row) => {
      if (row.dataset.inputName !== inputName) return;
      row.classList.toggle('muted', muted);
      const btn = row.querySelector('[data-role="mute"]');
      if (btn) {
        btn.classList.toggle('muted', muted);
        btn.textContent = muted ? 'Unmute' : 'Mute';
      }
    });
  });
}

function renderCanvasPane({ side, title, sceneName, canvasUuid, canvasName, visual, audio, emptyHint }, visualOnly = false) {
  const pane = document.createElement('div');
  pane.className = 'canvas-pane' + (side === 'vertical' ? ' vertical' : '');

  const header = document.createElement('div');
  header.className = 'canvas-pane-header';
  const canvasTag = canvasName || (canvasUuid ? `${canvasUuid.slice(0, 8)}…` : '');
  header.innerHTML = `${escapeHtml(title)} · <strong>${escapeHtml(sceneName || '—')}</strong>${canvasTag ? ` <span class="canvas-tag">(${escapeHtml(canvasTag)})</span>` : ''}`;
  pane.appendChild(header);

  if (emptyHint) {
    const hint = document.createElement('p');
    hint.className = 'empty-hint canvas-pane-hint';
    hint.textContent = emptyHint;
    pane.appendChild(hint);
  }

  const visualEmpty =
    side === 'vertical' && !visual?.length
      ? `No visual sources${canvasTag ? ` (scene "${sceneName}" on ${canvasTag})` : ''}`
      : 'No visual sources';
  const audioEmpty =
    side === 'vertical' && !audio?.length
      ? `No audio sources${canvasTag ? ` (scene "${sceneName}" on ${canvasTag})` : ''}`
      : 'No audio sources';

  const visualSection = document.createElement('div');
  visualSection.className = 'source-section';
  const visualLabel = document.createElement('span');
  visualLabel.className = 'source-section-label';
  visualLabel.textContent = 'Visual';
  const visualList = document.createElement('div');
  visualList.className = 'source-rows';
  visualSection.append(visualLabel, visualList);
  renderSourceList(visualList, visual, 'visual', visualEmpty);

  pane.appendChild(visualSection);
  if (!visualOnly) {
    const audioSection = document.createElement('div');
    audioSection.className = 'source-section';
    const audioLabel = document.createElement('span');
    audioLabel.className = 'source-section-label';
    audioLabel.textContent = 'Audio';
    const audioList = document.createElement('div');
    audioList.className = 'source-rows';
    audioSection.append(audioLabel, audioList);
    renderSourceList(audioList, audio, 'audio', audioEmpty);
    pane.appendChild(audioSection);
  }
  return pane;
}

function renderLinkedSourcesPanel(panels) {
  if (!linkedSourcesPanelEl) return;

  linkedSourcesPanelEl.innerHTML = '';

  if (!panels.length) {
    linkedSourcesPanelEl.classList.add('single');
    linkedSourcesPanelEl.classList.remove('dual');
    if (linkedScenesHeaderEl) linkedScenesHeaderEl.textContent = 'Select a scene above';
    if (sceneSourcesEmptyEl) sceneSourcesEmptyEl.style.display = 'none';
    return;
  }

  const mainPanel = panels.find((p) => p.side === 'main') || panels[0];
  const verticalPanel = panels.find((p) => p.side === 'vertical');

  if (linkedScenesHeaderEl) {
    if (verticalPanel) {
      linkedScenesHeaderEl.textContent =
        `Sources: ${mainPanel.sceneName || '—'} (Main) · ${verticalPanel.sceneName || '—'} (Vertical)`;
    } else {
      linkedScenesHeaderEl.textContent = `Sources: ${mainPanel.sceneName || '—'}`;
    }
  }

  linkedSourcesPanelEl.classList.toggle('dual', !!verticalPanel);
  linkedSourcesPanelEl.classList.toggle('single', !verticalPanel);

  linkedSourcesPanelEl.appendChild(renderCanvasPane(mainPanel, true));
  if (verticalPanel) {
    linkedSourcesPanelEl.appendChild(renderCanvasPane(verticalPanel, true));
  } else if (dualCanvasMode && getVerticalCanvasUuid()) {
    const stub = {
      side: 'vertical',
      title: getCanvasNameForUuid(getVerticalCanvasUuid()) || 'SE.Live Vertical',
      sceneName: '—',
      canvasUuid: getVerticalCanvasUuid(),
      canvasName: getCanvasNameForUuid(getVerticalCanvasUuid()),
      visual: [],
      audio: [],
      emptyHint:
        'Vertical canvas detected but no sources loaded — click Refresh Scenes, then select this scene again.'
    };
    linkedSourcesPanelEl.appendChild(renderCanvasPane(stub, true));
  }

  const totalSources =
    (mainPanel.visual?.length || 0) + (verticalPanel?.visual?.length || 0);
  if (sceneSourcesEmptyEl) {
    sceneSourcesEmptyEl.style.display = totalSources === 0 ? 'block' : 'none';
  }
}

function renderGlobalAudioList(sources) {
  if (!globalAudioListEl) return;
  renderSourceList(globalAudioListEl, sources || [], 'audio', 'No audio inputs');
}

function enrichSceneAudioDisplay(src, panel) {
  const name = src.sourceName || src.inputName;
  const mainPartner =
    panel?.side === 'vertical' ? ObsController.mainAudioNameForVerticalSource(name) : null;
  let displayName = src.displayName || name;
  if (mainPartner && mainPartner !== name) {
    displayName = `${name} (↔ Main: ${mainPartner})`;
  }
  return { ...src, displayName, linkedMainAudio: mainPartner || null };
}

function renderSceneAudioListFromPanels(panels) {
  if (!scenePageAudioListEl || !sceneAudioSectionEl) return;

  scenePageAudioListEl.innerHTML = '';
  let total = 0;

  for (const panel of panels || []) {
    const audio = (panel?.audio || []).map((s) => enrichSceneAudioDisplay(s, panel));
    if (!audio.length) continue;
    total += audio.length;

    const group = document.createElement('div');
    group.className = 'scene-audio-group';

    const hdr = document.createElement('p');
    hdr.className = 'scene-audio-group-label';
    const canvasTag = panel.canvasName || panel.title || (panel.side === 'vertical' ? 'Vertical' : 'Main');
    hdr.textContent =
      panel.side === 'vertical'
        ? `Vertical · ${panel.sceneName || '—'} (${canvasTag})`
        : `Main · ${panel.sceneName || '—'}`;
    group.appendChild(hdr);

    const list = document.createElement('div');
    list.className = 'source-rows';
    renderSourceList(list, audio, 'audio', '');
    group.appendChild(list);
    scenePageAudioListEl.appendChild(group);
  }

  if (!total) {
    renderSourceList(
      scenePageAudioListEl,
      [],
      'audio',
      'No audio in this scene pair — add sources in OBS/SE.Live.'
    );
  }
  sceneAudioSectionEl.style.display = total > 0 ? 'block' : 'none';
}

function clearSceneAudioList() {
  if (!scenePageAudioListEl || !sceneAudioSectionEl) return;
  renderSourceList(scenePageAudioListEl, [], 'audio', 'No audio inputs in current scene(s).');
  sceneAudioSectionEl.style.display = 'none';
}

function normalizePanelAudioSources(panels, globalAudioSources = []) {
  const byName = new Map();
  for (const src of globalAudioSources || []) {
    const key = src.inputName || src.sourceName;
    if (key) byName.set(key, src);
  }

  for (const panel of panels || []) {
    const list = panel?.audio || [];
    panel.audio = list.map((src) => {
      const key = src.inputName || src.sourceName;
      const mainPartner =
        panel.side === 'vertical' ? ObsController.mainAudioNameForVerticalSource(key) : null;
      const global =
        (key && byName.get(key)) ||
        (mainPartner && byName.get(mainPartner)) ||
        null;
      return {
        ...src,
        sourceName: src.sourceName || src.inputName || key,
        inputName: src.inputName || src.sourceName || key,
        linkedMainAudio: mainPartner,
        volumeDb: src.volumeDb ?? global?.volumeDb ?? 0,
        volumeMul: src.volumeMul ?? global?.volumeMul ?? 1,
        muted: src.muted ?? global?.muted ?? false
      };
    });
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** SE.Live linked scenes: same scene UUID on vertical canvas, unique sources per canvas. */
async function fetchVerticalScenePanel(task) {
  const vUuid = task.canvasUuid || task.verticalScene?.canvasUuid || getVerticalCanvasUuid();
  const canvasName = task.canvasName || getCanvasNameForUuid(vUuid);
  const mainName = task.mainPanel?.sceneName || '';
  const linkIndex = typeof task.linkIndex === 'number' ? task.linkIndex : -1;
  const link =
    linkIndex >= 0 && linkIndex < sceneLinks.length
      ? sceneLinks[linkIndex]
      : sceneLinks.find((l) => l.main?.sceneName === mainName) || null;

  if (!vUuid || !mainName) {
    return {
      side: 'vertical',
      title: task.title,
      sceneName: task.verticalScene?.sceneName || linkVerticalNameFromMain(mainName) || mainName,
      sceneUuid: null,
      canvasUuid: vUuid,
      canvasName,
      visual: [],
      audio: [],
      emptyHint: 'Missing vertical canvas or main scene.'
    };
  }

  const resolvedVertical = link
    ? await resolveVerticalSceneForLink(link, linkIndex)
    : null;

  let activeVertical = null;
  try {
    activeVertical = await obsController.getCurrentProgramScene(vUuid);
  } catch {
    /* optional */
  }

  const mainSceneUuid =
    task.mainPanel?.sceneUuid ||
    link?.main?.sceneUuid ||
    null;

  const probedName = await probeVerticalSceneNameOnCanvas(
    mainName,
    vUuid,
    [
      resolvedVertical?.sceneName,
      task.verticalScene?.sceneName,
      activeVertical?.sceneName,
      linkVerticalNameFromMain(mainName)
    ].filter(Boolean),
    { canvasName, mainSceneUuid }
  );

  const verticalSceneName =
    probedName ||
    resolvedVertical?.sceneName ||
    activeVertical?.sceneName ||
    task.verticalScene?.sceneName ||
    linkVerticalNameFromMain(mainName) ||
    mainName;

  const verticalSceneUuid =
    resolvedVertical?.sceneUuid ||
    (verticalSceneName === activeVertical?.sceneName ? activeVertical?.sceneUuid : null) ||
    null;

  const strategies = [];
  const add = (s) => {
    const key = `${s.sceneUuid || ''}|${s.sceneName || ''}|${s.canvasUuid || ''}|${s.canvasName || ''}`;
    if (
      !strategies.some(
        (x) =>
          `${x.sceneUuid || ''}|${x.sceneName || ''}|${x.canvasUuid || ''}|${x.canvasName || ''}` ===
          key
      )
    ) {
      strategies.push(s);
    }
  };

  // SE.Live: main scene UUID on vertical canvas often returns vertical-specific items.
  if (mainSceneUuid && vUuid) {
    add({
      sceneUuid: mainSceneUuid,
      canvasUuid: vUuid,
      canvasName,
      sceneName: null,
      label: 'main sceneUuid on vertical canvas'
    });
  }
  if (verticalSceneName && vUuid) {
    add({
      sceneName: verticalSceneName,
      canvasUuid: vUuid,
      canvasName,
      sceneUuid: null,
      label: 'resolved vertical scene'
    });
  }
  if (verticalSceneName && canvasName) {
    add({
      sceneName: verticalSceneName,
      canvasUuid: null,
      canvasName,
      sceneUuid: null,
      label: 'vertical scene + canvasName'
    });
  }
  if (verticalSceneUuid && vUuid) {
    add({
      sceneUuid: verticalSceneUuid,
      canvasUuid: vUuid,
      canvasName,
      sceneName: null,
      label: 'resolved vertical uuid'
    });
  }
  if (mainName && vUuid && verticalSceneName !== mainName) {
    add({
      sceneName: mainName,
      canvasUuid: vUuid,
      canvasName,
      sceneUuid: null,
      label: 'main name on vertical canvas'
    });
  }

  for (const name of verticalNameCandidatesForMain(mainName)) {
    if (name !== verticalSceneName && vUuid) {
      add({
        sceneName: name,
        canvasUuid: vUuid,
        canvasName,
        sceneUuid: null,
        label: `candidate "${name}"`
      });
    }
  }

  let bestResult = null;
  let bestScore = -1;
  let winningLabel = null;
  let rawCount = 0;
  const fetchLog = [];

  for (const strategy of strategies) {
    try {
      const result = await obsController.getSceneSourcesDirect(
        strategy.sceneName,
        strategy.canvasUuid ?? null,
        strategy.sceneUuid ?? null,
        strategy.canvasName ?? canvasName ?? null
      );
      const count = panelItemCount(result);
      const score = scoreVerticalPanelResult(task.mainPanel, result);
      const plausible = isPlausibleVerticalPanel(task.mainPanel, result, strategy);
      fetchLog.push({ label: strategy.label, count, score, plausible });
      console.log(
        `[SwiftSync vertical] ${strategy.label} → ${result.rawItemCount ?? count} raw (${result.visual?.length || 0}v/${result.audio?.length || 0}a) score=${score}${plausible ? '' : ' [duplicate/main]'}`
      );

      if (plausible && score > bestScore) {
        bestScore = score;
        bestResult = result;
        winningLabel = strategy.label;
        rawCount = result.rawItemCount || count;
      }
    } catch (e) {
      fetchLog.push({ label: strategy.label, count: 0, error: String(e.message || e) });
    }
  }

  // If strict scoring rejected everything, keep best non-empty result from vertical canvas.
  if (!bestResult && vUuid) {
    let fallback = null;
    let fallbackCount = 0;
    for (const strategy of strategies) {
      if (strategy.canvasUuid !== vUuid) continue;
      try {
        const result = await obsController.getSceneSourcesDirect(
          strategy.sceneName,
          strategy.canvasUuid ?? null,
          strategy.sceneUuid ?? null,
          strategy.canvasName ?? canvasName ?? null
        );
        const count = panelItemCount(result);
        if (count > fallbackCount) {
          fallbackCount = count;
          fallback = result;
          winningLabel = strategy.label;
          rawCount = result.rawItemCount || count;
        }
      } catch {
        /* try next */
      }
    }
    if (fallback) bestResult = fallback;
  }

  lastVerticalFetchDebug = { sceneName: verticalSceneName, strategies: fetchLog, winningLabel };

  const visual = annotateVerticalSourceEntries(bestResult?.visual, verticalSceneName, vUuid, canvasName);
  const audio = annotateVerticalSourceEntries(bestResult?.audio, verticalSceneName, vUuid, canvasName);

  return {
    side: 'vertical',
    title: task.title,
    sceneName: verticalSceneName,
    sceneUuid: verticalSceneUuid || mainSceneUuid || null,
    canvasUuid: vUuid,
    canvasName,
    visual,
    audio,
    emptyHint:
      !bestResult || rawCount === 0
        ? 'No vertical sources found. Tap Diagnose vertical on PC Scenes tab, then Refresh Scenes.'
        : undefined
  };
}

function linkVerticalNameFromMain(mainName) {
  const m = String(mainName || '').trim();
  return m ? `${m}V` : null;
}

async function fetchScenePanel(task) {
  let canvasUuid = task.canvasUuid ?? null;
  let canvasName = task.canvasName ?? getCanvasNameForUuid(canvasUuid);
  let sceneName = task.sceneName;
  let sceneUuid = task.sceneUuid ?? null;
  const verticalStrict = task.side === 'vertical';
  const linkedVerticalName = task.verticalScene?.sceneName || (verticalStrict ? sceneName : null);
  const sourceOptions = {
    expandNestedScenes: !verticalStrict,
    expandGroups: !verticalStrict,
    includeUnclassified: verticalStrict
  };
  const fetchLog = [];

  if (verticalStrict && task.verticalScene) {
    sceneName = task.verticalScene.sceneName;
    sceneUuid = task.verticalScene.sceneUuid;
    canvasUuid = task.verticalScene.canvasUuid ?? canvasUuid;
    canvasName = task.verticalScene.canvasName ?? canvasName;
  } else if (verticalStrict && sceneName) {
    sceneUuid =
      sceneUuid ||
      (await resolveSceneUuidForCanvas(sceneName, canvasUuid, canvasName));
  }

  if (verticalStrict && task.mainPanel?.sceneUuid && sceneUuid === task.mainPanel.sceneUuid) {
    sceneUuid = null;
  }

  const strategies = [];
  const addStrategy = (s) => {
    const key = `${s.sceneUuid || ''}|${s.sceneName || ''}|${s.canvasUuid || ''}|${s.canvasName || ''}`;
    if (
      !strategies.some(
        (x) =>
          `${x.sceneUuid || ''}|${x.sceneName || ''}|${x.canvasUuid || ''}|${x.canvasName || ''}` ===
          key
      )
    ) {
      strategies.push(s);
    }
  };

  const buildCandidate = (result, strategy, resolvedCanvasUuid, resolvedCanvasName) => ({
    side: task.side,
    title: task.title,
    sceneName: sceneName || strategy.sceneName,
    sceneUuid: sceneUuid || strategy.sceneUuid || null,
    canvasUuid: resolvedCanvasUuid ?? canvasUuid,
    canvasName: resolvedCanvasName ?? canvasName,
    visual: (result.visual || []).map((s) => ({
      ...s,
      sceneName: sceneName || s.sceneName,
      sceneUuid: sceneUuid || s.sceneUuid || null,
      canvasUuid: resolvedCanvasUuid ?? canvasUuid
    })),
    audio: (result.audio || []).map((s) => ({
      ...s,
      sceneName: sceneName || s.sceneName,
      sceneUuid: sceneUuid || s.sceneUuid || null,
      canvasUuid: resolvedCanvasUuid ?? canvasUuid
    }))
  });

  const tryStrategy = async (strategy, { direct = false } = {}) => {
    const result = direct
      ? await obsController.getSceneSourcesDirect(
          strategy.sceneName,
          strategy.canvasUuid ?? null,
          strategy.sceneUuid ?? null,
          strategy.canvasName ?? canvasName ?? null
        )
      : await obsController.getSceneSources(
          strategy.sceneName,
          strategy.canvasUuid ?? null,
          strategy.sceneUuid ?? null,
          strategy.canvasName ?? null,
          sourceOptions
        );
    return buildCandidate(
      result,
      strategy,
      strategy.canvasUuid ?? canvasUuid,
      strategy.canvasName ?? canvasName
    );
  };

  const recordAttempt = (strategy, candidate, err) => {
    const label = strategyLabel(strategy);
    const count = candidate ? panelItemCount(candidate) : 0;
    const entry = {
      label,
      count,
      error: err ? String(err.message || err) : undefined
    };
    fetchLog.push(entry);
    if (verticalStrict) {
      const cName = strategy.canvasName || canvasName || getCanvasNameForUuid(strategy.canvasUuid || canvasUuid) || '?';
      const sName = strategy.sceneName || sceneName || '?';
      const sUuid = (strategy.sceneUuid || sceneUuid || '?').slice?.(0, 8) || '?';
      console.log(
        `[SwiftSync vertical] canvas="${cName}" scene="${sName}" uuid=${sUuid}… → ${count} item${count === 1 ? '' : 's'}${entry.error ? ` (${entry.error})` : ''} [${label}]`
      );
    }
    return entry;
  };

  const isGoodVerticalCandidate = (candidate, strategy = {}) => {
    if (!candidate) return false;
    const count = panelItemCount(candidate);
    if (count === 0) return false;

    const vCanvas = getVerticalCanvasUuid();
    const mCanvas = mainCanvasUuid || task.mainPanel?.canvasUuid;
    const strategyCanvas = strategy.canvasUuid ?? null;

    // Linked vertical scene (e.g. chattingv) — accept its own sources even if names overlap main
    if (
      vCanvas &&
      strategyCanvas === vCanvas &&
      linkedVerticalName &&
      strategy.sceneName === linkedVerticalName
    ) {
      return true;
    }

    const candidateCanvas = candidate.canvasUuid ?? null;
    const onVerticalCanvas =
      vCanvas &&
      (candidateCanvas === vCanvas ||
        strategyCanvas === vCanvas ||
        task.canvasUuid === vCanvas ||
        task.verticalScene?.canvasUuid === vCanvas);

    if (onVerticalCanvas) return true;

    if (vCanvas && mCanvas && candidateCanvas === mCanvas) return false;
    if (
      vCanvas &&
      strategyCanvas === null &&
      !strategy.canvasName &&
      candidateCanvas === mCanvas
    ) {
      return false;
    }

    if (panelLooksLikeDuplicate(task.mainPanel, candidate)) return false;
    return true;
  };

  if (verticalStrict) {
    const vCanvasUuid = task.canvasUuid || task.verticalScene?.canvasUuid || getVerticalCanvasUuid();

    // Direct fetch of linked vertical scene (gamev) — scene name + canvas, not main scene uuid
    if (linkedVerticalName && vCanvasUuid) {
      addStrategy({
        sceneName: linkedVerticalName,
        canvasUuid: vCanvasUuid,
        canvasName: null,
        sceneUuid: null
      });
    }

    if (sceneUuid && vCanvasUuid && sceneUuid !== task.mainPanel?.sceneUuid) {
      addStrategy({
        sceneUuid,
        sceneName: linkedVerticalName || sceneName,
        canvasUuid: vCanvasUuid,
        canvasName: null
      });
    }

    // Only use live program scene when no linked vertical scene name
    if (!linkedVerticalName && vCanvasUuid) {
      try {
        const current = await obsController.getCurrentProgramScene(vCanvasUuid);
        if (current?.sceneUuid || current?.sceneName) {
          addStrategy({
            sceneUuid: current.sceneUuid,
            sceneName: current.sceneName,
            canvasUuid: vCanvasUuid,
            canvasName: null
          });
        }
      } catch {
        /* optional */
      }
    }

    // sceneName + canvasUuid — SE.Live scenes share base names across canvases
    if (sceneName && canvasUuid && sceneName !== linkedVerticalName) {
      addStrategy({ sceneName, canvasUuid, canvasName: null, sceneUuid: null });
    }
    if (sceneUuid && canvasName) {
      addStrategy({ sceneUuid, sceneName, canvasUuid: null, canvasName });
    }
    if (sceneName && canvasName) {
      addStrategy({ sceneName, canvasUuid: null, canvasName, sceneUuid: sceneUuid || null });
    }
    if (sceneUuid && canvasUuid && canvasName) {
      addStrategy({ sceneUuid, sceneName, canvasUuid, canvasName });
    }
    if (sceneName && canvasUuid && canvasName) {
      addStrategy({ sceneName, canvasUuid, canvasName, sceneUuid: sceneUuid || null });
    }
    // sceneUuid-only last — may default to main canvas; validated in isGoodVerticalCandidate
    if (sceneUuid) {
      addStrategy({ sceneUuid, sceneName, canvasUuid: null, canvasName: null });
    }
  } else {
    if (sceneUuid) addStrategy({ sceneUuid, canvasUuid, canvasName, sceneName });
    if (sceneName && canvasUuid) addStrategy({ sceneName, canvasUuid, canvasName, sceneUuid: null });
    if (sceneName && canvasName) addStrategy({ sceneName, canvasUuid: null, canvasName, sceneUuid: null });
    if (sceneName && task.side === 'main' && !canvasUuid) {
      addStrategy({ sceneName, canvasUuid: null, canvasName: null, sceneUuid: null });
    }
  }

  let bestPanel = null;
  for (const strategy of strategies) {
    try {
      const useDirect = verticalStrict && strategy.canvasUuid === getVerticalCanvasUuid();
      let candidate = await tryStrategy(strategy, { direct: useDirect });
      recordAttempt(strategy, candidate, null);

      if (task.side === 'main') {
        bestPanel = candidate;
        break;
      }

      if (isGoodVerticalCandidate(candidate, strategy)) {
        bestPanel = candidate;
        break;
      }

      // Retry with full expansion if direct list was empty but scene exists
      if (useDirect && panelItemCount(candidate) === 0 && strategy.sceneName && strategy.canvasUuid) {
        candidate = await tryStrategy(strategy, { direct: false });
        recordAttempt({ ...strategy, sceneName: `${strategy.sceneName} (expanded)` }, candidate, null);
        if (isGoodVerticalCandidate(candidate, strategy)) {
          bestPanel = candidate;
          break;
        }
      }
    } catch (firstErr) {
      recordAttempt(strategy, null, firstErr);
      if (!verticalStrict && strategy.canvasUuid && sceneName) {
        try {
          bestPanel = await tryStrategy({
            sceneName,
            canvasUuid: null,
            canvasName: null,
            sceneUuid: null
          });
          break;
        } catch (secondErr) {
          console.warn(`Scene sources (${task.side}):`, secondErr.message || secondErr);
        }
      }
    }
  }

  const verticalNeedsFallback =
    verticalStrict &&
    (!bestPanel || !isGoodVerticalCandidate(bestPanel, {}));

  if (verticalNeedsFallback) {
    const canvasRefs = [
      ...verticalCanvasUuidCandidates(task),
      ...verticalCanvasNameCandidates(task)
    ].filter(Boolean);

    for (const ref of [...new Set(canvasRefs)]) {
      const refName =
        typeof ref === 'string' && ref.length < 64 && !/^[0-9a-f-]{32,}$/i.test(ref)
          ? ref
          : getCanvasNameForUuid(ref);
      const refUuid =
        typeof ref === 'string' && /^[0-9a-f-]{32,}$/i.test(ref)
          ? ref
          : canvasOptions.find((c) => c.name === ref)?.uuid || null;

      if (refUuid && refUuid === mainCanvasUuid) continue;

      let resolvedSceneName = sceneName;
      let resolvedSceneUuid = sceneUuid;

      // OBS GetSceneList for this canvas (index pairing)
      if (refUuid) {
        try {
          const list = await obsController.getSceneList(refUuid);
          const obsScenes = (list.scenes || []).map((s) => ({
            sceneName: s.sceneName,
            sceneUuid: s.sceneUuid || s.uuid || null
          }));
          const match = verticalSceneAtLinkIndex(
            obsScenes,
            task.linkIndex ?? -1,
            sceneName,
            sceneUuid
          );
          if (match) {
            resolvedSceneName = match.sceneName;
            resolvedSceneUuid = match.sceneUuid || resolvedSceneUuid;
          }
        } catch {
          /* try strategies below */
        }
      }

      const fallbackStrategies = [
        { sceneUuid: resolvedSceneUuid, sceneName: resolvedSceneName, canvasUuid: refUuid, canvasName: null },
        { sceneName: resolvedSceneName, sceneUuid: resolvedSceneUuid, canvasUuid: refUuid, canvasName: null },
        { sceneUuid: resolvedSceneUuid, sceneName: resolvedSceneName, canvasUuid: null, canvasName: refName },
        { sceneName: resolvedSceneName, sceneUuid: resolvedSceneUuid, canvasName: refName, canvasUuid: null },
        { sceneName: resolvedSceneName, sceneUuid: resolvedSceneUuid, canvasName: refName, canvasUuid: refUuid },
        { sceneUuid: resolvedSceneUuid, sceneName: resolvedSceneName, canvasUuid: refUuid, canvasName: refName },
        { sceneUuid: resolvedSceneUuid, sceneName: resolvedSceneName, canvasUuid: null, canvasName: null }
      ];

      for (const strategy of fallbackStrategies) {
        if (!strategy.sceneName && !strategy.sceneUuid) continue;
        if (strategy.canvasUuid === mainCanvasUuid) continue;
        try {
          const candidate = await tryStrategy(strategy);
          recordAttempt(strategy, candidate, null);
          if (isGoodVerticalCandidate(candidate, strategy)) {
            bestPanel = candidate;
            break;
          }
        } catch (err) {
          recordAttempt(strategy, null, err);
        }
      }

      if (bestPanel && isGoodVerticalCandidate(bestPanel, {})) break;

      // Optional Aitum vendor fallback (never required)
      try {
        const aitumScenes = await obsController.getAitumScenes(refUuid || refName || ref);
        if (aitumScenes.length) {
          const match = verticalSceneAtLinkIndex(
            aitumScenes,
            task.linkIndex ?? -1,
            resolvedSceneName,
            resolvedSceneUuid
          );
          if (match) {
            resolvedSceneName = match.sceneName;
            resolvedSceneUuid = match.sceneUuid || resolvedSceneUuid;
          }
        }
      } catch {
        /* Aitum unavailable */
      }

      for (const vendorType of ['get_scene_items', 'scene_items', 'get_sources']) {
        try {
          const { data } = await obsController.callAitumVendor(vendorType, {
            canvas: refName || refUuid || ref,
            scene: resolvedSceneName,
            scene_uuid: resolvedSceneUuid
          });
          const rawItems = data.sceneItems || data.items || data.sources || [];
          if (!Array.isArray(rawItems) || !rawItems.length) continue;
          const visual = [];
          for (const item of rawItems) {
            const sourceName = item.sourceName || item.name;
            if (!sourceName) continue;
            visual.push({
              sourceName,
              inputKind: item.inputKind || '',
              sourceType: item.sourceType || item.type || '',
              enabled: item.sceneItemEnabled !== false && item.enabled !== false,
              sceneItemId: item.sceneItemId ?? item.id ?? null,
              sceneName: resolvedSceneName,
              sceneUuid: resolvedSceneUuid,
              canvasUuid: refUuid
            });
          }
          if (visual.length) {
            const candidate = buildCandidate({ visual, audio: [] }, {}, refUuid, refName);
            recordAttempt({ sceneName: `${vendorType} vendor` }, candidate, null);
            if (isGoodVerticalCandidate(candidate, { canvasUuid: refUuid })) {
              bestPanel = candidate;
              break;
            }
          }
        } catch (err) {
          recordAttempt({ sceneName: `${vendorType} vendor` }, null, err);
        }
      }
      if (bestPanel && isGoodVerticalCandidate(bestPanel, {})) break;
    }
  }

  if (verticalStrict) {
    lastVerticalFetchDebug = {
      sceneName,
      strategies: fetchLog.slice(-12)
    };
  }

  return (
    bestPanel || {
      side: task.side,
      title: task.title,
      sceneName,
      sceneUuid,
      canvasUuid,
      canvasName,
      visual: [],
      audio: []
    }
  );
}

async function refreshSceneSources(forMainSceneName = activeSceneName) {
  if (!obsController.connected || !forMainSceneName) {
    renderLinkedSourcesPanel([]);
    clearSceneAudioList();
    sendSceneSourcesToMobile([]);
    return [];
  }

  const link = sceneLinks.find((l) => l.main.sceneName === forMainSceneName);
  const mainCanvasUuidForLink = link?.main?.canvasUuid ?? mainCanvasUuid;
  const mainSceneUuid = link?.main?.sceneUuid ?? null;
  const mainCanvasName = getCanvasNameForUuid(mainCanvasUuidForLink);

  // Main canvas panel (uses direct fetch — fast path for main canvas)
  const mainResult = await obsController.getSceneSourcesDirect(
    forMainSceneName,
    mainCanvasUuidForLink,
    mainSceneUuid,
    mainCanvasName
  );

  const mainPanel = {
    side: 'main',
    title: mainCanvasName || 'Main',
    sceneName: forMainSceneName,
    sceneUuid: mainSceneUuid,
    canvasUuid: mainCanvasUuidForLink,
    canvasName: mainCanvasName,
    visual: mainResult.visual,
    audio: mainResult.audio || []
  };

  const panels = [mainPanel];

  // Vertical canvas panel — fetched only when dual canvas mode is active
  // (SE.Live, Aitum Vertical, or any plugin that exposes a second canvas)
  console.log(
    `[SwiftSync vertical] refreshSceneSources for "${forMainSceneName}": ` +
      `dualCanvas=${dualCanvasMode} verticalScene=${link?.vertical?.sceneName || '(none)'} ` +
      `verticalCanvasUuid=${(link?.vertical?.canvasUuid || verticalCanvasUuid || '?').slice(0, 8)}…`
  );

  const linkIndex = sceneLinks.findIndex((l) => l.main.sceneName === forMainSceneName);
  const vUuid = link?.vertical?.canvasUuid || verticalCanvasUuid;
  const vCanvasName = getCanvasNameForUuid(vUuid) || null;

  if (dualCanvasMode && vUuid) {
    try {
      if (link?.vertical) {
        const probed = await probeVerticalSceneNameOnCanvas(
          forMainSceneName,
          vUuid,
          [
            link.vertical.sceneName,
            ...verticalNameCandidatesForMain(forMainSceneName),
            getMappedVerticalName(forMainSceneName)
          ].filter(Boolean),
          { canvasName: vCanvasName, mainSceneUuid: link.main.sceneUuid }
        );
        if (probed) link.vertical.sceneName = probed;
        link.vertical.canvasUuid = vUuid;
      }

      const verticalSceneName =
        link?.vertical?.sceneName ||
        getMappedVerticalName(forMainSceneName) ||
        verticalNameCandidatesForMain(forMainSceneName)[0] ||
        linkVerticalNameFromMain(forMainSceneName);

      const verticalPanel = await fetchVerticalScenePanel({
        side: 'vertical',
        title: vCanvasName || 'SE.Live Vertical',
        sceneName: verticalSceneName,
        sceneUuid: link?.vertical?.sceneUuid || null,
        canvasUuid: vUuid,
        canvasName: vCanvasName,
        verticalScene: link?.vertical || {
          sceneName: verticalSceneName,
          sceneUuid: null,
          canvasUuid: vUuid,
          canvasName: vCanvasName
        },
        linkIndex,
        mainPanel
      });

      console.log(
        `[SwiftSync vertical] Got ${verticalPanel.visual?.length || 0} visual / ${verticalPanel.audio?.length || 0} audio ` +
          `for "${verticalPanel.sceneName}" on ${vCanvasName || vUuid?.slice(0, 8)}`
      );
      panels.push(verticalPanel);
    } catch (err) {
      console.warn('[SwiftSync vertical] Vertical panel fetch failed:', err.message || err);
      panels.push({
        side: 'vertical',
        title: vCanvasName || 'SE.Live Vertical',
        sceneName: link?.vertical?.sceneName || '—',
        sceneUuid: null,
        canvasUuid: vUuid,
        canvasName: vCanvasName,
        visual: [],
        audio: [],
        emptyHint: `Vertical fetch failed: ${err.message || err}. Click Refresh Scenes.`
      });
    }
  } else if (link?.vertical?.sceneName && !dualCanvasMode) {
    console.warn(
      `[SwiftSync vertical] vertical scene exists ("${link.vertical.sceneName}") but dualCanvasMode is false — ` +
        `SE.Live/Aitum may not be detected. Open Scenes tab → Refresh.`
    );
  }

  try {
    const globalAudio = await getAudioStateForMobile();
    const globalAudioSources = globalAudio.map((a) => ({
      sourceName: a.displayName || a.inputName,
      inputName: a.inputName,
      volumeDb: a.volumeDb,
      volumeMul: a.volumeMul,
      muted: a.muted
    }));
    normalizePanelAudioSources(panels, globalAudioSources);
  } catch {
    normalizePanelAudioSources(panels, []);
  }

  renderLinkedSourcesPanel(panels);
  renderSceneAudioListFromPanels(panels);
  sendSceneSourcesToMobile(panels);
  return panels;
}

async function refreshGlobalAudio() {
  if (!obsController.connected) {
    renderGlobalAudioList([]);
    sendAudioToMobile([]);
    return [];
  }

  const inputs = await getAudioStateForMobile();
  const sources = inputs.map((a) => ({
    sourceName: a.displayName || a.inputName,
    inputName: a.inputName,
    volumeDb: a.volumeDb,
    volumeMul: a.volumeMul,
    muted: a.muted
  }));
  renderGlobalAudioList(sources);
  sendAudioToMobile(sources);
  return sources;
}

function updateCanvasHintVerticalDebug() {
  if (!canvasHintEl || !lastVerticalFetchDebug?.strategies?.length) return;
  const base = canvasHintEl.textContent.replace(/\s*Vertical "[^"]+":[^.]*\./, '');
  const winning = lastVerticalFetchDebug.strategies.find(
    (s) => s.label === lastVerticalFetchDebug.winningLabel
  );
  const best = winning || [...lastVerticalFetchDebug.strategies].reverse().find((s) => s.plausible && s.count > 0);
  const last = best || lastVerticalFetchDebug.strategies[lastVerticalFetchDebug.strategies.length - 1];
  const ok = last?.count > 0 && last?.plausible !== false;
  const vCanvas = getCanvasNameForUuid(getVerticalCanvasUuid()) || '?';
  const via = lastVerticalFetchDebug.winningLabel ? ` via ${lastVerticalFetchDebug.winningLabel}` : '';
  canvasHintEl.textContent =
    base +
    ` Vertical "${lastVerticalFetchDebug.sceneName}" on ${vCanvas}: ${ok ? `${last.count} sources${via}` : 'no sources yet'}.`;
}

function serializePanelsForMobile(panels) {
  return (panels || []).map((p) => ({
    side: p.side,
    title: p.title,
    sceneName: p.sceneName,
    sceneUuid: p.sceneUuid || null,
    canvasUuid: p.canvasUuid,
    canvasName: p.canvasName || null,
    emptyHint: p.emptyHint || null,
    visual: (p.visual || []).map((s) => ({
      sourceName: s.sourceName,
      sceneItemId: s.sceneItemId,
      enabled: s.enabled !== false,
      sceneName: s.sceneName || p.sceneName,
      sceneUuid: s.sceneUuid || p.sceneUuid || null,
      canvasUuid: s.canvasUuid || p.canvasUuid
    })),
    audio: []
  }));
}

function sendAudioToMobile(inputs) {
  const payload = {
    type: 'audio',
    obsConnected: obsController.connected,
    obsOnline: obsController.connected,
    inputs: (inputs || []).map((a) => ({
      inputName: a.inputName || a.sourceName,
      name: a.inputName || a.sourceName,
      displayName: a.displayName || a.sourceName || a.inputName,
      volumeDb: a.volumeDb ?? 0,
      volumeMul: a.volumeMul ?? 1,
      muted: !!a.muted
    }))
  };
  sendToMobile(payload);
  postAudioViaHttp(payload);
}

function sendSceneSourcesToMobile(panels) {
  sendToMobile({
    type: 'sceneSources',
    sceneName: activeSceneName,
    panels: serializePanelsForMobile(panels)
  });
}

function postAudioViaHttp(payload) {
  try {
    const http = require('http');
    const body = JSON.stringify({
      inputs: payload.inputs || []
    });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: getRelayPort(),
        path: '/api/audio-inputs',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        res.resume();
      }
    );
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (_) {}
}

function scrollChatToBottom() {
  if (!chatMessagesEl) return;
  requestAnimationFrame(() => {
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  });
}

const CHAT_PLATFORM_LABELS = {
  twitch: 'Twitch',
  kick: 'Kick',
  youtube: 'YouTube',
  tiktok: 'TikTok'
};

function updateChatAccountUi() {
  const p = chatConfig.platforms || {};
  const platforms = ['twitch', 'kick', 'youtube', 'tiktok'];

  platforms.forEach((platform) => {
    const statusEl = chatAccountEls[platform];
    const cfg = p[platform] || {};
    const auth = cfg.auth;
    const tiktokUsernameEntered =
      platform === 'tiktok' && !!(cfg.username || chatTiktokUsername?.value?.trim());
    const signedIn = !!(
      auth?.accessToken ||
      tiktokUsernameEntered ||
      (platform === 'twitch' && cfg.oauthToken)
    );

    if (statusEl) {
      // accountName equals the platform name when profile fetch silently failed
      const isFallbackName = auth?.accountName === platform;
      if (auth?.accountName && !isFallbackName) {
        statusEl.textContent = `Signed in as ${auth.accountName}`;
        statusEl.classList.add('signed-in');
      } else if (signedIn && isFallbackName) {
        const hint =
          platform === 'youtube'
            ? 'Signed in — enable YouTube Data API v3 to show channel name'
            : platform === 'kick'
            ? 'Signed in — channel name unavailable'
            : `Signed in as ${platform}`;
        statusEl.textContent = hint;
        statusEl.classList.add('signed-in');
      } else if (signedIn && platform === 'twitch' && cfg.username) {
        statusEl.textContent = `Signed in as ${cfg.username}`;
        statusEl.classList.add('signed-in');
      } else if (platform === 'tiktok' && (cfg.username || chatTiktokUsername?.value?.trim())) {
        const uname = String(cfg.username || chatTiktokUsername?.value || '')
          .replace(/^@+/, '')
          .trim();
        const display = auth?.accountName && auth.accountName !== 'tiktok' ? auth.accountName : '';
        if (display && display.toLowerCase() !== uname.toLowerCase()) {
          statusEl.textContent = `Signed in as ${display} (@${uname})`;
        } else if (display) {
          statusEl.textContent = `Signed in as @${uname}`;
        } else {
          statusEl.textContent = `TikTok LIVE: @${uname}`;
        }
        statusEl.classList.add('signed-in');
      } else {
        statusEl.textContent = isOAuthConfigured(platform)
          ? 'Not signed in'
          : 'OAuth not configured — expand OAuth app setup above';
        statusEl.classList.remove('signed-in');
      }
    }

    document.querySelectorAll(`.chat-logout-btn[data-oauth="${platform}"]`).forEach((btn) => {
      btn.hidden = !signedIn;
    });
    document.querySelectorAll(`.chat-login-btn[data-oauth="${platform}"]`).forEach((btn) => {
      btn.disabled = false;
      btn.title = isOAuthConfigured(platform)
        ? ''
        : 'OAuth app IDs missing — expand OAuth app setup above and save, or reinstall from your dev build';
    });
  });
}

function readChatConfigFromUi() {
  const saved = chatConfig.platforms || {};
  return {
    platforms: {
      twitch: {
        enabled: !!chatEnableTwitch?.checked,
        channel:
          chatTwitchChannel?.value?.trim() ||
          saved.twitch?.channel ||
          saved.twitch?.auth?.channel ||
          '',
        oauthToken: chatTwitchOauth?.value || saved.twitch?.oauthToken || '',
        username: chatTwitchUsername?.value || saved.twitch?.username || '',
        auth: saved.twitch?.auth
      },
      kick: {
        enabled: !!chatEnableKick?.checked,
        channel: normalizeKickChannelInput(
          chatKickChannel?.value ||
            saved.kick?.channel ||
            saved.kick?.auth?.channel ||
            ''
        ),
        accessToken: saved.kick?.accessToken || saved.kick?.auth?.accessToken || '',
        accountId: saved.kick?.accountId || saved.kick?.auth?.accountId || '',
        auth: saved.kick?.auth
      },
      youtube: {
        enabled: !!chatEnableYoutube?.checked,
        channelId:
          chatYoutubeChannelId?.value?.trim() ||
          saved.youtube?.channelId ||
          saved.youtube?.auth?.channelId ||
          '',
        apiKey: chatYoutubeApiKey?.value || saved.youtube?.apiKey || '',
        auth: saved.youtube?.auth
      },
      tiktok: {
        enabled: !!chatEnableTiktok?.checked,
        username:
          chatTiktokUsername?.value?.trim() ||
          saved.tiktok?.username ||
          saved.tiktok?.auth?.username ||
          '',
        apiKey: chatTiktokApiKey?.value || saved.tiktok?.apiKey || '',
        auth: saved.tiktok?.auth
      }
    }
  };
}

function applyChatConfigToUi() {
  const p = chatConfig.platforms || {};
  if (chatEnableTwitch) chatEnableTwitch.checked = !!p.twitch?.enabled;
  if (chatTwitchChannel) chatTwitchChannel.value = p.twitch?.channel || p.twitch?.auth?.channel || '';
  if (chatTwitchUsername) chatTwitchUsername.value = p.twitch?.username || p.twitch?.auth?.username || '';
  if (chatTwitchOauth) chatTwitchOauth.value = p.twitch?.oauthToken || '';
  if (chatEnableKick) chatEnableKick.checked = !!p.kick?.enabled;
  if (chatKickChannel) chatKickChannel.value = p.kick?.channel || p.kick?.auth?.channel || '';
  if (chatEnableYoutube) chatEnableYoutube.checked = !!p.youtube?.enabled;
  if (chatYoutubeChannelId) {
    chatYoutubeChannelId.value = p.youtube?.channelId || p.youtube?.auth?.channelId || '';
  }
  if (chatYoutubeApiKey) chatYoutubeApiKey.value = p.youtube?.apiKey || '';
  if (chatEnableTiktok) chatEnableTiktok.checked = !!p.tiktok?.enabled;
  if (chatTiktokUsername) chatTiktokUsername.value = p.tiktok?.username || p.tiktok?.auth?.username || '';
  if (chatTiktokApiKey) chatTiktokApiKey.value = p.tiktok?.apiKey || '';
  updateChatAccountUi();
}

function formatChatStatusSummary(statuses = chatStatuses) {
  const enabled = Object.entries(chatConfig?.platforms || {})
    .filter(([, cfg]) => cfg?.enabled)
    .map(([platform]) => platform);
  const order = ['twitch', 'kick', 'youtube', 'tiktok'];
  const platforms = (enabled.length ? enabled : Object.keys(statuses)).sort(
    (a, b) => order.indexOf(a) - order.indexOf(b)
  );

  const parts = platforms.map((platform) => {
    const s = statuses[platform] || { platform, connected: false };
    const label = CHAT_PLATFORM_LABELS[platform] || platform;

    if (s.reconnecting && !s.connected) {
      return `${label}: reconnecting…`;
    }
    if (s.connected) {
      if (platform === 'twitch' && s.readOnly) return `${label} ✓ (read-only)`;
      return `${label} ✓`;
    }
    if (s.error) {
      const err = String(s.error);
      const short = err.length > 72 ? `${err.slice(0, 69)}…` : err;
      return `${label}: ${short}`;
    }
    if (s.hint) return `${label}: ${s.hint}`;
    if (s.connecting) {
      if (platform === 'youtube') return `${label}: waiting for you to go live…`;
      if (platform === 'twitch') return `${label}: connecting…`;
      if (platform === 'kick') return `${label}: connecting…`;
      if (platform === 'tiktok') return `${label}: connecting…`;
      return `${label}: connecting…`;
    }

    if (platform === 'twitch') {
      const ch =
        s.channel ||
        chatConfig.platforms?.twitch?.channel ||
        chatConfig.platforms?.twitch?.auth?.channel;
      return ch ? `${label}: click Connect` : `${label}: enter channel name`;
    }
    if (platform === 'kick') {
      const slug =
        s.channel ||
        chatConfig.platforms?.kick?.channel ||
        chatConfig.platforms?.kick?.auth?.channel;
      if (!slug && !chatConfig.platforms?.kick?.auth?.accessToken) {
        return `${label}: sign in with Browser`;
      }
      return `${label}: click Connect`;
    }
    if (platform === 'youtube') {
      return `${label}: not live — Go Live in Studio, then Connect`;
    }
    if (platform === 'tiktok') {
      const user =
        chatConfig.platforms?.tiktok?.username || chatConfig.platforms?.tiktok?.auth?.username;
      return user
        ? `${label}: only works while LIVE on TikTok`
        : `${label}: enter username + API key`;
    }
    return `${label}: off`;
  });
  return parts.length ? parts.join(' · ') : 'Enable platforms above, then Connect';
}

function formatChatSendErrors(errors = []) {
  return errors
    .map((e) => `${CHAT_PLATFORM_LABELS[e.platform] || e.platform}: ${e.error}`)
    .join(' · ');
}

function updateChatSendPlatformSelect() {
  if (!chatSendPlatform) return;
  const sendPlatforms = chatHub.getSendPlatforms();
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
  chatSendPlatform.disabled = false;
}

function getFilteredChatMessages(messages) {
  const list = messages || chatHub.getMessages();
  if (typeof SwiftSyncSupport === 'undefined') return list;
  return SwiftSyncSupport.filterChatMessages(list, {
    platform: chatFilterPlatform,
    modsOnly: chatModsOnly,
    dedupe: chatDedupe
  });
}

function renderChatMessages(messages) {
  if (!chatMessagesEl) return;
  chatMessagesEl.innerHTML = '';
  getFilteredChatMessages(messages).forEach((msg) => {
    const row = document.createElement('div');
    row.className = 'chat-msg';

    if (msg.platform) {
      const badge = document.createElement('span');
      badge.className = `chat-platform-badge ${msg.platform}`;
      badge.textContent = CHAT_PLATFORM_LABELS[msg.platform] || msg.platform;
      row.appendChild(badge);
    }

    const author = document.createElement('span');
    author.className = 'chat-msg-author';
    author.textContent = msg.author || 'unknown';
    if (msg.color) author.style.color = msg.color;

    const text = document.createElement('span');
    text.className = 'chat-msg-text';
    text.textContent = msg.text || '';

    row.append(author, text);

    chatMessagesEl.appendChild(row);
  });
  scrollChatToBottom();
}

function syncChatFromHub() {
  renderChatMessages(chatHub.getMessages());
  chatStatuses = chatHub.getStatuses();
  updateChatUi();
}

function updateChatUi() {
  chatStatuses = chatHub.getStatuses();
  chatConnected = chatHub.isAnyConnected();
  chatCanSend = chatHub.canSendAny();
  const connectedPlatforms = chatHub.getConnectedPlatforms();

  if (pillChat) {
    setPill(
      pillChat,
      chatConnected ? `Chat: ${connectedPlatforms.length} live` : 'Chat: offline',
      chatConnected
    );
  }

  if (chatStatusLine) {
    chatStatusLine.textContent = formatChatStatusSummary(chatStatuses);
  }

  updateChatSendPlatformSelect();
  if (chatSendInput) chatSendInput.disabled = !chatCanSend;
  if (chatSendBtn) chatSendBtn.disabled = !chatCanSend;
  updateChatDockPrereqs();
}

function buildChatPayload() {
  const statuses = chatHub.getStatuses();
  const connectedPlatforms = chatHub.getConnectedPlatforms();
  const sendPlatforms = chatHub.getSendPlatforms();
  return {
    messages: chatHub.getMessages(),
    channel: connectedPlatforms.length === 1 ? statuses[connectedPlatforms[0]]?.channel || null : null,
    connected: chatHub.isAnyConnected(),
    canSend: chatHub.canSendAny(),
    sendPlatforms,
    statuses,
    platforms: connectedPlatforms
  };
}

function sendChatStatusToMobile(extra = {}) {
  sendToMobile({
    type: 'chatStatus',
    ...buildChatPayload(),
    ...extra
  });
}

function pushChatToMobile(full = false) {
  const snapshot = buildChatPayload();
  sendToMobile({
    type: full ? 'chat' : 'chatBatch',
    ...snapshot
  });
  postChatViaHttp(snapshot);
}

function sendChatMessageToMobile(message) {
  sendToMobile({ type: 'chatMessage', message });
  postChatViaHttp(buildChatPayload());
}

function postChatViaHttp(snapshot) {
  try {
    const http = require('http');
    const body = JSON.stringify(snapshot || buildChatPayload());
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: getRelayPort(),
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        res.resume();
      }
    );
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (_) {}
}

function platformHasChatCredentials(platform, cfg = {}) {
  if (platform === 'twitch') {
    return !!(cfg.auth?.accessToken || cfg.oauthToken);
  }
  if (platform === 'kick') {
    return !!(cfg.auth?.accessToken || cfg.accessToken || cfg.channel);
  }
  if (platform === 'youtube') {
    return !!(
      (cfg.auth?.accessToken || cfg.apiKey) &&
      (cfg.channelId || cfg.auth?.channelId)
    );
  }
  if (platform === 'tiktok') {
    return !!(cfg.username || cfg.auth?.username);
  }
  return false;
}

function applyAutoEnableChatPlatforms(config) {
  const platforms = { ...(config.platforms || {}) };
  for (const platform of Object.keys(platforms)) {
    const cfg = platforms[platform];
    if (platformHasChatCredentials(platform, cfg)) {
      platforms[platform] = { ...cfg, enabled: true };
    }
  }
  return { ...config, platforms };
}

function scheduleAutoChatConnect(reason = 'startup') {
  if (chatAutoConnectInFlight) return;
  const now = Date.now();
  const urgent = ['manual', 'oauth', 'stream-live', 'mobile', 'status'].includes(reason);
  if (!urgent && now - lastChatConnectAttemptAt < CHAT_AUTO_DEBOUNCE_MS) return;
  if (chatAutoConnectTimer) return;
  chatAutoConnectTimer = setTimeout(() => {
    chatAutoConnectTimer = null;
    maintainChatConnections(reason).catch(() => {});
  }, 1500);
}

function startChatKeepAlive() {
  if (chatKeepAliveTimer) return;
  chatKeepAliveTimer = setInterval(() => {
    maintainChatConnections('keepalive').catch(() => {});
  }, CHAT_KEEPALIVE_MS);
}

async function syncChatConfigToCloud() {
  const rt = relayRuntime || refreshRelayRuntime();
  if (!rt.useCloud || !rt.cloudPublic) return { ok: false, skipped: true };
  const code = getPersistentPairingCode();
  if (!code) return { ok: false, error: 'no pairing code' };

  const credPlatforms = Object.entries(chatConfig?.platforms || {}).filter(([platform, cfg]) =>
    platformHasChatCredentials(platform, cfg)
  );
  if (!credPlatforms.length) return { ok: false, skipped: true, reason: 'no chat credentials' };

  try {
    const prepared = await prepareChatConfig(
      {
        ...chatConfig,
        relayHttpBase: rt.cloudPublic,
        relayHttpBases: getRelayHttpBases()
      },
      { forceAuthRefresh: false }
    );
    const res = await fetch(`${rt.cloudPublic}/api/chat-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: code, platforms: prepared.config.platforms })
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      supportDiag('Chat config synced to cloud for mobile-only mode');
    }
    return { ok: res.ok, ...body };
  } catch (err) {
    supportDiag(`Cloud chat sync failed: ${err?.message || err}`, 'warn');
    return { ok: false, error: err.message || String(err) };
  }
}

async function maintainChatConnections(reason = 'startup') {
  if (chatAutoConnectInFlight) return;
  if (!isRelayOpen()) {
    scheduleAutoChatConnect(reason);
    return;
  }

  chatConfig = applyAutoEnableChatPlatforms(loadChatConfig());
  const credPlatforms = Object.entries(chatConfig.platforms || {}).filter(
    ([platform, cfg]) => platformHasChatCredentials(platform, cfg)
  );
  if (!credPlatforms.length) return;

  const statuses = chatHub.getStatuses();
  const forceReconnect = ['stream-live', 'oauth', 'manual', 'mobile'].includes(reason);
  const needsWork = credPlatforms.some(([platform]) => {
    const st = statuses[platform] || {};
    if (st.connected && !forceReconnect) return false;
    if (!forceReconnect && (st.connecting || st.reconnecting)) return false;
    if (platform === 'youtube' && st.hint && !st.error && !forceReconnect) return false;
    if (
      !forceReconnect &&
      platform === 'twitch' &&
      st.error &&
      /sign-in expired|authentication failed/i.test(String(st.error))
    ) {
      return false;
    }
    return true;
  });
  if (!needsWork) return;

  chatConfig = saveChatConfig(chatConfig);
  applyChatConfigToUi();
  chatAutoConnectInFlight = true;
  lastChatConnectAttemptAt = Date.now();
  try {
    const prepared = await prepareChatConfig(
      {
        ...chatConfig,
        relayHttpBase: getRelayHttpBase(),
        relayHttpBases: getRelayHttpBases()
      },
      { forceAuthRefresh: forceReconnect }
    );
    if (prepared.authChanged) {
      chatConfig = saveChatConfig({ platforms: prepared.config.platforms });
      applyChatConfigToUi();
    }
    await chatHub.connectAll(prepared.config, { force: forceReconnect });
    syncChatFromHub();
    pushChatToMobile(true);
    sendChatStatusToMobile();
    syncChatConfigToCloud().catch(() => {});
    if (chatStatusLine) {
      chatStatusLine.textContent = formatChatStatusSummary(chatHub.getStatuses());
    }
  } catch (err) {
    console.error('[SwiftSync] Chat maintain failed:', err);
  } finally {
    chatAutoConnectInFlight = false;
    updateChatUi();
  }
}

async function autoConnectChatIfReady(reason = 'startup') {
  scheduleAutoChatConnect(reason);
}

async function handleChatConnect(options = {}) {
  const fromAuto = !!options.fromAuto;
  if (chatConnectBtn) chatConnectBtn.disabled = true;
  setChatFeedback('Connecting chat…', '#f0c14b');

  try {
    if (fromAuto) {
      chatConfig = applyAutoEnableChatPlatforms(loadChatConfig());
      saveChatConfig(chatConfig);
      applyChatConfigToUi();
    } else {
      chatConfig = saveChatConfig(readChatConfigFromUi());
      applyChatConfigToUi();
      chatConfig = applyAutoEnableChatPlatforms(chatConfig);
    }
    const enabled = Object.entries(chatConfig.platforms || {}).filter(
      ([platform, cfg]) => cfg.enabled && platformHasChatCredentials(platform, cfg)
    );
    if (!enabled.length) {
      setChatFeedback('Sign in to at least one platform above (or enable a checkbox)', '#ff4444');
      return;
    }

    const prepared = await prepareChatConfig(
      {
        ...chatConfig,
        relayHttpBase: getRelayHttpBase(),
        relayHttpBases: getRelayHttpBases()
      },
      { forceAuthRefresh: true }
    );
    if (prepared.authChanged) {
      chatConfig = saveChatConfig(prepared.config);
      applyChatConfigToUi();
    }
    if (prepared.config?.platforms) {
      chatConfig = saveChatConfig({ platforms: prepared.config.platforms });
      applyChatConfigToUi();
    }

    const kickCfg = prepared.config?.platforms?.kick;
    if (kickCfg?.enabled && !kickCfg.channel) {
      setChatFeedback('Kick: sign in with Browser or enter your kick.com username, then Connect', '#ff4444');
      return;
    }

    await chatHub.connectAll(prepared.config, { force: true });
    syncChatFromHub();

    const summary = formatChatStatusSummary(chatHub.getStatuses());
    const anyConnected = chatHub.isAnyConnected();
    if (chatStatusLine) chatStatusLine.textContent = summary;
    pushChatToMobile(true);
    sendChatStatusToMobile();
    syncChatConfigToCloud().catch(() => {});
    setStatus(anyConnected ? 'Chat connected' : summary, anyConnected ? '#00ff85' : '#f0c14b');
  } catch (err) {
    const msg = err.message || String(err);
    setChatFeedback(msg, '#ff4444');
    console.error('[SwiftSync] Chat connect failed:', err);
    updateChatUi();
  } finally {
    if (chatConnectBtn) chatConnectBtn.disabled = false;
    updateChatUi();
  }
}

function buildOAuthSavePartial(platform, auth, profile = {}) {
  const mergedAuth = { ...auth, ...profile };
  const partial = {
    platforms: {
      [platform]: {
        enabled: true,
        auth: mergedAuth
      }
    }
  };

  if (platform === 'twitch') {
    partial.platforms.twitch.channel = profile.channel || '';
    partial.platforms.twitch.username = profile.username || '';
    partial.platforms.twitch.oauthToken = auth.accessToken || '';
  } else if (platform === 'kick') {
    partial.platforms.kick.channel = profile.channel || '';
    partial.platforms.kick.accessToken = auth.accessToken || '';
    partial.platforms.kick.accountId = profile.accountId || auth.accountId || '';
  } else if (platform === 'youtube') {
    partial.platforms.youtube.channelId = profile.channelId || '';
  } else if (platform === 'tiktok') {
    partial.platforms.tiktok.username = profile.username || '';
  }

  return partial;
}

async function handleChatOAuthLogin(platform) {
  if (!platform) return;

  setChatPlatformSignInHint(platform, `Starting ${platform} sign-in…`, '#f0c14b');

  try {
    await ipcRenderer.invoke('swiftsync:oauth-reset');
  } catch (_) {}

  try {
    const repaired = await ipcRenderer.invoke('swiftsync:repair-oauth-config');
    if (repaired?.repaired) loadOAuthSetupForm();
  } catch (_) {}

  const uiApps = readOAuthSetupFromUi();
  if (oauthAppsHaveRealCredentials(uiApps)) {
    saveOAuthApps(uiApps);
    loadOAuthSetupForm();
  }

  let oauthReady = false;
  try {
    const check = await ipcRenderer.invoke('swiftsync:is-oauth-configured', platform);
    oauthReady = !!check?.configured;
    if (check?.appsPath) supportDiag(`OAuth config: ${check.appsPath}`);
  } catch (_) {
    oauthReady = isOAuthConfigured(platform);
  }

  if (!oauthReady) {
    const setupEl = document.getElementById('chat-oauth-setup');
    if (setupEl) {
      setupEl.hidden = false;
      setupEl.open = true;
    }
    setChatPlatformSignInHint(
      platform,
      `OAuth not configured for ${platform}. Expand “OAuth app setup” above, paste your Client ID/Secret, click Save OAuth credentials, then try again.`,
      '#ff4444'
    );
    return;
  }

  try {
    setChatPlatformSignInHint(
      platform,
      'Opening your browser now — sign in there, then return here. (Check the taskbar if you do not see a window.)',
      '#f0c14b'
    );
    const rt = relayRuntime || refreshRelayRuntime();
    const { auth, profile, profileError } = await ipcRenderer.invoke('swiftsync:browser-oauth', {
      platform,
      relayHttpBase: rt.useCloud && (rt.cloudPublic || rt.cloudUrl) ? getRelayHttpBase() : ''
    });
    chatConfig = saveChatConfig(buildOAuthSavePartial(platform, auth, profile));
    applyChatConfigToUi();
    updateChatAccountUi();
    if (profileError) {
      const hint =
        platform === 'youtube'
          ? ' — enable YouTube Data API v3 in Google Cloud Console'
          : platform === 'kick'
          ? ' — Kick redirect URI must be http://localhost:8877/oauth/callback'
          : '';
      setChatPlatformSignInHint(
        platform,
        `Signed in to ${platform}, but profile fetch failed: ${profileError}${hint}`,
        '#f0c14b'
      );
    } else {
      setChatPlatformSignInHint(platform, `Signed in to ${platform}`, '#00ff85');
    }
    startChatKeepAlive();
    await maintainChatConnections('oauth');
    scheduleAutoChatConnect('oauth');
  } catch (err) {
    const msg = err?.message || String(err);
    setChatPlatformSignInHint(platform, msg, '#ff4444');
    console.error('[SwiftSync] OAuth login failed:', err);
  }
}

function handleChatOAuthLogout(platform) {
  const clear = { enabled: false, auth: null };
  if (platform === 'twitch') {
    Object.assign(clear, { oauthToken: '', username: '', channel: '' });
  } else if (platform === 'kick') {
    clear.channel = '';
  } else if (platform === 'youtube') {
    clear.channelId = '';
  } else if (platform === 'tiktok') {
    clear.username = '';
  }

  chatConfig = saveChatConfig({ platforms: { [platform]: clear } });
  chatHub.disconnectAll();
  applyChatConfigToUi();
  syncChatFromHub();
  pushChatToMobile(true);
  sendChatStatusToMobile();
  setStatus(`Disconnected ${platform}`, '#9aa0a6');
}

function applyRelayOAuthBanner() {
  const setupEl = document.getElementById('chat-oauth-setup');
  if (!setupEl) return;

  const rt = relayRuntime || refreshRelayRuntime();
  const usingCloudRelay = !!(rt.useCloud && rt.cloudUrl);

  // Remove any existing banner
  const existing = document.getElementById('relay-oauth-banner');
  if (existing) existing.remove();

  const oauthReady = Object.values(getOAuthSetupStatus()).some(Boolean);

  if (usingCloudRelay) {
    const banner = document.createElement('p');
    banner.id = 'relay-oauth-banner';
    banner.className = 'relay-oauth-banner';
    banner.textContent = oauthReady
      ? '✓ Relay online — click Sign In below for each platform.'
      : '✓ Relay online — expand OAuth app setup above and add your client IDs (same as npm start folder), then Sign In.';
    setupEl.before(banner);
    setupEl.hidden = oauthReady;
  } else {
    setupEl.hidden = false;
  }
}

function loadOAuthSetupForm() {
  ensureOAuthAppsFile();
  const apps = loadOAuthApps();
  if (chatOauthRedirectUri) {
    chatOauthRedirectUri.textContent = apps.redirectUri || DEFAULT_REDIRECT;
  }
  if (oauthTwitchClientId) oauthTwitchClientId.value = apps.twitch?.clientId || '';
  if (oauthTwitchClientSecret) oauthTwitchClientSecret.value = apps.twitch?.clientSecret || '';
  if (oauthKickClientId) oauthKickClientId.value = apps.kick?.clientId || '';
  if (oauthKickClientSecret) oauthKickClientSecret.value = apps.kick?.clientSecret || '';
  if (oauthYoutubeClientId) oauthYoutubeClientId.value = apps.youtube?.clientId || '';
  if (oauthYoutubeClientSecret) oauthYoutubeClientSecret.value = apps.youtube?.clientSecret || '';
  if (oauthTiktokClientKey) {
    oauthTiktokClientKey.value = apps.tiktok?.clientKey || apps.tiktok?.clientId || '';
  }
  if (oauthTiktokClientSecret) oauthTiktokClientSecret.value = apps.tiktok?.clientSecret || '';
}

function readOAuthSetupFromUi() {
  return {
    redirectUri: chatOauthRedirectUri?.textContent?.trim() || DEFAULT_REDIRECT,
    twitch: {
      clientId: oauthTwitchClientId?.value?.trim() || '',
      clientSecret: oauthTwitchClientSecret?.value?.trim() || ''
    },
    kick: {
      clientId: oauthKickClientId?.value?.trim() || '',
      clientSecret: oauthKickClientSecret?.value?.trim() || ''
    },
    youtube: {
      clientId: oauthYoutubeClientId?.value?.trim() || '',
      clientSecret: oauthYoutubeClientSecret?.value?.trim() || ''
    },
    tiktok: {
      clientKey: oauthTiktokClientKey?.value?.trim() || '',
      clientSecret: oauthTiktokClientSecret?.value?.trim() || ''
    }
  };
}

function handleSaveOAuthApps() {
  saveOAuthApps(readOAuthSetupFromUi());
  loadOAuthSetupForm();
  updateChatAccountUi();
  setStatus('OAuth credentials saved', '#00ff85');
}

function handleOpenOAuthConfigFolder() {
  ensureOAuthAppsFile();
  const configPath = getUserDataOAuthPath();
  shell.showItemInFolder(configPath);
}

function initChatHub() {
  const { ensureChatConfigFile } = require('./chat-config');
  ensureChatConfigFile();
  ensureOAuthAppsFile();
  chatConfig = applyAutoEnableChatPlatforms(loadChatConfig());
  saveChatConfig(chatConfig);
  loadOAuthSetupForm();
  applyRelayOAuthBanner();
  applyChatConfigToUi();
  updateChatAccountUi();

  chatHub.on('message', (msg) => {
    syncChatFromHub();
    sendChatMessageToMobile(msg);
  });

  chatHub.on('status', () => {
    const kickSt = chatHub.getStatuses().kick;
    if (kickSt?.channel && chatKickChannel && chatKickChannel.value !== kickSt.channel) {
      chatKickChannel.value = kickSt.channel;
      chatConfig = saveChatConfig({
        platforms: { kick: { channel: kickSt.channel } }
      });
    }
    syncChatFromHub();
    sendChatStatusToMobile();
    if (chatHub.isAnyConnected()) pushChatToMobile(true);
    updateChatUi();

    const statuses = chatHub.getStatuses();
    const cfg = applyAutoEnableChatPlatforms(loadChatConfig());
    const shouldRetry = Object.entries(cfg.platforms || {}).some(([platform, pcfg]) => {
      if (!platformHasChatCredentials(platform, pcfg)) return false;
      const st = statuses[platform] || {};
      if (st.connected || st.connecting || st.reconnecting) return false;
      if (platform === 'youtube' && st.hint && !st.error) return false;
      if (
        platform === 'twitch' &&
        st.error &&
        /sign-in expired|authentication failed/i.test(String(st.error))
      ) {
        return false;
      }
      return true;
    });
    if (shouldRetry) scheduleAutoChatConnect('status');
  });

  scheduleAutoChatConnect('init');
  startChatKeepAlive();
  updateChatUi();
}

function postSceneSourcesViaHttp(payload) {
  try {
    const http = require('http');
    const body = JSON.stringify({
      sceneName: payload.sceneName || activeSceneName,
      panels: payload.panels || []
    });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: getRelayPort(),
        path: '/api/scene-sources',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        res.resume();
      }
    );
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (_) {}
}

function getActiveSceneLink() {
  return sceneLinks.find((l) => l.main.sceneName === activeSceneName) || null;
}

function createSceneCard(sceneName, link) {
  const wrap = document.createElement('div');
  wrap.className = 'scene-card-wrap' + (link.main.sceneName === activeSceneName ? ' active' : '');
  wrap.dataset.sceneName = link.main.sceneName;

  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'scene-card main-pane';
  card.title = 'View sources for this scene';

  const label = document.createElement('span');
  label.className = 'scene-card-label';
  label.textContent = 'Scene';

  const hint = document.createElement('span');
  hint.className = 'scene-card-switch-hint';
  hint.textContent = 'Tap card to switch OBS';

  const name = document.createElement('span');
  name.className = 'scene-card-name';
  name.textContent = sceneName;

  card.append(label, hint, name);

  if (link?.vertical?.sceneName && dualCanvasMode) {
    const vert = document.createElement('span');
    vert.className = 'scene-card-vertical-link';
    vert.textContent = `↳ ${link.vertical.sceneName}`;
    card.append(vert);
  }

  card.addEventListener('click', async () => {
    try {
      await switchScene(link.main.sceneName);
    } catch (err) {
      setStatus('Switch failed: ' + (err.message || err), '#ff4444');
    }
  });

  // "Switch" button actually changes the live OBS scene.
  const switchBtn = document.createElement('button');
  switchBtn.type = 'button';
  switchBtn.className = 'scene-switch-btn';
  switchBtn.title = 'Switch to this scene in OBS (same as tapping the card)';
  switchBtn.textContent = '▶';
  switchBtn.setAttribute('aria-label', 'Switch OBS scene');
  switchBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await switchScene(link.main.sceneName);
    } catch (err) {
      setStatus('Switch failed: ' + (err.message || err), '#ff4444');
    }
  });

  wrap.append(card, switchBtn);
  return wrap;
}

function renderSceneList() {
  sceneListEl.innerHTML = '';
  sceneListEl.className = 'scene-grid-pc';

  if (!sceneLinks.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = 'No scenes found — add scenes in OBS.';
    sceneListEl.appendChild(empty);
    return;
  }

  for (const link of sceneLinks) {
    sceneListEl.appendChild(createSceneCard(link.main.sceneName, link));
  }
}

async function refreshScenes() {
  verticalSceneNameProbeCache.clear();
  let rawCanvases = [];
  try {
    rawCanvases = await obsController.getCanvasList();
  } catch (err) {
    console.error('[SwiftSync] getCanvasList failed:', err);
  }
  canvasOptions = resolveCanvasOptions(rawCanvases);

  // Optional: enrich canvas metadata from Aitum vendor (never required)
  aitumCanvasCache = [];
  try {
    const aitumCanvases = await obsController.getAitumCanvases();
    if (aitumCanvases.length) {
      aitumCanvasCache = aitumCanvases;
      canvasOptions = mergeCanvasOptionsWithAitum(canvasOptions, aitumCanvases);
    }
  } catch {
    /* standard OBS multi-canvas only */
  }

  const picked = pickMainAndVerticalCanvases(canvasOptions);
  const pair = resolveCanvasPair(canvasOptions);

  mainCanvasUuid = pair.mainUuid;
  verticalCanvasUuid = pair.verticalUuid;
  dualCanvasMode = !!(picked.main && picked.vertical);

  let mainEntries = picked.main
    ? await obsController.getScenesForCanvas(picked.main)
    : await obsController.getScenesForCanvas(null);
  let verticalEntries = picked.vertical
    ? await loadVerticalSceneEntries(picked.vertical, mainEntries)
    : [];

  console.log(
    `[SwiftSync canvas] landscape="${picked.main?.name || '?'}" ${picked.main?.width || '?'}×${picked.main?.height || '?'}` +
      ` vertical="${picked.vertical?.name || 'none'}" ${picked.vertical?.width || '?'}×${picked.vertical?.height || '?'}` +
      ` scenes: main=${mainEntries.length} vertical=${verticalEntries.length}`
  );

  let verticalMode = 'none';

  if (dualCanvasMode && !verticalEntries.length && picked.vertical && mainEntries.length) {
    verticalEntries = mainEntries.map((entry) => {
      const mainName = sceneEntryName(entry);
      return {
        sceneName: mainName,
        sceneUuid: null,
        canvasUuid: picked.vertical.uuid,
        _synthetic: true
      };
    });
    verticalMode = 'synthetic';
    console.warn(
      '[SwiftSync vertical] Vertical scene list empty — assuming SE.Live linked scenes use identical names. ' +
        'If your vertical scenes have different names, the source list may be empty until you match them.'
    );
  }

  if (dualCanvasMode && !verticalEntries.length) {
    for (const canvas of canvasOptions) {
      if (canvas === picked.main) continue;
      const entries = await loadVerticalSceneEntries(canvas, mainEntries);
      if (entries.length) {
        verticalEntries = entries;
        verticalCanvasUuid = canvas.uuid ?? verticalCanvasUuid;
        verticalMode = entries.filter(Boolean).some((e) => e._probed) ? 'probed' : 'enumerated';
        break;
      }
    }
  }

  if (!mainEntries.length) {
    mainEntries = await obsController.getScenesForCanvas(null);
  }

  // Single-canvas SE.Live: pair scenes by name suffix when GetCanvasList returns one canvas.
  if (!dualCanvasMode && mainEntries.length) {
    const allNames = mainEntries.map(sceneEntryName).filter(Boolean);
    const split = splitMainAndVerticalSceneNames(allNames);
    if (split.verticalScenes.length && split.mainScenes.length < allNames.length) {
      verticalEntries = split.verticalScenes
        .map((name) => findSceneEntry(mainEntries, name))
        .filter(Boolean);
    }
  }

  const verticalEntriesResolved = (verticalEntries || []).filter(Boolean);
  if (verticalMode === 'none' && verticalEntriesResolved.length) {
    verticalMode = verticalEntriesResolved.some((e) => e._probed) ? 'probed' : 'enumerated';
  }

  updateCanvasDiagnostic({
    canvases: canvasOptions,
    rawCount: rawCanvases.length,
    main: picked.main,
    vertical: picked.vertical,
    mainSceneCount: mainEntries.length,
    verticalSceneCount: verticalEntriesResolved.length,
    dualCanvasMode,
    verticalMode
  });

  const useDualCanvas = dualCanvasMode && !!picked.vertical;
  lastVerticalEntries = verticalEntriesResolved.slice();
  lastVerticalScenes = verticalEntriesResolved.map(sceneEntryName).filter(Boolean);

  if (useDualCanvas) {
    renderVerticalMappingUi(mainEntries.map(sceneEntryName).filter(Boolean));
    bindVerticalMappingActions();
  } else {
    const section = document.getElementById('vertical-mapping-section');
    if (section) section.style.display = 'none';
  }
  sceneLinks = pairAllSceneLinks(
    mainEntries,
    verticalEntriesResolved,
    mainCanvasUuid,
    verticalCanvasUuid,
    useDualCanvas
  );

  if (useDualCanvas) {
    const vUuid = getVerticalCanvasUuid();
    const vCanvasName = getCanvasNameForUuid(vUuid) || picked.vertical?.name || null;
    const mUuid = mainCanvasUuid;
    if (vUuid) {
      for (let i = 0; i < sceneLinks.length; i += 1) {
        const link = sceneLinks[i];
        if (link.vertical) {
          link.vertical.canvasUuid = vUuid;
          const verticalEntry =
            (link.vertical?.sceneName &&
              findSceneEntry(verticalEntriesResolved, link.vertical.sceneName)) ||
            verticalEntriesResolved.find((e) => e._pairedToMainName === link.main.sceneName) ||
            null;
          if (verticalEntry?.sceneUuid && !verticalSceneUuidLooksLikeMain(verticalEntry.sceneUuid, link)) {
            link.vertical.sceneUuid = verticalEntry.sceneUuid;
          } else {
            link.vertical.sceneUuid = null;
            if (link.vertical.sceneName) {
              const resolved = await resolveSceneUuidForCanvas(
                link.vertical.sceneName,
                vUuid,
                vCanvasName
              );
              if (resolved && !verticalSceneUuidLooksLikeMain(resolved, link)) {
                link.vertical.sceneUuid = resolved;
              }
            }
          }
        }
        if (link.main && !link.main.sceneUuid && link.main.sceneName && mUuid) {
          link.main.sceneUuid = await resolveSceneUuidForCanvas(link.main.sceneName, mUuid);
        }
      }
    }
  }

  if (dualCanvasMode && verticalCanvasUuid && sceneLinks.length) {
    await refreshVerticalSceneNamesFromProbe();
  }

  if (sceneLinks.length) {
    let currentMain = null;
    if (picked.main?.uuid) {
      try {
        currentMain = (await obsController.getSceneList(picked.main.uuid)).currentProgramSceneName;
      } catch { /* ignore */ }
    }
    if (!currentMain) {
      try {
        currentMain = (await obsController.getSceneList(null)).currentProgramSceneName;
      } catch { /* ignore */ }
    }
    activeSceneName = currentMain || activeSceneName || sceneEntryName(mainEntries[0]) || null;
  } else if (verticalEntries.length) {
    sceneLinks = verticalEntries.map((entry) => ({
      main: {
        sceneName: sceneEntryName(entry),
        sceneUuid: sceneEntryUuid(entry),
        canvasUuid: verticalCanvasUuid
      },
      vertical: null
    }));
    activeSceneName = sceneEntryName(verticalEntries[0]);
  } else {
    sceneLinks = [];
    activeSceneName = null;
  }

  if (canvasHintEl) {
    canvasHintEl.textContent = 'Program scene — show or hide sources on the main canvas.';
  }

  try {
    renderSceneList();
    highlightActiveScene(activeSceneName);
    updateCanvasVerticalStatus();
    await refreshSceneSources();
    await refreshGlobalAudio();
    await pushObsStateToMobile();
  } catch (err) {
    console.error('[SwiftSync] refreshScenes final render failed:', err);
    renderSceneList();
  }
  updateCanvasVerticalStatus();
}

function highlightActiveScene(name) {
  sceneListEl.querySelectorAll('.scene-card-wrap').forEach((wrap) => {
    wrap.classList.toggle('active', wrap.dataset.sceneName === name);
  });
}

async function switchScene(sceneName) {
  if (!sceneName) return;
  if (!obsController.connected) {
    throw new Error('OBS not connected on PC — connect on the Home tab first.');
  }
  const link = sceneLinks.find((l) => l.main.sceneName === sceneName);
  if (!link) return;

  sceneSwitchInProgress = true;
  try {
    await obsController.setProgramScene(sceneName, link.main.canvasUuid ?? mainCanvasUuid);

    const linkIndex = sceneLinks.findIndex((l) => l.main.sceneName === sceneName);
    const vScene = link.vertical?.sceneName || lastVerticalScenes[linkIndex] || null;
    const vCanvas = verticalCanvasUuidForLink(link);
    const mainUuid = link.main.canvasUuid ?? mainCanvasUuid;

    if (vCanvas && vCanvas !== mainUuid) {
      try {
        const current = await obsController.getCurrentProgramScene(vCanvas);
        const needsSync =
          current?.sceneName && !verticalSceneMatchesMain(current.sceneName, sceneName);
        if (needsSync) {
          await obsController.setProgramScene(sceneName, vCanvas);
        }
      } catch (e) {
        console.warn('Vertical linked scene sync (sceneName+canvasUuid)', e);
      }
    } else if (vScene && dualCanvasMode && !vCanvas) {
      console.warn('Vertical scene switch skipped: no vertical canvas UUID');
      sendToMobile({
        type: 'error',
        message: 'Vertical canvas not found — click Refresh Scenes on the PC Scenes tab.'
      });
    }

    activeSceneName = sceneName;
    highlightActiveScene(sceneName);
    updateCanvasVerticalStatus();
    await refreshSceneSources(sceneName);

    sendToMobile({
      type: 'sceneChanged',
      sceneName,
      linkedSceneName: vScene,
      mainCanvasUuid: link.main.canvasUuid,
      verticalCanvasUuid: vCanvas || null
    });
    await pushObsStateToMobile();
  } finally {
    sceneSwitchInProgress = false;
  }
}

// Tools
function setToolState(el, active, onLabel, offLabel, activeClass) {
  if (!el) return;
  el.textContent = active ? onLabel : offLabel;
  el.classList.toggle('on', activeClass === 'on' && active);
  el.classList.toggle('live', activeClass === 'live' && active);
}

async function refreshToolsUi() {
  if (!obsController.connected) return;
  try {
    const stream = await obsController.getStreamStatus();
    setToolState(stateStream, stream.outputActive, 'LIVE', 'offline', 'live');
    if (streamToggleBtn) streamToggleBtn.classList.toggle('live', stream.outputActive);
  } catch { /* optional */ }

  try {
    const record = await obsController.getRecordStatus();
    setToolState(stateRecord, record.outputActive, 'ON', 'off', 'on');
    if (recordToggleBtn) recordToggleBtn.classList.toggle('live', record.outputActive);
  } catch { /* optional */ }

  try {
    const replay = await obsController.getReplayBufferStatus();
    setToolState(stateReplay, replay.outputActive, 'ON', 'off', 'on');
    if (replayToggleBtn) replayToggleBtn.classList.toggle('live', replay.outputActive);
  } catch { /* optional */ }

  try {
    const vcam = await obsController.getVirtualCamStatus();
    setToolState(stateVcam, vcam.outputActive, 'ON', 'off', 'on');
    if (vcamToggleBtn) vcamToggleBtn.classList.toggle('live', vcam.outputActive);
  } catch { /* optional */ }

  try {
    const studio = await obsController.getStudioModeEnabled();
    setToolState(stateStudio, studio.studioModeEnabled, 'ON', 'off', 'live');
    if (studioToggleBtn) studioToggleBtn.classList.toggle('live', studio.studioModeEnabled);
  } catch { /* optional */ }
}

async function toolAction(fn, label) {
  if (!obsController.connected) return;
  try {
    await fn();
    await refreshToolsUi();
  } catch (e) {
    setStatus(`${label}: ${e.message}`, '#ff4444');
  }
}

streamToggleBtn?.addEventListener('click', () => toolAction(() => obsController.toggleStream(), 'Stream'));
recordToggleBtn?.addEventListener('click', () => toolAction(() => obsController.toggleRecord(), 'Record'));
recordPauseBtn?.addEventListener('click', () => toolAction(() => obsController.pauseRecord(), 'Pause'));
replayToggleBtn?.addEventListener('click', () => toolAction(() => obsController.toggleReplayBuffer(), 'Replay'));
replaySaveBtn?.addEventListener('click', () => toolAction(() => obsController.saveReplayBuffer(), 'Save replay'));
vcamToggleBtn?.addEventListener('click', () => toolAction(() => obsController.toggleVirtualCam(), 'Virtual cam'));
studioToggleBtn?.addEventListener('click', async () => {
  if (!obsController.connected) return;
  try {
    const { studioModeEnabled } = await obsController.getStudioModeEnabled();
    await obsController.setStudioModeEnabled(!studioModeEnabled);
    await refreshToolsUi();
  } catch (e) {
    setStatus(`Studio: ${e.message}`, '#ff4444');
  }
});

async function diagnoseVerticalSources() {
  if (!obsController.connected) {
    setStatus('Connect to OBS first', '#ff4444');
    return;
  }

  const lines = [];
  const push = (line) => {
    lines.push(line);
    console.log(`[SwiftSync diagnose] ${line}`);
  };

  push(`SwiftSync vertical diagnose — ${new Date().toISOString()}`);
  push(
    `dualCanvasMode=${dualCanvasMode} mainUuid=${mainCanvasUuid || '?'} verticalUuid=${verticalCanvasUuid || '?'}`
  );
  push(`activeScene="${activeSceneName || '?'}" sceneLinks=${sceneLinks.length}`);

  let rawCanvases = [];
  try {
    const { canvases } = await obsController.call('GetCanvasList');
    rawCanvases = canvases || [];
    push(`GetCanvasList → ${rawCanvases.length} canvas(es):`);
    rawCanvases.forEach((c, i) => {
      const name = c.canvasName || c.name || '?';
      const uuid = (c.canvasUuid || c.uuid || '?').slice(0, 8);
      const w = c.baseWidth ?? c.canvasWidth ?? c.width ?? '?';
      const h = c.baseHeight ?? c.canvasHeight ?? c.height ?? '?';
      push(`  [${i}] "${name}" uuid=${uuid}… ${w}x${h}`);
    });
  } catch (e) {
    push(`GetCanvasList ERROR: ${e.message || e}`);
  }

  const canvasRefs = rawCanvases.length
    ? rawCanvases.map((c) => ({
        uuid: c.canvasUuid || c.uuid || null,
        name: c.canvasName || c.name || null
      }))
    : [{ uuid: null, name: 'default' }];

  for (const ref of canvasRefs) {
    const label = ref.name || (ref.uuid ? `${ref.uuid.slice(0, 8)}…` : 'default');
    try {
      const list = await obsController.getSceneList(ref.uuid || undefined);
      const scenes = list.scenes || [];
      push(
        `GetSceneList(${label}) → ${scenes.length} scenes, program="${list.currentProgramSceneName || '?'}" progUuid=${(list.currentProgramSceneUuid || '?').slice(0, 8)}…`
      );
      scenes.forEach((s, i) => {
        push(
          `    [${i}] "${s.sceneName}" uuid=${(s.sceneUuid || s.uuid || '?').slice(0, 8)}…`
        );
      });
    } catch (e) {
      push(`GetSceneList(${label}) ERROR: ${e.message || e}`);
    }

    try {
      const prog = await obsController.getCurrentProgramScene(ref.uuid || null);
      push(
        `GetCurrentProgramScene(${label}) → "${prog?.sceneName || '?'}" uuid=${(prog?.sceneUuid || '?').slice(0, 8)}…`
      );
    } catch (e) {
      push(`GetCurrentProgramScene(${label}) unavailable: ${e.message || e}`);
    }
  }

  const link = getActiveSceneLink();
  const linkIndex = link ? sceneLinks.indexOf(link) : -1;
  if (link) {
    push(
      `Active link[${linkIndex}]: main="${link.main?.sceneName}" vertical="${link.vertical?.sceneName || '(none)'}" vSceneUuid=${(link.vertical?.sceneUuid || '?').slice(0, 8)}…`
    );
  } else {
    push('Active link: none');
  }

  const verticalScene = link ? await resolveVerticalSceneForLink(link, linkIndex) : null;
  if (verticalScene) {
    push(
      `resolveVerticalSceneForLink → "${verticalScene.sceneName}" uuid=${(verticalScene.sceneUuid || '?').slice(0, 8)}… canvas="${verticalScene.canvasName || verticalScene.canvasUuid || '?'}"`
    );
  } else {
    push('resolveVerticalSceneForLink → NULL');
  }

  const targetCanvasUuid = verticalScene?.canvasUuid || getVerticalCanvasUuid() || null;
  const mainForProbe = link?.main?.sceneName || activeSceneName;
  const mainSceneUuid = link?.main?.sceneUuid || null;

  if (mainSceneUuid && targetCanvasUuid) {
    push('SE.Live linked scene fetch (main scene UUID on vertical canvas):');
    try {
      const { sceneItems = [] } = await obsController.getSceneItemList(
        null,
        targetCanvasUuid,
        mainSceneUuid,
        null
      );
      push(`  linked sceneUuid+canvasUuid: OK (${sceneItems.length} item(s))${sceneItems.length ? ` — first="${sceneItems[0]?.sourceName}"` : ''}`);
    } catch (e) {
      push(`  linked sceneUuid+canvasUuid: ${e.message || e}`);
    }
    try {
      const { sceneItems = [] } = await obsController.getSceneItemList(
        mainForProbe,
        targetCanvasUuid,
        null,
        null
      );
      push(`  main sceneName+canvasUuid ("${mainForProbe}"): OK (${sceneItems.length} item(s))`);
    } catch (e) {
      push(`  main sceneName+canvasUuid: ${sceneListErrorLooksLikeMissingScene(e) ? 'NOT FOUND' : e.message || e}`);
    }
  }

  if (mainForProbe && targetCanvasUuid) {
    push(`Probe vertical scene names for main "${mainForProbe}" (SE.Live linked scenes usually skip this):`);
    const candidates = verticalNameCandidatesForMain(mainForProbe);
    if (link?.vertical?.sceneName) candidates.unshift(link.vertical.sceneName);
    const seenProbe = new Set();
    for (const candidate of candidates) {
      const key = candidate.toLowerCase();
      if (seenProbe.has(key)) continue;
      seenProbe.add(key);
      try {
        const { sceneItems = [] } = await obsController.getSceneItemList(
          candidate,
          targetCanvasUuid,
          null,
          null
        );
        push(`  "${candidate}": OK (${sceneItems.length} item(s))`);
      } catch (e) {
        push(`  "${candidate}": ${sceneListErrorLooksLikeMissingScene(e) ? 'NOT FOUND' : e.message || e}`);
      }
    }
  }

  const targetSceneName =
    verticalScene?.sceneName || link?.vertical?.sceneName || activeSceneName;
  let targetSceneUuid = verticalScene?.sceneUuid || link?.vertical?.sceneUuid || null;
  if (link && verticalSceneUuidLooksLikeMain(targetSceneUuid, link)) {
    targetSceneUuid = null;
  }
  const targetCanvasName =
    verticalScene?.canvasName || getCanvasNameForUuid(targetCanvasUuid);

  const paramCombos = [
    { label: 'sceneName+canvasUuid (SE.Live)', sceneName: targetSceneName, canvasUuid: targetCanvasUuid },
    { label: 'sceneName+canvasUuid+canvasName', sceneName: targetSceneName, canvasUuid: targetCanvasUuid, canvasName: targetCanvasName },
    { label: 'sceneName+canvasName', sceneName: targetSceneName, canvasName: targetCanvasName },
    { label: 'sceneName only', sceneName: targetSceneName },
    { label: 'sceneUuid+canvasUuid', sceneUuid: targetSceneUuid, canvasUuid: targetCanvasUuid },
    {
      label: 'sceneUuid+canvasName',
      sceneUuid: targetSceneUuid,
      canvasName: targetCanvasName
    },
    { label: 'sceneUuid only', sceneUuid: targetSceneUuid },
    {
      label: 'sceneUuid+canvasUuid+canvasName',
      sceneUuid: targetSceneUuid,
      canvasUuid: targetCanvasUuid,
      canvasName: targetCanvasName
    },
    {
      label: 'sceneName+canvasUuid+canvasName (legacy)',
      sceneName: targetSceneName,
      canvasUuid: targetCanvasUuid,
      canvasName: targetCanvasName
    }
  ];

  push(`GetSceneItemList attempts for "${targetSceneName || '?'}":`);
  let bestItemCount = -1;
  for (const combo of paramCombos) {
    if (!combo.sceneName && !combo.sceneUuid) {
      push(`  ${combo.label}: SKIP (no scene ref)`);
      continue;
    }
    try {
      const { sceneItems = [] } = await obsController.getSceneItemList(
        combo.sceneName,
        combo.canvasUuid || null,
        combo.sceneUuid || null,
        combo.canvasName || null
      );
      if (sceneItems.length > bestItemCount) bestItemCount = sceneItems.length;
      push(
        `  ${combo.label}: ${sceneItems.length} item(s)${sceneItems.length ? ` — first="${sceneItems[0]?.sourceName}"` : ''}`
      );
    } catch (e) {
      push(`  ${combo.label}: ERROR ${e.message || e}`);
    }
  }

  if (lastVerticalFetchDebug?.strategies?.length) {
    push('Last vertical fetch strategies:');
    lastVerticalFetchDebug.strategies.forEach((s) => {
      push(`  ${s.label}: count=${s.count}${s.error ? ` err=${s.error}` : ''}`);
    });
  }

  const report = lines.join('\n');
  if (canvasHintEl) {
    canvasHintEl.textContent =
      `Diagnose: ${rawCanvases.length} canvas(es), best GetSceneItemList=${bestItemCount >= 0 ? bestItemCount : '?'} items. Full report in modal/console.`;
  }

  showDiagnoseVerticalModal(report);
}

function showDiagnoseVerticalModal(text) {
  let overlay = document.getElementById('diagnose-vertical-modal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'diagnose-vertical-modal';
    overlay.className = 'diagnose-modal-overlay';
    overlay.innerHTML = `
      <div class="diagnose-modal">
        <h3>Vertical source diagnose</h3>
        <p class="diagnose-modal-note">Copy this report if vertical sources are still empty.</p>
        <textarea readonly id="diagnose-vertical-text" spellcheck="false"></textarea>
        <div class="diagnose-modal-actions">
          <button type="button" id="diagnose-copy-btn" class="tool-btn subtle">Copy</button>
          <button type="button" id="diagnose-close-btn" class="tool-btn subtle">Close</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#diagnose-close-btn').addEventListener('click', () => {
      overlay.style.display = 'none';
    });
    overlay.querySelector('#diagnose-copy-btn').addEventListener('click', () => {
      const ta = overlay.querySelector('#diagnose-vertical-text');
      ta.select();
      try {
        require('electron').clipboard.writeText(ta.value);
        setStatus('Diagnose report copied to clipboard', '#00ff85');
      } catch {
        document.execCommand('copy');
        setStatus('Diagnose report copied', '#00ff85');
      }
    });
  }
  overlay.querySelector('#diagnose-vertical-text').value = text;
  overlay.style.display = 'flex';
}

refreshScenesBtn?.addEventListener('click', () => {
  if (obsController.connected) refreshScenes().catch((e) => setStatus(e.message, '#ff4444'));
});

refreshAudioBtn?.addEventListener('click', () => {
  if (obsController.connected) refreshGlobalAudio().catch((e) => setStatus(e.message, '#ff4444'));
  else setStatus('Connect to OBS first', '#ff4444');
});

refreshToolsBtn?.addEventListener('click', () => {
  if (obsController.connected) refreshToolsUi().catch((e) => setStatus(e.message, '#ff4444'));
});

regeneratePairingBtn?.addEventListener('click', async () => {
  const newCode = rotatePersistentPairingCode();
  if (isRelayOpen()) {
    sendRelayJson({ type: 'pairing', action: 'rotate', pairingCode: newCode });
  } else {
    connectRelay();
  }
  await updatePairingQr({ code: newCode }, { force: true });
});

// ---------------------------------------------------------------------------
// Pairing QR (locked until user taps New Code)
// ---------------------------------------------------------------------------

async function resolveMobilePairUrl(info) {
  const code = (info?.code || getPersistentPairingCode() || '').toUpperCase();
  const rt = relayRuntime || refreshRelayRuntime();
  const cloudRelay = (info?.relay || rt.cloudUrl || '').trim();
  const cloudPublic = rt.cloudPublic || '';

  // Cloud HTTPS page loads on Wi‑Fi and cellular; LAN-only URLs fail off-network.
  if (rt.useCloud && cloudPublic && cloudRelay && code) {
    const u = new URL(`${cloudPublic.replace(/\/$/, '')}/mobile/`);
    u.searchParams.set('code', code);
    u.searchParams.set('relay', cloudRelay);
    return u.toString();
  }

  return (
    info?.mobileUrl ||
    (info?.host && info?.port
      ? `http://${info.host}:${info.port}/mobile/?host=${info.host}&port=${info.port}&code=${code}`
      : '')
  );
}

async function refreshPairingFromHttp() {
  const rt = relayRuntime || refreshRelayRuntime();
  if (!relayOnline && !isRelayOpen()) return;
  try {
    const res = await fetch(`http://127.0.0.1:${getRelayPort()}/api/pairing`);
    if (!res.ok) return;
    const info = await res.json();
    await updatePairingQr({
      ...info,
      code: info.code || getPersistentPairingCode()
    });
  } catch (err) {
    supportDiag(`Pairing fetch failed: ${err?.message || err}`, 'warn');
  }
}

async function updatePairingQr(info, options = {}) {
  const force = options.force === true;
  const code = getPersistentPairingCode();
  if (!code) return;
  pairingCodeEl.textContent = code;
  refreshSetupChecklist();

  if (!force) {
    const locked = getLockedPairingQr();
    if (locked && locked.code === code && locked.mobileUrl) {
      pairingUrlEl.textContent = locked.mobileUrl;
      if (locked.qrDataUrl) {
        pairingQrEl.src = locked.qrDataUrl;
        pairingQrEl.classList.add('visible');
        return;
      }
      if (QRCode) {
        try {
          const qrDataUrl = await QRCode.toDataURL(locked.mobileUrl, { margin: 1, width: 184 });
          pairingQrEl.src = qrDataUrl;
          pairingQrEl.classList.add('visible');
          setLockedPairingQr({ code, mobileUrl: locked.mobileUrl, qrDataUrl });
        } catch (e) {
          console.error('QR error', e);
        }
      }
      return;
    }
  }

  const mobileUrl = await resolveMobilePairUrl({ ...info, code });
  if (!mobileUrl) return;
  pairingUrlEl.textContent = mobileUrl;

  if (!QRCode) {
    pairingUrlEl.textContent += ' (QR unavailable)';
    return;
  }

  try {
    const qrDataUrl = await QRCode.toDataURL(mobileUrl, { margin: 1, width: 184 });
    pairingQrEl.src = qrDataUrl;
    pairingQrEl.classList.add('visible');
    setLockedPairingQr({ code, mobileUrl, qrDataUrl });
  } catch (e) {
    console.error('QR error', e);
  }
}

function onRelaySocketMessage(raw) {
  let data;
  try {
    data = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
  } catch {
    return;
  }

  if (data.type === 'pairingInfo') {
    updatePairingQr(data);
    return;
  }

  if (data.type === 'mobileConnected') {
    setPill(mobilePill, 'Mobile: connected', true);
    startMobileObsSync();
    return;
  }

  if (data.type === 'mobileDisconnected') {
    setPill(mobilePill, 'Mobile: offline', false);
    return;
  }

  handleRelayMessage(raw);
}

// ---------------------------------------------------------------------------
// Relay (mobile ↔ PC)
// ---------------------------------------------------------------------------

function scheduleRelayReconnect() {
  if (relayReconnectTimer) return;
  relayReconnectTimer = setTimeout(() => {
    relayReconnectTimer = null;
    connectRelay();
  }, RELAY_RECONNECT_MS);
}

function isRelayOpen() {
  if (relayCloudIpcReady || localRelayIpcReady) return true;
  return relaySocket?.readyState === WebSocket.OPEN;
}

function sendRelayJson(payload) {
  const text = JSON.stringify(payload);
  if (relayCloudIpcReady) {
    ipcRenderer.send('swiftsync:cloud-relay-send', text);
    return;
  }
  if (localRelayIpcReady) {
    ipcRenderer.send('swiftsync:local-relay-send', text);
    return;
  }
  if (relaySocket?.readyState === WebSocket.OPEN) relaySocket.send(text);
}

function disconnectRendererRelaySocket() {
  if (relaySocket) {
    try {
      relaySocket.onclose = null;
      relaySocket.onerror = null;
      relaySocket.close();
    } catch (_) {}
    relaySocket = null;
  }
  relayConnectUrl = '';
}

function handleLocalRelayEvent(ev) {
  if (ev.state === 'open') {
    clearRelayConnectTimeout();
    localRelayIpcReady = true;
    relayOnline = true;
    relayTransport = 'ipc-local';
    supportDiag('Local relay connected (main process)');
    updateRelayHealth('Local relay connected.', { ok: true, show: false });
    setPill(pillRelay, 'Relay: online', true);
    refreshSetupChecklist();
    refreshPairingFromHttp().catch(() => {});
    scheduleAutoChatConnect('relay');
    return;
  }

  if (ev.state === 'message' && ev.data) {
    onRelaySocketMessage(ev.data);
    return;
  }

  if (ev.state === 'close' || ev.state === 'error' || ev.state === 'timeout') {
    localRelayIpcReady = false;
    if (!relayCloudIpcReady) {
      relayOnline = false;
      const rt = refreshRelayRuntime();
      setPill(pillRelay, 'Relay: offline', false);
      updateRelayHealth(describeRelayFailure(rt), { show: true });
      refreshSetupChecklist();
      scheduleRelayReconnect();
    }
  }
}

function handleCloudRelayEvent(ev) {
  const rt = relayRuntime || refreshRelayRuntime();
  if (!rt.useCloud) return;

  if (ev.state === 'open') {
    clearRelayConnectTimeout();
    relayCloudIpcReady = true;
    relayOnline = true;
    supportDiag('Cloud relay connected (main process)');
    const localUp = localRelayIpcReady;
    updateRelayHealth(
      localUp ? 'Relay online (local + cloud for cellular).' : 'Cloud relay connected.',
      { ok: true, show: false }
    );
    setPill(pillRelay, localUp ? 'Relay: online' : 'Cloud relay: online', true);
    refreshSetupChecklist();
    scheduleAutoChatConnect('relay');
    return;
  }

  if (ev.state === 'message' && ev.data) {
    onRelaySocketMessage(ev.data);
    return;
  }

  if (ev.state === 'close' || ev.state === 'error' || ev.state === 'timeout') {
    relayCloudIpcReady = false;
    relayOnline = localRelayIpcReady;
    refreshSetupChecklist();
    if (localRelayIpcReady) {
      setPill(pillRelay, 'Cloud offline · local OK', false);
      updateRelayHealth(
        'Cloud relay unreachable — use the LAN QR below if your phone is on the same Wi‑Fi.',
        { show: true }
      );
    } else {
      setPill(pillRelay, 'Cloud relay: offline', false);
      updateRelayHealth(describeRelayFailure(rt), { show: true });
    }
  }
}

function fallbackToLocalRelay(rt) {
  clearRelayConnectTimeout();
  ipcRenderer.invoke('swiftsync:cloud-relay-disconnect').catch(() => {});
  relayCloudIpcReady = false;
  if (!rt.external || rt.attached) {
    connectLocalRelayViaIpc(rt);
  } else {
    relayOnline = false;
    setPill(pillRelay, 'Relay: offline', false);
    updateRelayHealth(describeRelayFailure(rt), { show: true });
    refreshSetupChecklist();
  }
}

function connectLocalRelayViaIpc(rt) {
  if (localRelayIpcReady) return;

  clearRelayConnectTimeout();
  setPill(pillRelay, 'Relay: connecting…', false);
  updateRelayHealth('Connecting to local relay…', { show: false });

  relayConnectTimeout = setTimeout(() => {
    if (localRelayIpcReady) return;
    supportDiag('Local relay connect timeout', 'warn');
    const cur = refreshRelayRuntime();
    relayOnline = false;
    updateRelayHealth(describeRelayFailure(cur), { show: true });
    setPill(pillRelay, 'Relay: timeout', false);
    scheduleRelayReconnect();
  }, RELAY_CONNECT_TIMEOUT_MS);

  ipcRenderer
    .invoke('swiftsync:local-relay-connect', {
      port: rt.port,
      pairingCode: getPersistentPairingCode()
    })
    .catch((err) => {
      supportDiag(`Local relay IPC failed: ${err?.message || err}`, 'warn');
      scheduleRelayReconnect();
    });
}

function connectCloudRelayViaIpc(rt) {
  if (relayCloudIpcReady) return;

  relayCloudIpcReady = false;
  const localUp = localRelayIpcReady;

  clearRelayConnectTimeout();
  relayConnectTimeout = setTimeout(() => {
    if (relayCloudIpcReady) return;
    supportDiag('Cloud relay connect timeout', 'warn');
    if (!isRelayOpen()) fallbackToLocalRelay(rt);
    else {
      updateRelayHealth(
        'Local relay is online. Cloud is optional (for phone on cellular) — Wi‑Fi pairing works now.',
        { ok: true, show: true }
      );
      setPill(pillRelay, 'Relay: online', true);
      refreshSetupChecklist();
    }
  }, 8000);

  if (!localUp && !relayOnline) {
    setPill(pillRelay, 'Relay: connecting…', false);
    updateRelayHealth('Starting local relay, then cloud…', { show: false });
  } else {
    updateRelayHealth('Local relay online — connecting cloud (optional)…', { show: false });
  }

  ipcRenderer
    .invoke('swiftsync:cloud-relay-connect', {
      url: rt.cloudUrl,
      pairingCode: getPersistentPairingCode()
    })
    .then((res) => {
      if (res?.connected) {
        relayCloudIpcReady = true;
        relayOnline = true;
        handleCloudRelayEvent({ state: 'open' });
      }
      if (res?.external) {
        updateRelayHealth(
          'Port 4000 is in use — local relay could not start. Close other SwiftSync windows and Retry.',
          { show: true }
        );
      }
    })
    .catch((err) => {
      supportDiag(`Cloud relay IPC failed: ${err?.message || err}`, 'warn');
      fallbackToLocalRelay(rt);
    });
}

function connectLocalRelayBridge() {
  const rt = relayRuntime || refreshRelayRuntime();
  if (!rt.useCloud || rt.external) return;
  if (
    localRelayBridgeSocket?.readyState === WebSocket.OPEN ||
    localRelayBridgeSocket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  localRelayBridgeSocket = new WebSocket(`ws://127.0.0.1:${getRelayPort()}`);
  localRelayBridgeSocket.onopen = () => {
    localRelayBridgeOnline = true;
    localRelayBridgeSocket.send(
      JSON.stringify({
        type: 'role',
        role: 'pc',
        pairingCode: getPersistentPairingCode()
      })
    );
    if (!relayCloudIpcReady) {
      relayOnline = true;
      setPill(pillRelay, 'Local OK · cloud connecting…', false);
      updateRelayHealth('Local relay ready — finishing cloud connection…', { show: false });
      refreshSetupChecklist();
    }
  };
  localRelayBridgeSocket.onmessage = (e) => {
    if (!relayCloudIpcReady) onRelaySocketMessage(e.data);
  };
  localRelayBridgeSocket.onclose = () => {
    localRelayBridgeSocket = null;
    localRelayBridgeOnline = false;
    if (!relayCloudIpcReady) relayOnline = false;
    setTimeout(connectLocalRelayBridge, RELAY_RECONNECT_MS);
  };
  localRelayBridgeSocket.onerror = () => {};
}

function describeRelayFailure(rt) {
  if (rt.external && !rt.attached) {
    return 'Built-in relay could not start (ports 4000–4003 busy). Close other SwiftSync windows, then tap Retry relay.';
  }
  if (rt.useCloud && !rt.cloudUrl) {
    return 'Cloud relay not configured — add relay-config.json (see README) or reinstall.';
  }
  if (rt.useCloud) {
    return 'Cannot reach cloud relay — check internet or firewall, then Retry.';
  }
  return 'Local relay offline — close apps on port 4000 and Retry, or restart SwiftSync.';
}

function clearRelayConnectTimeout() {
  if (relayConnectTimeout) {
    clearTimeout(relayConnectTimeout);
    relayConnectTimeout = null;
  }
}

function connectRendererRelayWs(url, rt) {
  if (relaySocket && relayConnectUrl === url) {
    if (relaySocket.readyState === WebSocket.OPEN) return;
    if (relaySocket.readyState === WebSocket.CONNECTING) return;
  }

  disconnectRendererRelaySocket();
  relayTransport = 'ws';
  relayCloudIpcReady = false;
  relayConnectUrl = url;
  relayOnline = false;
  setPill(pillRelay, rt.useCloud ? 'Cloud relay: connecting…' : 'Relay: connecting…', false);
  updateRelayHealth(rt.useCloud ? 'Connecting to cloud relay…' : 'Starting local relay…', { show: false });

  relaySocket = new WebSocket(url);
  relayConnectTimeout = setTimeout(() => {
    relayConnectTimeout = null;
    if (!relaySocket || relaySocket.readyState !== WebSocket.CONNECTING) return;
    supportDiag(`Relay connect timeout (${url})`, 'warn');
    try {
      relaySocket.onclose = null;
      relaySocket.onerror = null;
      relaySocket.close();
    } catch (_) {}
    relaySocket = null;
    relayConnectUrl = '';
    relayOnline = false;
    updateRelayHealth(describeRelayFailure(rt), { show: true });
    setPill(pillRelay, rt.useCloud ? 'Cloud relay: timeout' : 'Relay: timeout', false);
    scheduleRelayReconnect();
  }, RELAY_CONNECT_TIMEOUT_MS);

  relaySocket.onopen = () => {
    clearRelayConnectTimeout();
    relayOnline = true;
    supportDiag(`Relay connected: ${url}`);
    updateRelayHealth(rt.useCloud ? 'Cloud relay connected.' : 'Local relay connected.', { ok: true, show: false });
    refreshSetupChecklist();
    const pairingCode = getPersistentPairingCode();
    const sock = relaySocket;
    const sendRole = () => {
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      sock.send(JSON.stringify({ type: 'role', role: 'pc', pairingCode }));
    };
    sendRole();
    if (sock.readyState !== WebSocket.OPEN) setTimeout(sendRole, 50);
    refreshPairingFromHttp().catch(() => {});
    setPill(pillRelay, rt.useCloud ? 'Cloud relay: online' : 'Relay: online', true);
    if (!rt.useCloud && rt.external && pairingUrlEl) {
      pairingUrlEl.textContent =
        `Relay already running on port ${rt.port}. Close other SwiftSync/relay windows and restart if pairing fails.`;
    }
  };
  relaySocket.onmessage = (e) => onRelaySocketMessage(e.data);
  relaySocket.onclose = () => {
    clearRelayConnectTimeout();
    const cur = relayRuntime || refreshRelayRuntime();
    relayOnline = false;
    relayCloudIpcReady = false;
    updateRelayHealth(describeRelayFailure(cur), { show: true });
    refreshSetupChecklist();
    setPill(pillRelay, cur.useCloud ? 'Cloud relay: offline' : 'Relay: offline', false);
    setPill(mobilePill, 'Mobile: none', false);
    stopMobileObsSync();
    if (pairingQrEl) pairingQrEl.classList.remove('visible');
    if (pairingCodeEl) pairingCodeEl.textContent = '------';
    if (pairingUrlEl) pairingUrlEl.textContent = 'Waiting for relay…';
    relaySocket = null;
    relayConnectUrl = '';
    scheduleRelayReconnect();
  };
  relaySocket.onerror = () => {
    clearRelayConnectTimeout();
    const cur = relayRuntime || refreshRelayRuntime();
    relayOnline = false;
    updateRelayHealth(describeRelayFailure(cur), { show: true });
    refreshSetupChecklist();
    setPill(pillRelay, cur.useCloud ? 'Cloud relay: error' : 'Relay: error', false);
  };
}

function connectRelay() {
  const rt = refreshRelayRuntime();
  logRelayMode();
  refreshSetupChecklist();

  const canUseLocalWs = !rt.external || rt.attached;

  if (canUseLocalWs) {
    connectLocalRelayViaIpc(rt);
  } else if (!rt.useCloud || !rt.cloudUrl) {
    relayOnline = false;
    setPill(pillRelay, 'Relay: offline', false);
    updateRelayHealth(describeRelayFailure(rt), { show: true });
    refreshSetupChecklist();
    return;
  }

  if (rt.useCloud && rt.cloudUrl) {
    connectCloudRelayViaIpc(rt);
  } else {
    ipcRenderer.invoke('swiftsync:cloud-relay-disconnect').catch(() => {});
  }
}

let startupHooksDone = false;
let startupConfigHandled = false;

function updatePcMobilePromoLinks() {
  const rt = relayRuntime || refreshRelayRuntime();
  const direct = document.getElementById('pc-chat-only-direct');
  if (direct && rt.cloudPublic) {
    direct.href = `${rt.cloudPublic}/mobile/?mode=chat`;
  }
}

async function onStartupConfigReady() {
  if (startupConfigHandled) return;
  startupConfigHandled = true;
  await syncRelayConfigFromMain();
  refreshRelayRuntime();
  updatePcMobilePromoLinks();
  connectRelay();
  setTimeout(() => refreshPairingFromHttp().catch(() => {}), 400);
  if (startupHooksDone) return;
  startupHooksDone = true;
  autoConnectObs('startup').catch(() => {});
  initChatHub();
  scheduleAutoChatConnect('startup');
}

function isObsConnectedOnPc() {
  return obsController.isOnline;
}

function startMobileObsSync() {
  mobileLinked = true;
  stopMobileObsSync();
  pushObsStateToMobile().catch(console.error);
  refreshSceneSources().catch(console.error);
  let ticks = 0;
  mobileSyncTimer = setInterval(() => {
    if (!mobileLinked || ++ticks > 15) {
      stopMobileObsSync();
      return;
    }
    pushObsStateToMobile().catch(console.error);
    if (activeSceneName) refreshSceneSources(activeSceneName).catch(console.error);
  }, 2000);
}

function stopMobileObsSync() {
  mobileLinked = false;
  if (mobileSyncTimer) {
    clearInterval(mobileSyncTimer);
    mobileSyncTimer = null;
  }
}

function postObsStateViaHttp(payload) {
  try {
    const http = require('http');
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: getRelayPort(),
        path: '/api/pc-state',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        res.resume();
      }
    );
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (_) {}
}

function sendToMobile(payload) {
  const msg = { from: 'pc', ...payload };
  if (isRelayOpen()) sendRelayJson(msg);
  const rt = relayRuntime || refreshRelayRuntime();
  if (!rt.useCloud) {
    if (
      payload.type === 'pong' ||
      payload.type === 'obsConnected' ||
      payload.type === 'obsState' ||
      payload.type === 'scenes' ||
      payload.type === 'sceneSources'
    ) {
      postObsStateViaHttp(msg);
    }
    if (payload.type === 'sceneSources') {
      postSceneSourcesViaHttp(msg);
    }
    if (payload.type === 'audio' && Array.isArray(payload.inputs)) {
      postAudioViaHttp({ inputs: payload.inputs });
    }
    if (payload.type === 'obsState' && Array.isArray(payload.audio)) {
      postAudioViaHttp({ inputs: payload.audio });
    }
  }
}

async function getAudioStateForMobile() {
  const inputs = await obsController.getAudioInputs();
  const list = [];
  const seen = new Set();

  for (const input of inputs) {
    if (ObsController.isSeliveInternalAudioInput(input)) continue;

    const inputName = input.inputName;
    const key = inputName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let volumeDb = 0;
    let volumeMul = 1;
    let muted = false;
    try {
      const vol = await obsController.getInputVolume(inputName);
      volumeDb = vol.inputVolumeDb ?? 0;
      volumeMul = vol.inputVolumeMul ?? 1;
      muted = (await obsController.getInputMute(inputName)).inputMuted;
    } catch {
      continue;
    }

    list.push({
      inputName,
      displayName: inputName,
      volumeDb,
      volumeMul,
      muted
    });
  }

  list.sort((a, b) => audioInputSortKey(a.inputName).localeCompare(audioInputSortKey(b.inputName)));
  return list;
}

function audioInputSortKey(name) {
  const lower = String(name || '').toLowerCase();
  if (/desktop|system|output/.test(lower)) return `0-${lower}`;
  if (/mic|aux|microphone|input/.test(lower)) return `1-${lower}`;
  return `2-${lower}`;
}

async function pushObsStateToMobile() {
  if (!isObsConnectedOnPc()) {
    sendToMobile({
      type: 'obsState',
      obsConnected: false,
      obsOnline: false,
      message: 'OBS not connected on PC — connect on the Home tab first.'
    });
    return;
  }

  sendToMobile({
    type: 'obsConnected',
    obsConnected: true,
    obsOnline: true,
    currentScene: activeSceneName
  });

  try {
    const { scenes, currentProgramSceneName } = await obsController.getSceneList(mainCanvasUuid || undefined);
    const audio = await getAudioStateForMobile();

    let streamActive = false;
    let recordActive = false;
    let replayActive = false;
    let vcamActive = false;
    let studioActive = false;

    try { streamActive = (await obsController.getStreamStatus()).outputActive; } catch { /* ignore */ }
    try { recordActive = (await obsController.getRecordStatus()).outputActive; } catch { /* ignore */ }
    try { replayActive = (await obsController.getReplayBufferStatus()).outputActive; } catch { /* ignore */ }
    try { vcamActive = (await obsController.getVirtualCamStatus()).outputActive; } catch { /* ignore */ }
    try { studioActive = (await obsController.getStudioModeEnabled()).studioModeEnabled; } catch { /* ignore */ }

    const payload = {
      type: 'obsState',
      obsConnected: true,
      obsOnline: true,
      version: obsController.versionInfo,
      scenes: scenes.map((s) => s.sceneName),
      sceneLinks: sceneLinks.map((link) => ({
        main: link.main?.sceneName || link.main,
        vertical: link.vertical?.sceneName || link.vertical || null
      })),
      dualCanvasMode,
      currentScene: currentProgramSceneName || activeSceneName,
      canvasHint: canvasHintEl?.textContent || '',
      audio: audio.map((a) => ({
        inputName: a.inputName,
        name: a.inputName,
        displayName: a.displayName || a.inputName,
        volumeDb: a.volumeDb,
        volumeMul: a.volumeMul,
        muted: a.muted
      })),
      tools: {
        stream: streamActive,
        record: recordActive,
        replay: replayActive,
        vcam: vcamActive,
        studio: studioActive
      },
      streamActive,
      recordActive
    };

    sendToMobile(payload);
    sendToMobile({ ...payload, type: 'obsConnected' });
  } catch (e) {
    console.error('pushObsStateToMobile', e);
    sendToMobile({
      type: 'obsConnected',
      obsConnected: true,
      obsOnline: true,
      currentScene: activeSceneName,
      scenes: sceneLinks.map((l) => l.main.sceneName),
      sceneLinks: sceneLinks.map((link) => ({
        main: link.main?.sceneName || link.main,
        vertical: link.vertical?.sceneName || link.vertical || null
      })),
      dualCanvasMode
    });
  }
}

async function handleRelayMessage(raw) {
  let data;
  try { data = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); }
  catch { return; }

  if (data.type === 'role') return;
  if (data.from && data.from !== 'mobile') return;
  if (!data.command) return;

  if (data.command === 'ping') {
    const online = isObsConnectedOnPc();
    sendToMobile({
      type: 'pong',
      obsConnected: online,
      obsOnline: online
    });
    return;
  }

  const readOnlyCommands = new Set(['getState', 'getScenes', 'getAudio', 'getSceneSources', 'getChat']);
  const chatCommands = new Set(['getChat', 'sendChat', 'setChatConfig', 'connectChat']);

  if (!chatCommands.has(data.command) && !readOnlyCommands.has(data.command) && !isObsConnectedOnPc()) {
    sendToMobile({
      type: 'error',
      message: 'OBS not connected on PC — open SwiftSync Home tab and connect to OBS first.'
    });
    return;
  }

  const inputName = data.inputName || data.name;

  try {
    switch (data.command) {
      case 'setScene':
        if (!data.sceneName) {
          sendToMobile({ type: 'error', message: 'sceneName required' });
          return;
        }
        if (!sceneLinks.some((l) => l.main.sceneName === data.sceneName)) {
          sendToMobile({ type: 'error', message: `Scene not found: ${data.sceneName}` });
          return;
        }
        await switchScene(data.sceneName);
        break;
      case 'getScenes': {
        if (!isObsConnectedOnPc()) {
          sendToMobile({
            type: 'scenes',
            obsConnected: false,
            obsOnline: false,
            scenes: [],
            sceneLinks: [],
            dualCanvasMode: false,
            current: null
          });
          break;
        }
        await refreshScenes();
        sendToMobile({
          type: 'scenes',
          obsConnected: true,
          obsOnline: true,
          scenes: sceneLinks.map((l) => l.main.sceneName),
          sceneLinks: sceneLinks.map((link) => ({
            main: link.main.sceneName,
            vertical: link.vertical?.sceneName || null
          })),
          dualCanvasMode,
          current: activeSceneName
        });
        break;
      }
      case 'getAudio':
        if (!isObsConnectedOnPc()) {
          sendAudioToMobile([]);
          break;
        }
        await refreshGlobalAudio();
        break;
      case 'getState':
        if (!isObsConnectedOnPc()) {
          sendToMobile({
            type: 'obsState',
            obsConnected: false,
            obsOnline: false,
            message: 'OBS not connected on PC — connect on the Home tab first.'
          });
          break;
        }
        await refreshSceneSources();
        await refreshGlobalAudio();
        await pushObsStateToMobile();
        break;
      case 'getSceneSources':
        if (!isObsConnectedOnPc()) {
          sendSceneSourcesToMobile([]);
          break;
        }
        await refreshSceneSources(data.sceneName || activeSceneName);
        break;
      case 'setSourceEnabled': {
        if (data.sceneItemId == null) {
          sendToMobile({ type: 'error', message: 'sceneItemId required' });
          return;
        }
        if (!data.sceneName && !data.sceneUuid) {
          sendToMobile({ type: 'error', message: 'sceneName or sceneUuid required' });
          return;
        }
        await obsController.setSceneItemEnabledForSource(
          {
            sceneName: data.sceneName,
            sceneUuid: data.sceneUuid || null,
            sceneItemId: data.sceneItemId,
            canvasUuid: data.canvasUuid || null
          },
          !!data.enabled
        );
        await refreshSceneSources();
        break;
      }
      case 'setVolume': {
        if (!inputName) {
          sendToMobile({ type: 'error', message: 'inputName required' });
          return;
        }
        let db;
        if (data.volumeDb != null) {
          db = clampVolumeDb(data.volumeDb);
        } else {
          const mul = clampVolume(data.volumeMul);
          db = mul <= 0 ? VOLUME_DB_MIN : clampVolumeDb(20 * Math.log10(mul));
        }
        await obsController.setInputVolumeDb(inputName, db);
        updateSourceVolumeUi(inputName, db);
        sendToMobile({ type: 'volumeChanged', inputName, volumeDb: db });
        await refreshGlobalAudio();
        break;
      }
      case 'setMute':
        if (!inputName) {
          sendToMobile({ type: 'error', message: 'inputName required' });
          return;
        }
        await obsController.setInputMute(inputName, !!data.muted);
        updateSourceMuteUi(inputName, !!data.muted);
        sendToMobile({ type: 'muteChanged', inputName, muted: !!data.muted });
        await refreshGlobalAudio();
        break;
      case 'toggleMute': {
        if (!inputName) {
          sendToMobile({ type: 'error', message: 'inputName required' });
          return;
        }
        await obsController.toggleInputMute(inputName);
        const m = await obsController.getInputMute(inputName);
        updateSourceMuteUi(inputName, m.inputMuted);
        sendToMobile({ type: 'muteChanged', inputName, muted: m.inputMuted });
        await refreshGlobalAudio();
        break;
      }
      case 'toggleStream':
        await obsController.toggleStream();
        await refreshToolsUi();
        await pushObsStateToMobile();
        break;
      case 'toggleRecord':
        await obsController.toggleRecord();
        await refreshToolsUi();
        await pushObsStateToMobile();
        break;
      case 'pauseRecord':
        await obsController.pauseRecord();
        await refreshToolsUi();
        await pushObsStateToMobile();
        break;
      case 'toggleReplay':
        await obsController.toggleReplayBuffer();
        await refreshToolsUi();
        await pushObsStateToMobile();
        break;
      case 'saveReplay':
        await obsController.saveReplayBuffer();
        await pushObsStateToMobile();
        break;
      case 'toggleVirtualCam':
        await obsController.toggleVirtualCam();
        await refreshToolsUi();
        await pushObsStateToMobile();
        break;
      case 'toggleStudioMode': {
        const { studioModeEnabled } = await obsController.getStudioModeEnabled();
        await obsController.setStudioModeEnabled(!studioModeEnabled);
        await refreshToolsUi();
        await pushObsStateToMobile();
        break;
      }
      case 'connectChat':
        startChatKeepAlive();
        await maintainChatConnections('mobile');
        pushChatToMobile(true);
        sendChatStatusToMobile();
        break;
      case 'getChat':
        pushChatToMobile(true);
        sendChatStatusToMobile();
        break;
      case 'sendChat': {
        const text = String(data.text || data.message || '').trim();
        const platform = data.platform || chatHub.getDefaultSendPlatform() || 'twitch';
        if (!text) {
          sendToMobile({ type: 'error', message: 'text required' });
          return;
        }
        try {
          const result = await chatHub.send(platform, text);
          if (platform === 'all' && Array.isArray(result) && result.length) {
            sendToMobile({
              type: 'error',
              message: `Partial send failure: ${formatChatSendErrors(result)}`
            });
          }
        } catch (err) {
          sendToMobile({ type: 'error', message: err.message || String(err) });
        }
        break;
      }
      case 'setChatConfig': {
        const partial = { platforms: { ...(chatConfig.platforms || {}) } };
        if (data.platforms && typeof data.platforms === 'object') {
          for (const [platform, cfg] of Object.entries(data.platforms)) {
            partial.platforms[platform] = { ...(partial.platforms[platform] || {}), ...cfg };
          }
        }
        if (data.channel != null) {
          partial.platforms.twitch = {
            ...(partial.platforms.twitch || {}),
            channel: normalizeChannel(data.channel),
            enabled: true
          };
        }
        if (data.oauthToken != null || data.username != null) {
          partial.platforms.twitch = {
            ...(partial.platforms.twitch || {}),
            oauthToken: data.oauthToken != null ? data.oauthToken : partial.platforms.twitch?.oauthToken,
            username: data.username != null ? data.username : partial.platforms.twitch?.username
          };
        }
        chatConfig = saveChatConfig(partial);
        applyChatConfigToUi();
        handleChatConnect().catch(console.error);
        break;
      }
      default:
        sendToMobile({ type: 'error', message: `Unknown command: ${data.command}` });
    }
  } catch (err) {
    sendToMobile({ type: 'error', message: err.message || String(err) });
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

document.querySelectorAll('.grab-obs-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const field = btn.dataset.obsField;
    if (field) grabObsField(field);
  });
});

if (connectBtn) {
  connectBtn.addEventListener('click', () => {
    obsController.manualDisconnect = false;
    connectRelay();
    connectOBS();
  });
} else {
  console.error('Connect button not found');
}

if (reconnectBtn) {
  reconnectBtn.addEventListener('click', async () => {
    obsController.manualDisconnect = false;
    obsController.reconnectAttempt = 0;
    clearObsAutoConnectTimer();
    await obsController.disconnect();
    connectRelay();
    connectOBS(true);
  });
}

showTab('connect');
ipcRenderer.on('swiftsync:cloud-relay', (_evt, ev) => handleCloudRelayEvent(ev));
window.addEventListener('swiftsync-config-ready', () => onStartupConfigReady());
setTimeout(() => onStartupConfigReady(), 800);
ipcRenderer.on('swiftsync:local-relay', (_evt, ev) => handleLocalRelayEvent(ev));
refreshSetupChecklist();
checkAppVersion().catch(() => {});

chatConnectBtn?.addEventListener('click', () => {
  handleChatConnect().catch(console.error);
});
chatLoginBtns.forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleChatOAuthLogin(btn.dataset.oauth).catch((err) => {
      setChatFeedback(err?.message || String(err), '#ff4444');
      console.error('[SwiftSync] OAuth button:', err);
    });
  });
});

document.getElementById('chat-panel')?.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.chat-login-btn[data-oauth]');
  if (!btn || e.defaultPrevented) return;
  e.preventDefault();
  e.stopPropagation();
  handleChatOAuthLogin(btn.dataset.oauth).catch((err) => {
    setChatFeedback(err?.message || String(err), '#ff4444');
    console.error('[SwiftSync] OAuth delegated click:', err);
  });
});
chatLogoutBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    handleChatOAuthLogout(btn.dataset.oauth);
  });
});
oauthSaveBtn?.addEventListener('click', handleSaveOAuthApps);
oauthOpenFolderBtn?.addEventListener('click', handleOpenOAuthConfigFolder);
oauthPortalLinks.forEach((link) => {
  link.addEventListener('click', () => {
    const url = link.dataset.url;
    if (url) shell.openExternal(url).catch(console.error);
  });
});
chatSaveConfigBtn?.addEventListener('click', () => {
  chatConfig = saveChatConfig(readChatConfigFromUi());
  applyChatConfigToUi();
  updateChatUi();
  setStatus('Chat config saved', '#00ff85');
});

async function submitChatFromPc() {
  const text = String(chatSendInput?.value || '').trim();
  if (!text) return;
  const platform = chatSendPlatform?.value || chatHub.getDefaultSendPlatform();
  try {
    const result = await chatHub.send(platform, text);
    if (chatSendInput) chatSendInput.value = '';
    if (platform === 'all' && Array.isArray(result) && result.length) {
      const summary = formatChatSendErrors(result);
      if (chatStatusLine) chatStatusLine.textContent = `Partial send failure: ${summary}`;
      setStatus(`Partial send failure: ${summary}`, '#f0c14b');
    }
  } catch (err) {
    setStatus(err.message || String(err), '#ff4444');
  }
}

const chatDockUrlEl = document.getElementById('chat-dock-url');
const chatDockCopyBtn = document.getElementById('chat-dock-copy-btn');
const chatDockTestBtn = document.getElementById('chat-dock-test-btn');
const chatPopoutBtn = document.getElementById('chat-popout-btn');
const chatDockPrereqChat = document.getElementById('chat-dock-prereq-chat');

function getChatDockUrl() {
  return `http://127.0.0.1:${getRelayPort()}/dock/chat.html`;
}

function getChatDockSetupText() {
  const url = getChatDockUrl();
  return [
    'SwiftSync — OBS multichat dock',
    '',
    '1. SwiftSync PC app must be running on this computer.',
    '2. Connect chat on the Chat tab in SwiftSync.',
    '3. In OBS: View → Docks → Custom Browser Docks…',
    '4. Name: SwiftSync Chat',
    `5. URL: ${url}`,
    '6. Click Apply. Resize the dock panel as needed.',
    '',
    'Note: 127.0.0.1 is the same for everyone — it always means THIS PC, not the internet.'
  ].join('\n');
}

function updateChatDockUrlDisplay() {
  if (chatDockUrlEl) chatDockUrlEl.textContent = getChatDockUrl();
}

function updateChatDockPrereqs() {
  if (chatDockPrereqChat) {
    chatDockPrereqChat.textContent = chatConnected
      ? '② Chat connected ✓'
      : '② Chat connected — click Connect above first';
    chatDockPrereqChat.classList.toggle('ok', chatConnected);
  }
}

chatDockCopyBtn?.addEventListener('click', () => {
  const url = getChatDockUrl();
  require('electron').clipboard.writeText(url);
  setStatus('OBS dock URL copied — paste in OBS → View → Docks → Custom Browser Docks', '#00ff85');
});

chatDockCopyBtn?.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  require('electron').clipboard.writeText(getChatDockSetupText());
  setStatus('Full OBS setup steps copied to clipboard', '#00ff85');
});

chatDockTestBtn?.addEventListener('click', () => {
  const url = getChatDockUrl();
  require('electron')
    .shell.openExternal(url)
    .catch((err) => setStatus(err.message || 'Could not open browser', '#ff4444'));
});

chatPopoutBtn?.addEventListener('click', () => {
  try {
    require('electron').ipcRenderer.send('swiftsync:open-chat-popout');
  } catch (e) {
    setStatus(e.message || 'Pop-out unavailable', '#ff4444');
  }
});

updateChatDockUrlDisplay();
updateChatDockPrereqs();

chatSendBtn?.addEventListener('click', submitChatFromPc);
chatSendInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitChatFromPc();
  }
});

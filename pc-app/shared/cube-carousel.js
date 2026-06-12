/**
 * 3D prism/cube tab carousel — shared by mobile web + PC Electron UI.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SwiftSyncCube = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function prefersReducedMotion() {
    return (
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.sceneEl - perspective container
   * @param {HTMLElement} opts.trackEl - rotating element
   * @param {string[]} opts.tabOrder
   * @param {Record<string, string>} opts.tabToPageId - tab key -> element id
   * @param {() => number} opts.getWidth
   * @param {number} [opts.depthFactor=0.78] - larger = more visible cube depth
   */
  function create(opts) {
    const {
      sceneEl,
      trackEl,
      tabOrder,
      tabToPageId,
      getWidth,
      depthFactor = 0.78
    } = opts;
    const faceCount = tabOrder.length;
    const faceAngle = 360 / faceCount;
    let activeTab = tabOrder[0];
    let scrollTiltX = 0;
    let reduced = prefersReducedMotion(); // shorter transitions only — keep 3D layout

    function tabIndex(tab) {
      const idx = tabOrder.indexOf(tab);
      return idx >= 0 ? idx : 0;
    }

    function depthPx(width) {
      return Math.round(width * depthFactor);
    }

    function rotationDeg(idx, dragPx = 0) {
      const w = getWidth();
      const base = -idx * faceAngle;
      const dragDeg = w ? (dragPx / w) * faceAngle : 0;
      return base + dragDeg;
    }

    function getPage(tab) {
      const id = tabToPageId[tab];
      return id ? document.getElementById(id) : null;
    }

    function layoutFaces() {
      if (!trackEl || !sceneEl) return;
      const w = getWidth();
      trackEl.style.width = `${w}px`;
      trackEl.style.height = '100%';
      trackEl.style.display = 'block';
      const depth = depthPx(w);
      tabOrder.forEach((tab, i) => {
        const page = getPage(tab);
        if (!page) return;
        page.classList.add('cube-face');
        page.style.width = `${w}px`;
        page.style.flex = 'none';
        page.style.position = 'absolute';
        page.style.left = '0';
        page.style.top = '0';
        page.style.transform = `rotateY(${faceAngle * i}deg) translateZ(${depth}px)`;
        page.dataset.cubeFace = String(i);
      });
    }

    function buildTransform(idx, dragPx = 0) {
      const y = rotationDeg(idx, dragPx);
      const x = scrollTiltX ? ` rotateX(${scrollTiltX}deg)` : '';
      const scale = dragPx !== 0 ? ' scale(0.96)' : '';
      return `rotateY(${y}deg)${x}${scale}`;
    }

    function applyTransform(tab, { animate = true, dragPx = 0 } = {}) {
      if (!trackEl) return;
      const idx = tabIndex(tab);
      if (!animate) trackEl.classList.add('dragging');
      trackEl.style.transform = buildTransform(idx, dragPx);
      trackEl.style.transitionDuration = reduced ? '0.22s' : '';
      if (!animate) {
        requestAnimationFrame(() => trackEl.classList.remove('dragging'));
      }
    }

    function setScrollTilt(deg) {
      scrollTiltX = deg;
      applyTransform(activeTab, { animate: false });
    }

    function goTo(tab, { animate = true } = {}) {
      activeTab = tab;
      layoutFaces();
      applyTransform(tab, { animate });
    }

    function snapLayout() {
      layoutFaces();
      applyTransform(activeTab, { animate: false });
    }

    function bindScrollTilt(scrollEl, { maxDeg = 6, factor = 0.035 } = {}) {
      if (!scrollEl) return;
      let raf = null;
      scrollEl.addEventListener(
        'scroll',
        () => {
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = null;
            const t = scrollEl.scrollTop;
            const tilt = Math.max(-maxDeg * 0.5, Math.min(maxDeg, t * factor));
            setScrollTilt(tilt);
          });
        },
        { passive: true }
      );
    }

    sceneEl?.classList.add('cube-scene-active');
    trackEl?.classList.add('cube-track-active');

    return {
      tabOrder,
      faceAngle,
      get activeTab() {
        return activeTab;
      },
      set activeTab(tab) {
        activeTab = tab;
      },
      tabIndex,
      layoutFaces,
      applyTransform,
      goTo,
      snapLayout,
      setScrollTilt,
      bindScrollTilt,
      isReducedMotion: () => reduced,
      refreshReducedMotion() {
        reduced = prefersReducedMotion();
      }
    };
  }

  return { create, prefersReducedMotion };
});

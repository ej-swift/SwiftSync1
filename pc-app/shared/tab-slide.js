/**
 * Horizontal slide tab carousel — shared by mobile web + PC Electron UI.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SwiftSyncTabSlide = api;
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
   * @param {HTMLElement} opts.viewportEl
   * @param {HTMLElement} opts.trackEl
   * @param {string[]} opts.tabOrder
   * @param {Record<string, string>} opts.tabToPageId
   * @param {'page'|'viewport'} [opts.scrollParent] — viewport = vertical scroll on viewport (PC)
   */
  function create(opts) {
    const { viewportEl, trackEl, tabOrder, tabToPageId } = opts;
    const scrollParent = opts.scrollParent === 'viewport' ? 'viewport' : 'page';
    let activeTab = tabOrder[0];
    let reduced = prefersReducedMotion();

    function tabIndex(tab) {
      const idx = tabOrder.indexOf(tab);
      return idx >= 0 ? idx : 0;
    }

    function getPage(tab) {
      const id = tabToPageId[tab];
      return id ? document.getElementById(id) : null;
    }

    function slicePercent() {
      return tabOrder.length ? 100 / tabOrder.length : 100;
    }

    function viewportWidthPx() {
      const el = viewportEl || trackEl?.parentElement;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      return rect.width || el.clientWidth || 0;
    }

    function setActivePanel(tab) {
      tabOrder.forEach((t) => {
        const page = getPage(t);
        if (!page) return;
        const on = t === tab;
        page.classList.toggle('panel-active', on);
        page.classList.toggle('tab-slide-active', on);
      });
    }

    function layoutPages() {
      if (!trackEl || !tabOrder.length) return;
      const n = tabOrder.length;
      const slice = slicePercent();
      trackEl.style.width = `${n * 100}%`;
      trackEl.style.display = 'flex';
      trackEl.style.flexWrap = 'nowrap';
      if (scrollParent === 'viewport') {
        trackEl.style.height = 'auto';
        trackEl.style.minHeight = '100%';
        trackEl.style.alignItems = 'stretch';
      } else {
        trackEl.style.height = '100%';
        trackEl.style.minHeight = '';
        trackEl.style.alignItems = '';
      }
      tabOrder.forEach((tab) => {
        const page = getPage(tab);
        if (!page) return;
        page.classList.add('tab-slide-page');
        page.style.flex = `0 0 ${slice}%`;
        page.style.width = `${slice}%`;
        page.style.maxWidth = `${slice}%`;
        page.style.minWidth = `${slice}%`;
        if (scrollParent === 'viewport') {
          page.style.height = 'auto';
          page.style.maxHeight = 'none';
          page.style.minHeight = '100%';
          page.style.overflowY = 'visible';
        } else {
          page.style.height = '100%';
          page.style.maxHeight = '100%';
          page.style.minHeight = '0';
          page.style.overflowY = '';
        }
      });
    }

    function applyTransform(tab, { animate = true, dragPx = 0 } = {}) {
      if (!trackEl || !tabOrder.length) return;
      const idx = tabIndex(tab);
      const slice = slicePercent();
      let xPct = idx * slice;
      const vw = viewportWidthPx();
      if (dragPx && vw > 0) {
        xPct -= (dragPx / vw) * slice;
      }
      trackEl.style.transform = `translate3d(-${xPct}%, 0, 0)`;
      if (!animate) trackEl.classList.add('dragging');
      else trackEl.classList.remove('dragging');
      trackEl.style.transitionDuration = reduced ? '0.2s' : '';
      if (!animate) {
        requestAnimationFrame(() => trackEl.classList.remove('dragging'));
      }
    }

    function goTo(tab, { animate = true } = {}) {
      if (!tabOrder.includes(tab)) return;
      activeTab = tab;
      setActivePanel(tab);
      layoutPages();
      applyTransform(tab, { animate });
    }

    function snapLayout() {
      layoutPages();
      applyTransform(activeTab, { animate: false });
    }

    viewportEl?.classList.add('tab-slide-viewport');
    if (scrollParent === 'viewport') {
      viewportEl?.classList.add('tab-slide-scroll-viewport');
    }
    trackEl?.classList.add('tab-slide-track');

    setActivePanel(activeTab);
    snapLayout();

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => {
        layoutPages();
        applyTransform(activeTab, { animate: false });
      });
    }

    return {
      tabOrder,
      tabIndex,
      scrollParent,
      get activeTab() {
        return activeTab;
      },
      set activeTab(tab) {
        activeTab = tab;
      },
      goTo,
      snapLayout,
      applyTransform,
      getPage,
      isReducedMotion: () => reduced,
      refreshReducedMotion() {
        reduced = prefersReducedMotion();
      }
    };
  }

  return { create, prefersReducedMotion };
});

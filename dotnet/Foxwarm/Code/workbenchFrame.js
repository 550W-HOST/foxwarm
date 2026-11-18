// Adapt the Desktop frame to Code's browser title bar. This script runs before Code loads.
(() => {
  if (window !== window.top) return;

  function start() {
    const state = window.foxwarmFrame;
    if (state?.platform !== 'windows' && state?.platform !== 'macos') return;
    window.removeEventListener('foxwarm-frame', start);

    const root = document.documentElement;
    const overlay = new EventTarget();
    const px = value => Number.isFinite(value) ? Math.max(0, value) : 0;
    let left = 0, right = 0, top = 0, width = 0;
    Object.defineProperty(overlay, 'visible', { get: () => top > 0 });
    overlay.getTitlebarAreaRect = () => new DOMRect(left, 0, width, top);
    Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: overlay });

    // env(titlebar-area-*) comes from the real browser chrome and cannot be set by script.
    root.dataset.foxwarmCodeFrame = state.platform;
    const style = document.createElement('style');
    style.textContent = `
      html[data-foxwarm-code-frame] .monaco-workbench.web .part.titlebar .titlebar-left .window-controls-container {
        order: 0; width: calc(var(--foxwarm-code-left) / var(--zoom-factor, 1)); height: 100%;
      }
      html[data-foxwarm-code-frame] .monaco-workbench.web .part.titlebar .titlebar-right .window-controls-container {
        order: 99; width: calc(var(--foxwarm-code-right) / var(--zoom-factor, 1)); height: 100%;
      }
      html[data-foxwarm-code-frame] .monaco-workbench.web .part.titlebar .counter-zoom .window-controls-container {
        --zoom-factor: 1;
      }
      /* The fixed File menu can otherwise paint behind the editor in WebView2. */
      html[data-foxwarm-code-frame="windows"] .monaco-workbench.web .split-view-view:has(> .part.titlebar .menubar-menu-button.open) {
        z-index: 1000;
      }
      /* Code dims the whole inactive title container; an open menu must stay opaque. */
      html[data-foxwarm-code-frame="windows"] .monaco-workbench .part.titlebar.inactive > .titlebar-container:has(.menubar-menu-button.open) {
        opacity: 1;
      }
      html[data-foxwarm-code-frame="macos"] .monaco-workbench.web.mac .part.titlebar > .titlebar-container > :is(.titlebar-left, .titlebar-center, .titlebar-right) {
        padding-top: 0;
      }
    `;
    document.head.append(style);

    const title = '.monaco-workbench .part.titlebar';
    const interactive = 'button, a, input, select, textarea, summary, label, iframe, [contenteditable], [tabindex], ' +
      '[role="button"], [role^="menuitem"], [role="link"], [role="tab"], [role="checkbox"], [role="listbox"], ' +
      '.command-center, .menubar, .monaco-toolbar, .action-item';
    const floating = '.monaco-menu-container, .context-view, .quick-input-widget, .monaco-hover, .monaco-dialog-modal-block, ' +
      '[role="dialog"], [role="tooltip"]';
    const relevant = '.part.titlebar, ' + floating;
    const channel = window.chrome?.webview ?? window.webkit?.messageHandlers?.foxwarmFrame;
    let scheduled = false, last;

    function geometry() {
      const frame = window.foxwarmFrame;
      const next = [px(frame?.left), px(frame?.right), px(frame?.top)];
      next.push(Math.max(0, window.innerWidth - next[0] - next[1]));
      if (next[0] !== left || next[1] !== right || next[2] !== top || next[3] !== width) {
        [left, right, top, width] = next;
        root.style.setProperty('--foxwarm-code-left', `${left}px`);
        root.style.setProperty('--foxwarm-code-right', `${right}px`);
        overlay.dispatchEvent(Object.assign(new Event('geometrychange'), {
          visible: overlay.visible, titlebarAreaRect: overlay.getTitlebarAreaRect(),
        }));
      }
      schedule();
    }

    // Rectangles use edges, so subtraction and inward rounding cannot expand into a control.
    function subtract([l, t, r, b], hole) {
      const x1 = Math.max(l, hole.left), y1 = Math.max(t, hole.top);
      const x2 = Math.min(r, hole.right), y2 = Math.min(b, hole.bottom);
      if (x1 >= x2 || y1 >= y2) return [[l, t, r, b]];
      return [[l, t, r, y1], [l, y2, r, b], [l, y1, x1, y2], [x2, y1, r, y2]]
        .filter(([x, y, endX, endY]) => endX > x && endY > y);
    }

    function report() {
      scheduled = false;
      const bar = document.querySelector(title);
      const drag = bar?.querySelector('.titlebar-drag-region');
      if (!drag) return;
      // In a WebView2 opener popup the first provider can arrive on DOMContentLoaded.
      // Code only adds this class at creation, so also cover a title bar already built.
      for (const controls of bar.querySelectorAll('.window-controls-container:not(.wco-enabled)'))
        controls.classList.add('wco-enabled');
      const workbench = bar.closest('.monaco-workbench');
      const colorScheme = workbench.matches('.vs, .hc-light') ? 'light' : 'dark';
      const bounds = drag.getBoundingClientRect();
      const main = [Math.max(left, bounds.left), Math.max(0, bounds.top),
        Math.min(window.innerWidth - right, bounds.right), Math.min(window.innerHeight, bounds.bottom)];
      let regions = [];
      if (overlay.visible && main[0] < main[2] && main[1] < main[3]) {
        regions = [main];
        const exclusions = [...bar.querySelectorAll(interactive), ...document.querySelectorAll(floating)];
        for (const element of exclusions) {
          const hole = element.getBoundingClientRect();
          if (!hole.width || !hole.height || getComputedStyle(element).visibility === 'hidden') continue;
          regions = regions.flatMap(part => subtract(part, hole));
        }
        regions = regions.map(([l, t, r, b]) => {
          const x = Math.ceil(l), y = Math.ceil(t);
          return [x, y, Math.floor(r) - x, Math.floor(b) - y];
        }).filter(([, , w, h]) => w >= 2 && h >= 2).slice(0, 128);
      }
      const message = { type: 'frame-regions', regions, colorScheme };
      const json = JSON.stringify(message);
      if (json !== last) {
        last = json;
        channel.postMessage(message);
      }
    }

    function schedule() {
      if (channel && !scheduled) {
        scheduled = true;
        requestAnimationFrame(report);
      }
    }
    const element = node => node.nodeType === Node.ELEMENT_NODE;
    new MutationObserver(changes => {
      // Avoid recomputing on editor content changes. The workbench root carries the theme.
      if (changes.some(({ target, addedNodes, removedNodes }) =>
        (element(target) && (target.matches('.monaco-workbench') || target.closest(relevant))) ||
        [...addedNodes, ...removedNodes].some(node => element(node) && (node.matches(relevant) || node.querySelector(relevant)))
      )) schedule();
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    window.addEventListener('foxwarm-frame', geometry);
    window.addEventListener('resize', geometry);
    geometry();
  }

  window.addEventListener('foxwarm-frame', start);
  start();
})();

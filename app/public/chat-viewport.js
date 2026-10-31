/* iOS can pan the visual viewport as well as resize it when focusing a field.
   Follow both so the app stays inside the space above the keyboard. */
(() => {
  'use strict';
  window.createNemoViewport = ({ onResize = () => {} } = {}) => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame = null;
    let fullHeight = window.innerHeight;
    let width = window.innerWidth;

    function fit() {
      frame = null;
      // Let the browser handle pinch zoom; a zoomed viewport is not a keyboard.
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      const height = viewport?.height || window.innerHeight;
      if (Math.abs(window.innerWidth - width) > 80) {
        fullHeight = window.innerHeight;
        width = window.innerWidth;
      }
      const active = document.activeElement;
      const editing = active && (['INPUT', 'TEXTAREA'].includes(active.tagName) || active.isContentEditable);
      const layoutHeight = Math.max(window.innerHeight, root.clientHeight);
      if (!editing) fullHeight = layoutHeight;
      else fullHeight = Math.max(fullHeight, layoutHeight);
      document.body.dataset.keyboardOpen = String(!!editing && fullHeight - height > 120);
      root.style.setProperty('--viewport-height', `${height}px`);
      root.style.setProperty('--viewport-top', `${Math.max(0, viewport?.offsetTop || 0)}px`);
      onResize();
    }
    function schedule() {
      if (frame === null) frame = window.requestAnimationFrame(fit);
    }
    window.addEventListener('resize', schedule);
    window.addEventListener('pageshow', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    fit();
    return { refresh: schedule };
  };
})();

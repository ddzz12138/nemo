/* Native pages/disclosures and the complete example work without JavaScript. */
(() => {
  'use strict';
  // The header keeps its space in the page; only the glass capsule moves.
  const nav = document.querySelector('.site-nav');
  if (nav && typeof window.requestAnimationFrame === 'function') {
    let lastY = Math.max(0, window.scrollY);
    let direction = 0;
    let travel = 0;
    let navFrame = null;
    let navHeight = nav.getBoundingClientRect().height;
    const reveal = () => {
      nav.classList.remove('is-hidden');
      travel = 0;
    };
    const updateNav = () => {
      navFrame = null;
      const y = Math.max(0, window.scrollY);
      const delta = y - lastY;
      lastY = y;
      if (y <= navHeight || nav.contains(document.activeElement)) { reveal(); return; }
      if (delta === 0) return;
      const nextDirection = delta > 0 ? 1 : -1;
      travel = nextDirection === direction ? travel + Math.abs(delta) : Math.abs(delta);
      direction = nextDirection;
      if (direction > 0 && travel >= navHeight) nav.classList.add('is-hidden');
      if (direction < 0 && travel >= 8) reveal();
    };
    window.addEventListener('scroll', () => {
      if (navFrame === null) navFrame = window.requestAnimationFrame(updateNav);
    }, { passive: true });
    window.addEventListener('resize', () => { navHeight = nav.getBoundingClientRect().height; });
    nav.addEventListener('focusin', reveal);
  }
  if (document.body.dataset.page !== 'home') return;
  const legacyPages = new Map([
    ['#how-it-works', 'how-it-works.html'],
    ['#questions', 'about.html#questions'],
  ]);
  const followLegacyLink = () => {
    const destination = legacyPages.get(window.location.hash);
    if (!destination) return false;
    window.location.replace(new URL(destination, window.location.href).href);
    return true;
  };
  window.addEventListener('hashchange', followLegacyLink);
  if (followLegacyLink()) return;

  const hero = document.querySelector('.hero');
  const scene = hero?.querySelector('.scene');
  const staticPhone = scene?.querySelector('.phone-device');
  const audience = hero?.querySelector('.audience-line');
  const words = audience ? [...audience.querySelectorAll('.audience-word')] : [];
  if (!hero || !scene || !staticPhone || !audience || words.length !== 4 ||
      typeof window.matchMedia !== 'function' ||
      typeof window.IntersectionObserver !== 'function' ||
      typeof window.requestAnimationFrame !== 'function' ||
      typeof window.cancelAnimationFrame !== 'function') return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (typeof reduced.addEventListener !== 'function') return;
  // Failed styles must not turn readable HTML into an invisible animation.
  if (getComputedStyle(scene).getPropertyValue('--showcase-height').trim() !== '500px') return;
  const question = 'School update?';
  const phases = [
    { at: 1100, text: 'Checking school emails' },
    { at: 2500, text: 'Finding deadlines' },
    { at: 3900, text: 'Preparing your reply' },
  ];
  const chatEnd = 5480;
  const audienceStart = chatEnd + 2000;
  const cycleEnd = chatEnd + 5000;
  const audiences = ['Mum', 'Dad', 'Children', 'everyone'];
  let frame = null;
  let watchdog = null;
  let running = false;
  let failed = false;
  let inView = false;
  let elapsed = 0;
  let previous = null;
  let lastDraw = 0;
  let parts = null;
  let currentAudience = 'everyone';

  // One viewed-time clock: chat -> 2s rest -> audience -> 5s total rest -> chat.
  // Off-screen/hidden pauses preserve that clock; fonts never restart it.
  function cancelWork() {
    if (frame !== null) window.cancelAnimationFrame(frame);
    if (watchdog !== null) window.clearTimeout(watchdog);
    frame = null;
    watchdog = null;
  }
  function showAudience(word, still = false) {
    audience.classList.toggle('is-still', still);
    for (const node of words) {
      const value = node.dataset.audience;
      node.classList.toggle('is-active', value === word);
      node.classList.toggle('is-leaving', !still && value === currentAudience && currentAudience !== word);
    }
    currentAudience = word;
  }
  function complete() {
    running = false;
    cancelWork();
    // Restore the untouched original instead of re-running a renderer that failed.
    scene.replaceChildren(staticPhone);
    showAudience('everyone', true);
    hero.dataset.motionState = 'complete';
    previous = null;
    elapsed = 0;
    parts = null;
  }
  function getParts(phone) {
    const parts = {
      prompt: phone.querySelector('#prompt'),
      reply: phone.querySelector('#reply'),
      action: phone.querySelector('#action-bubble'),
      label: phone.querySelector('#action-label'),
    };
    return Object.values(parts).every(Boolean) ? parts : null;
  }
  if (!getParts(staticPhone)) return;

  function fail() {
    failed = true;
    complete();
  }
  function render() {
    const count = Math.max(0, Math.min(question.length, Math.floor((elapsed - 250) / 38)));
    const typed = question.slice(0, count);
    if (parts.prompt.textContent !== typed) parts.prompt.textContent = typed;
    const showingAction = elapsed >= 1100 && elapsed < 5200;
    parts.action.classList.toggle('is-visible', showingAction);
    if (showingAction) {
      let phase = phases[0];
      for (const candidate of phases) if (elapsed >= candidate.at) phase = candidate;
      if (parts.label.textContent !== phase.text) parts.label.textContent = phase.text;
    }
    parts.reply.classList.toggle('reply-shell-hidden', elapsed < 5200);
    // The whole reply has settled before the separate headline sequence begins.
    const word = elapsed < audienceStart ? 'everyone' : audiences[Math.min(3, Math.floor((elapsed - audienceStart) / 700))];
    if (word !== currentAudience) showAudience(word);
    const state = elapsed < chatEnd ? 'playing' : 'resting';
    if (hero.dataset.motionState !== state) hero.dataset.motionState = state;
  }
  function draw(now) {
    if (!running) return;
    try {
      frame = null;
      if (previous !== null) elapsed = (elapsed + now - previous) % cycleEnd;
      previous = now;
      lastDraw = performance.now();
      render();
      frame = window.requestAnimationFrame(draw);
    } catch { fail(); }
  }
  function checkProgress() {
    if (!running) return;
    if (performance.now() - lastDraw > 2000) { fail(); return; }
    watchdog = window.setTimeout(checkProgress, 2500);
  }
  function syncPlayback() {
    if (failed) return;
    if (reduced.matches) { complete(); return; }
    const shouldRun = inView && !document.hidden;
    if (shouldRun === running) return;
    cancelWork();
    previous = null;
    running = shouldRun;
    if (!running) { hero.dataset.motionState = 'paused'; return; }
    try {
      if (!parts) {
        const phone = staticPhone.cloneNode(true);
        parts = getParts(phone);
        if (!parts) { fail(); return; }
        render();
        // Swap a prepared, aria-hidden illustration; the transcript stays static.
        scene.replaceChildren(phone);
      }
      audience.classList.remove('is-still');
      lastDraw = performance.now();
      frame = window.requestAnimationFrame(draw);
      watchdog = window.setTimeout(checkProgress, 2500);
    } catch { fail(); }
  }
  reduced.addEventListener('change', syncPlayback);
  document.addEventListener('visibilitychange', syncPlayback);
  complete();
  try {
    // Observe the phone panel, so mobile copy alone does not start unseen typing.
    const observer = new IntersectionObserver(entries => {
      inView = entries[0].isIntersecting && entries[0].intersectionRatio >= .25;
      syncPlayback();
    }, { threshold: [0, .25] });
    observer.observe(scene);
  } catch { fail(); }
})();

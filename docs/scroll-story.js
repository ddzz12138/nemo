/* Scroll-driven presentation only. Every chapter is readable without this enhancement. */
(() => {
  'use strict';
  const { gsap, ScrollTrigger } = window;
  const stage = document.querySelector('.story-stage');
  if (!gsap || !ScrollTrigger || !stage ||
      getComputedStyle(stage).getPropertyValue('--story-ready').trim() !== '1') return;
  gsap.registerPlugin(ScrollTrigger);
  const media = gsap.matchMedia();
  const track = stage.closest('.story-track');
  const panels = gsap.utils.toArray('.story-panel');
  const rail = document.querySelector('.story-rail-inner');
  const labels = [...rail.children];
  const meter = document.querySelector('.story-progress-track > span');
  const count = document.querySelector('.story-count');

  // Pin only where there is room for a complete chapter. No scroll interception.
  try {
  media.add('(min-width: 961px) and (min-height: 740px) and (prefers-reduced-motion: no-preference)', () => {
    stage.classList.add('is-enhanced');
    gsap.set(panels.slice(1), { opacity: 0, y: 60, pointerEvents: 'none' });
    const timeline = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        // Read the normal-flow section in native document coordinates. Native
        // fragment navigation can precede GSAP's cached scroll-position update.
        id: 'nemo-story', trigger: track,
        start: () => track.getBoundingClientRect().top + window.scrollY,
        end: () => `+=${window.innerHeight * 2.7}`, pin: stage,
        scrub: .45, invalidateOnRefresh: true,
        onUpdate(self) {
          const index = self.progress < .37 ? 0 : self.progress < .7 ? 1 : 2;
          labels.forEach((label, i) => label.classList.toggle('is-active', i === index));
          count.textContent = `0${index + 1} / 03`;
          meter.style.transform = `scaleX(${Math.max(.04, self.progress)})`;
        },
      },
    });
    // Reveal the edges without scaling the element ScrollTrigger measures/pins.
    timeline.fromTo(stage, { clipPath: 'inset(3% 3% round 40px)' }, { clipPath: 'inset(0% 0% round 0px)', duration: .18 }, 0);
    for (let index = 1; index < panels.length; index++) {
      const at = index === 1 ? .29 : .62;
      timeline.to(panels[index - 1], { opacity: 0, y: -45, duration: .1, pointerEvents: 'none' }, at);
      timeline.to(panels[index], { opacity: 1, y: 0, duration: .12, pointerEvents: 'auto' }, at + .07);
      timeline.to(rail, { x: () => -labels[index].offsetLeft, duration: .16 }, at);
    }
    timeline.to({}, { duration: .18 }, .82);
    return () => {
      stage.classList.remove('is-enhanced');
      labels.forEach((label, i) => label.classList.toggle('is-active', i === 0));
      meter.style.removeProperty('transform');
    };
  });

  media.add('(prefers-reduced-motion: no-preference)', () => {
    gsap.fromTo('.hardware-atmosphere', { scale: .87, y: 50 }, {
      scale: 1, y: -18, ease: 'none',
      scrollTrigger: { trigger: '.hardware-stage', start: 'top bottom', end: 'bottom top', scrub: .6 },
    });
    gsap.fromTo('.presence-light', { opacity: .35 }, {
      opacity: 1, ease: 'none',
      scrollTrigger: { trigger: '.hardware-stage', start: 'top 80%', end: 'center center', scrub: true },
    });
  });

  // Local fonts can settle after initial layout; refresh geometry once they do.
  document.fonts?.ready.then(() => ScrollTrigger.refresh());
  window.addEventListener('pageshow', () => ScrollTrigger.refresh());
  } catch {
    // A failed enhancement must leave the ordinary document fully readable.
    media.revert();
    stage.classList.remove('is-enhanced');
    gsap.set([stage, rail, ...panels], { clearProps: 'all' });
  }
})();

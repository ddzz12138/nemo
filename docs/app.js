/* Core pages and native disclosures work without JavaScript. Keep old bookmarks useful. */
(() => {
  if (document.body.dataset.page !== 'home') return;
  const legacyPages = new Map([
    ['#how-it-works', 'how-it-works.html'],
    ['#questions', 'about.html#questions'],
  ]);
  const followLegacyLink = () => {
    const destination = legacyPages.get(window.location.hash);
    if (destination) window.location.replace(new URL(destination, window.location.href).href);
  };
  followLegacyLink();
  window.addEventListener('hashchange', followLegacyLink);
})();

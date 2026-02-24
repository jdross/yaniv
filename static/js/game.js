// Legacy entrypoint kept for compatibility.
// New pages load split files from /js/game/*.js directly.
(function bootstrapLegacyGameScript() {
  if (window.__yanivSplitClientLoaded) return;
  window.__yanivSplitClientLoaded = true;

  const scripts = [
    '/js/game/core.js',
    '/js/game/animations.js',
    '/js/game/render.js',
    '/js/game/actions.js',
    '/js/game/main.js',
  ];

  let idx = 0;
  const loadNext = () => {
    if (idx >= scripts.length) return;
    const el = document.createElement('script');
    el.src = scripts[idx++];
    el.defer = false;
    el.onload = loadNext;
    document.head.appendChild(el);
  };

  loadNext();
})();

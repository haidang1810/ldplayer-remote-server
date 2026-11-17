// Applied before first paint (classic script in <head>): saved theme, else the OS preference.
(function () {
  var t = null;
  try { t = localStorage.getItem('ldr-theme'); } catch (e) { /* private mode */ }
  if (t !== 'light' && t !== 'dark') t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  var meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#f3f5fa' : '#0b0e15');
})();

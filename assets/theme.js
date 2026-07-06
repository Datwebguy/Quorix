(function () {
  var KEY = 'quorix-theme';
  var root = document.documentElement;

  function getStored() {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }

  function getTheme() {
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function apply(theme) {
    if (theme === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    try {
      localStorage.setItem(KEY, theme);
    } catch (e) {}
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      var isLight = theme === 'light';
      btn.setAttribute('aria-pressed', isLight ? 'true' : 'false');
      btn.setAttribute('aria-label', isLight ? 'Switch to dark mode' : 'Switch to light mode');
      var icon = btn.querySelector('.theme-toggle-icon');
      if (icon) icon.textContent = isLight ? '☀' : '☾';
    });
    window.dispatchEvent(new CustomEvent('quorix-theme-change', { detail: { theme: theme } }));
  }

  function toggle() {
    apply(getTheme() === 'dark' ? 'light' : 'dark');
  }

  window.QuorixTheme = { get: getTheme, set: apply, toggle: toggle };

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-theme-toggle]');
    if (btn) {
      e.preventDefault();
      toggle();
    }
  });

  var stored = getStored();
  if (stored === 'light' || stored === 'dark') apply(stored);
})();
/* Cheaper theme toggle. Default is light. Injects a sun/moon button into the
   top-nav (.navright) on every page and persists the choice (best-effort). */
(function () {
  var KEY = 'cheaper-theme';
  function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  function current() { return document.documentElement.getAttribute('data-theme') || 'light'; }

  var SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  var btn;
  function apply(t) {
    document.documentElement.setAttribute('data-theme', t);
    if (btn) {
      // show the icon of the mode you'll switch TO
      btn.innerHTML = t === 'dark' ? SUN : MOON;
      btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      btn.setAttribute('title', btn.getAttribute('aria-label'));
    }
  }
  function init() {
    var host = document.querySelector('.navright');
    btn = document.createElement('button');
    btn.className = 'themebtn';
    btn.onclick = function () { var n = current() === 'dark' ? 'light' : 'dark'; apply(n); save(n); };
    if (host) host.insertBefore(btn, host.firstChild); else document.body.appendChild(btn);
    apply(get() || current() || 'light');
  }
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();

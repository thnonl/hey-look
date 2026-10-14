/* Runs before first paint: applies the saved theme and motion choice. No cookies; localStorage only, in try/catch. */
(function () {
  var r = document.documentElement;
  r.classList.add('js');
  try {
    var p = window.localStorage.getItem('hl2-theme');
    if (p === 'light' || p === 'dark') { r.setAttribute('data-theme', p); r.setAttribute('data-pref', p); } else { r.setAttribute('data-pref', 'auto'); }
    var q = /[?&]theme=(light|dark)/.exec(location.search); /* handy for screenshots, not stored */
    if (q) { r.setAttribute('data-theme', q[1]); r.setAttribute('data-pref', q[1]); }
  } catch (e) { r.setAttribute('data-pref', 'auto'); }
  /* animations: auto = follow the system, on = always, off = never; ?motion=on|off|auto is for one visit (not stored); the old hl2-calm = 1 still means off */
  try {
    var u = /[?&]motion=(on|off|auto)/.exec(location.search), m = u ? u[1] : null;
    if (!m) {
      m = window.localStorage.getItem('hl2-motion');
      if (m !== 'on' && m !== 'off') m = (window.localStorage.getItem('hl2-calm') === '1' || /[?&]calm=1/.test(location.search)) ? 'off' : 'auto';
    }
    if (m === 'off') r.classList.add('calm'); else if (m === 'on') r.classList.add('motion-on');
  } catch (e) { /* auto */ }
})();

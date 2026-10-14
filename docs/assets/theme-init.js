/* Runs before first paint: applies the saved theme and motion choice. No cookies; localStorage only, in try/catch. */
(function () {
  var r = document.documentElement;
  r.classList.add('js');
  try {
    var p = window.localStorage.getItem('hl2-theme');
    if (p === 'light' || p === 'dark') { r.setAttribute('data-theme', p); r.setAttribute('data-pref', p); } else { r.setAttribute('data-pref', 'auto'); }
    var q = /[?&]theme=(light|dark)/.exec(location.search); /* handy for screenshots, not stored */
    if (q) { r.setAttribute('data-theme', q[1]); r.setAttribute('data-pref', q[1]); }
    if (window.localStorage.getItem('hl2-calm') === '1' || /[?&]calm=1/.test(location.search)) r.classList.add('calm');
  } catch (e) { r.setAttribute('data-pref', 'auto'); }
})();

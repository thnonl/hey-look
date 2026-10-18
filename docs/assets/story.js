/* Hey Look! site v2, home page only: the scroll story (sticky stage with a drawn app window whose scenes change as you scroll,
   each with a working demo) and the appearance customiser. Vanilla JS, no libraries. Demo mail is made up.
   Nothing here talks to a network. */
(function () {
  'use strict';
  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
  var root = document.documentElement;
  var HL = window.HL || { motionOn: function () { return false; }, resolvedTheme: function () { return 'light'; }, onTheme: function () { }, onMotion: function () { } };
  /* texts come from assets/i18n/<code>.js through site.js (HL.t); a key that is missing shows as the key */
  var T = HL.t || function (k) { return k; }, TN = HL.tn || function (k) { return k; }, RICH = HL.rich || function (k) { return k; };
  var LOC = HL.locale ? HL.locale() : 'en';
  var mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: false };

  /* ---------- colour helpers (same idea as the app's prefs.ts: keep accent text readable) ---------- */
  function rgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&'); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function hex(c) { return '#' + c.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }
  function mix(a, b, t) { var x = rgb(a), y = rgb(b); return hex([0, 1, 2].map(function (i) { return x[i] * (1 - t) + y[i] * t; })); }
  function lum(h) { var c = rgb(h).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function contrast(a, b) { var l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
  /* returns {acc, fg, text} for a base colour on a light or dark surface */
  function accentSet(base, theme, bg) {
    var dark = theme === 'dark';
    var acc = dark ? mix(base, '#ffffff', 0.4) : base;
    var fg = ['#ffffff', '#07121f', '#000000'].reduce(function (best, c) { return contrast(acc, c) > contrast(acc, best) ? c : best; }, '#ffffff');
    var text = acc, soft = mix(acc, bg, 0.88), n = 0;
    while (contrast(text, soft) < 4.6 && n++ < 60) text = mix(text, dark ? '#ffffff' : '#000000', 0.06);
    return { acc: acc, fg: fg, text: text };
  }

  /* top bar of the drawn window: a gradient of the accent; pick white or dark text and nudge the colour until the text passes */
  function topSet(base) {
    var best = null;
    [['#ffffff', false], ['#07121f', true]].forEach(function (c) {
      var b = base, n = 0, worst = function (x) { return Math.min(contrast(c[0], mix(x, '#000000', 0.22)), contrast(c[0], x)); };
      while (worst(b) < 4.7 && n++ < 60) b = mix(b, c[1] ? '#ffffff' : '#000000', 0.05);
      var cost = Math.abs(lum(b) - lum(base));
      if (!best || cost < best.cost) best = { fg: c[0], b: b, cost: cost };
    });
    return { fg: best.fg, grad: 'linear-gradient(135deg, ' + mix(best.b, '#000000', 0.22) + ', ' + best.b + ')' };
  }

  /* dark-theme top bar: the app (src/topBarDark.ts, F-31) shows the primary colour as a DARK tint there. Same formula, ported 1:1:
     only the hue of the primary is used, at a fixed dark lightness (OKLCH L .255 -> .31) and a capped chroma that follows the primary's
     own chroma (white / black / grey give the neutral bar); C is reduced until both ends are inside sRGB and have luminance <= .06.
     Returns {start, end}, the two ends of the 135deg gradient (--a-top-dk-s / --a-top-dk-e in style.css). */
  function darkTopBar(primary) {
    var LS = 0.255, LE = 0.31, CMAX = 0.06, CFULL = 0.08, MAXLUM = 0.06;
    var lin = function (v) { var c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    var enc = function (c) { return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); };
    var q = rgb(primary), r = lin(q[0]), g = lin(q[1]), b = lin(q[2]);
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    var oa = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, ob = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    var pc = Math.sqrt(oa * oa + ob * ob), h = Math.atan2(ob, oa);
    var linear = function (L, c) {
      var a = c * Math.cos(h), bb = c * Math.sin(h), x = Math.pow(L + 0.3963377774 * a + 0.2158037573 * bb, 3), y = Math.pow(L - 0.1055613458 * a - 0.0638541728 * bb, 3), z = Math.pow(L - 0.0894841775 * a - 1.291485548 * bb, 3);
      return [4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z, -1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z, -0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z];
    };
    var rl = function (v) { return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    var fits = function (v) { return v.every(function (k) { return k >= 0 && k <= 1; }); };
    var ok = function (v) { return fits(v) && rl(v) <= MAXLUM; };
    var hx = function (v) { return '#' + v.map(function (k) { var n = enc(Math.min(1, Math.max(0, k))); return (n < 16 ? '0' : '') + n.toString(16); }).join(''); };
    var c = CMAX * Math.min(1, pc / CFULL), st = linear(LS, c), en = linear(LE, c);
    for (var i = 0; i < 40 && c > 0 && !(ok(st) && ok(en)); i++) { c *= 0.9; st = linear(LS, c); en = linear(LE, c); }
    return { start: hx(st), end: hx(en) };
  }
  HL.darkTopBar = darkTopBar;

  /* =============================== the story stage =============================== */
  var stage = $('#stage');
  if (stage) (function () {
    var app = $('.app', stage), live = $('#stage-live'), stageCol = stage.parentNode;
    var steps = $$('.step'), dots = $$('.s-nav button', stage);
    var cap = { n: $('.sc-n', stage), t: $('.sc-t', stage) };
    var layers = $$('.a-layer[data-for]', app);
    var scene = '', stageTheme = null;
    var say = function (t) { live.textContent = ''; setTimeout(function () { live.textContent = t; }, 40); };
    var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

    /* ----- theme: the stage follows the site theme; the command bar can override it locally ----- */
    function syncTheme() {
      var t = stageTheme || (root.getAttribute('data-theme') === 'light' || root.getAttribute('data-theme') === 'dark' ? root.getAttribute('data-theme') : null);
      if (t) app.setAttribute('data-theme', t); else app.removeAttribute('data-theme');
    }
    HL.onTheme(function () { stageTheme = null; syncTheme(); });
    syncTheme();

    /* ----- mail rows and the reading pane ----- */
    var rows = $$('.a-row', app), rowsBox = $('.a-rows', app), empty = $('.a-empty', app);
    var mail = $('.r-mail', app), news = $('.r-news', app), rText = $('.r-text', mail), rSubj = $('.r-subj', mail), rFrom = $('.r-from', mail), rAv = $('.r-av', mail), rMeta = $('.r-meta span', mail);
    var alive = function () { return rows.filter(function (r) { return !r.classList.contains('out'); }); };
    function reveal(r) {
      var box = rowsBox.getBoundingClientRect(), b = r.getBoundingClientRect();
      if (b.top < box.top) rowsBox.scrollTop -= box.top - b.top; else if (b.bottom > box.bottom) rowsBox.scrollTop += b.bottom - box.bottom;
    }
    function select(r) {
      if (!r) return;
      rows.forEach(function (x) { x.classList.toggle('sel', x === r); r.removeAttribute('aria-current'); });
      r.setAttribute('aria-current', 'true');
      var isNews = r.getAttribute('data-news') === '1';
      news.hidden = !isNews; mail.hidden = isNews;
      if (!isNews) {
        rSubj.textContent = r.getAttribute('data-subj'); rFrom.textContent = r.getAttribute('data-from');
        rAv.className = 'a-av r-av ' + $('.a-av', r).className.split(' ').pop(); rAv.textContent = $('.a-av', r).textContent;
        rMeta.textContent = T('story.to_me', { time: $('.a-time', r).textContent });
        rText.innerHTML = r.getAttribute('data-body').split('||').map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
      }
      reveal(r);
    }
    var current = function () { return rows.filter(function (r) { return r.classList.contains('sel'); })[0] || alive()[0]; };
    function move(d) {
      var al = alive(); if (!al.length) return;
      var i = al.indexOf(current()); i = Math.max(0, Math.min(al.length - 1, (i < 0 ? 0 : i) + d)); select(al[i]);
      say(T('story.selected', { subj: al[i].getAttribute('data-subj') }));
    }
    function showEmpty() { var none = !alive().length; empty.hidden = !none; }
    function removeRow(r, msg, label) {
      if (!r) return;
      var al = alive(), i = al.indexOf(r), nxt = al[i + 1] || al[i - 1];
      r.classList.add('out'); r.setAttribute('aria-hidden', 'true');
      if (nxt) select(nxt); showEmpty();
      toast(msg, 6, function () { r.classList.remove('out'); r.removeAttribute('aria-hidden'); r.classList.remove('back'); void r.offsetWidth; r.classList.add('back'); select(r); showEmpty(); say(T('story.undone', { subj: r.getAttribute('data-subj') })); }, label);
      say(T('story.undo_hint', { msg: msg }));
    }
    function refill() { rows.forEach(function (r) { r.classList.remove('out'); r.removeAttribute('aria-hidden'); }); showEmpty(); select(rows[0]); hideToast(); }

    /* ----- toast with a real countdown ----- */
    var tEl = $('.a-toast', app), tMsg = $('.t-msg', tEl), tUndo = $('.t-undo', tEl), tN = $('.t-n', tEl), tTimer = null, tUndoFn = null;
    function hideToast() { clearInterval(tTimer); tTimer = null; tUndoFn = null; tEl.hidden = true; }
    function toast(msg, secs, undo) {
      clearInterval(tTimer); tMsg.textContent = msg; tUndoFn = undo || null;
      tUndo.hidden = !undo; tEl.hidden = false; tEl.style.animation = 'none'; void tEl.offsetWidth; tEl.style.animation = '';
      var left = secs; tN.textContent = '(' + left + ')';
      tTimer = setInterval(function () { left--; tN.textContent = '(' + left + ')'; if (left <= 0) hideToast(); }, 1000);
      if (!undo) { tTimer && clearInterval(tTimer); tTimer = setTimeout(hideToast, 3500); }
    }
    tUndo.addEventListener('click', function () { var f = tUndoFn; hideToast(); if (f) f(); });

    /* ----- compose: undo send, send later, encrypt/sign ----- */
    var comp = $('.a-compose', app), cs = $('.c-state', comp), ring = $('.rg', comp), cn = $('.cs-n', comp), ch = $('.cs-h', comp), cp = $('.cs-p', comp);
    var cUndo = $('.cs-undo', comp), cAgain = $('.cs-again', comp), sendBtn = $('.c-send', comp), cRing = $('.cs-ring', comp);
    var hold = 10, sendTimer = null, schedCount = 0;
    var CIRC = 94.25;
    function cstate(mode, o) {
      cs.hidden = !mode; if (!mode) return;
      cRing.hidden = !!o.noRing; cn.textContent = o.n || ''; ch.textContent = o.h; cp.textContent = o.p;
      cUndo.hidden = !o.undo; cAgain.hidden = !o.again; cAgain.textContent = o.again || '';
      ring.style.transition = 'none'; ring.style.strokeDashoffset = (o.off || 0); void ring.getBoundingClientRect(); ring.style.transition = '';
    }
    function resetCompose() {
      clearInterval(sendTimer); sendTimer = null; cstate(null);
      if (schedCount) { schedCount = 0; setCount('sched', 0); }
      closeMenus();
    }
    function startSend() {
      if (sendTimer) return;
      var left = hold;
      var paint = function () {
        cstate(true, { n: left, h: T('story.sending_in', { n: left }), p: T('story.sending_p'), undo: true, off: CIRC * (1 - left / hold) });
      };
      paint(); say(T('story.sending_say', { n: hold }));
      sendTimer = setInterval(function () {
        left--;
        if (left > 0) {
          cn.textContent = left; ch.textContent = T('story.sending_in', { n: left }); ring.style.strokeDashoffset = CIRC * (1 - left / hold);
        } else {
          clearInterval(sendTimer); sendTimer = null;
          cstate(true, { n: '✓', h: T('story.sent'), p: T('story.sent_p'), again: T('story.write_another') });
          say(T('story.sent'));
        }
      }, 1000);
    }
    function undoSend() {
      clearInterval(sendTimer); sendTimer = null;
      cstate(true, { n: '↺', h: T('story.cancelled'), p: T('story.cancelled_p'), again: T('story.back_to_draft') });
      say(T('story.cancelled_say'));
    }
    $$('.c-seg', comp).forEach(function (b) {
      b.addEventListener('click', function () {
        hold = parseInt(b.getAttribute('data-hold'), 10);
        $$('.c-seg', comp).forEach(function (o) { o.setAttribute('aria-pressed', o === b ? 'true' : 'false'); });
        say(T('story.undo_window', { n: hold }));
      });
    });
    /* encrypt / sign */
    var cipherEl = $('.c-cipher', comp), plain = $('.c-plain', comp), keyok = $('.c-keyok', comp), seal = $('.c-seal', comp);
    (function () {
      var seed = 7, b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', out = '-----BEGIN PGP MESSAGE-----\n\n';
      for (var l = 0; l < 6; l++) { for (var i = 0; i < 44; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; out += b64.charAt((seed >>> 24) & 63); } out += '\n'; }
      cipherEl.textContent = out + '-----END PGP MESSAGE-----';
    })();
    $$('.c-tog', comp).forEach(function (b) {
      b.addEventListener('click', function () {
        var on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (b.getAttribute('data-tog') === 'enc') {
          comp.setAttribute('data-enc', on ? '1' : '0'); cipherEl.hidden = !on; plain.hidden = on; keyok.hidden = !on;
          say(T(on ? 'story.enc_on' : 'story.enc_off'));
        } else { seal.hidden = !on; say(T(on ? 'story.sign_on' : 'story.sign_off')); }
      });
    });
    /* send later */
    var laterBtn = $('[data-act="later-open"]', comp), laterMenu = $('.a-menu', $('.c-later', comp)), dt = $('.m-dt', comp), dtNote = $('#m-dt-note');
    var fmt = function (d) { var p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); };
    (function () { var n = new Date(), m = new Date(n.getTime() + 365 * 864e5); dt.min = fmt(n); dt.max = fmt(m); })();
    function closeMenus() {
      $$('.a-menu', app).forEach(function (m) { m.hidden = true; });
      $$('[aria-haspopup]', app).forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
    }
    function toggleMenu(btn, menu) {
      var open = menu.hidden; closeMenus(); menu.hidden = !open; btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { var f = $('button, input', menu); if (f) f.focus(); }
    }
    laterBtn.addEventListener('click', function () { toggleMenu(laterBtn, laterMenu); });
    function schedule(when) {
      closeMenus(); schedCount = 1; setCount('sched', 1);
      cstate(true, { noRing: true, h: T('story.scheduled', { when: when }), p: T('story.scheduled_p'), again: T('story.cancel_keep') });
      say(T('story.scheduled_say', { when: when }));
    }
    $$('[data-when]', laterMenu).forEach(function (b) { b.addEventListener('click', function () { schedule(b.getAttribute('data-when')); }); });
    dt.addEventListener('change', function () {
      var d = new Date(dt.value), now = new Date();
      if (isNaN(d)) return;
      if (d < now) { dtNote.textContent = T('story.dt_past'); return; }
      if (d > new Date(now.getTime() + 365 * 864e5)) { dtNote.textContent = T('story.dt_limit'); return; }
      dtNote.textContent = T('story.dt_limit');
      schedule(d.toLocaleString(LOC, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
    });
    function setCount(which, n) { var b = $('[data-count="' + which + '"]', app); b.textContent = n; b.classList.toggle('zero', !n); }

    /* ----- snooze ----- */
    var snzBtn = $('.r-snooze', app), snzMenu = $('.a-menu', $('.r-snz', app)), snzed = null, snzRow = null, snzCount = 0;
    function snzBanner(html) {
      if (!snzed) { snzed = document.createElement('div'); snzed.className = 'r-snoozed'; snzed.setAttribute('role', 'status'); $('.a-read', app).insertBefore(snzed, $('.r-tools', app).nextSibling); }
      snzed.innerHTML = html;
    }
    function dropSnooze() { if (snzed) { snzed.remove(); snzed = null; } snzRow = null; }
    snzBtn.addEventListener('click', function () { toggleMenu(snzBtn, snzMenu); });
    $$('[data-snz]', snzMenu).forEach(function (b) {
      b.addEventListener('click', function () {
        closeMenus(); var w = b.getAttribute('data-snz');
        if (w === 'custom') { toast(T('story.snz_custom'), 3); say(T('story.snz_custom_say')); return; }
        var r = current(); if (!r || snzRow) return;
        var al = alive(), i = al.indexOf(r), nxt = al[i + 1] || al[i - 1];
        snzRow = r; r.classList.add('out'); r.setAttribute('aria-hidden', 'true'); snzCount = 1; setCount('snooze', 1);
        if (nxt) select(nxt); showEmpty();
        snzBanner('<span>' + RICH('story.snoozed', { subj: r.getAttribute('data-subj'), when: w }) + '</span><button type="button" class="r-btn" data-act="snz-skip">' + esc(T('story.jump_ahead')) + '</button>');
        say(T('story.snz_say', { when: w }));
      });
    });
    function snzSkip() {
      var r = snzRow; if (!r) return;
      r.classList.remove('out'); r.removeAttribute('aria-hidden'); r.classList.remove('back'); void r.offsetWidth; r.classList.add('back'); select(r); showEmpty();
      snzCount = 0; setCount('snooze', 0); snzBanner('<span>' + esc(T('story.snz_back')) + '</span><button type="button" class="r-btn" data-act="snz-reset">' + esc(T('story.ok')) + '</button>');
      say(T('story.snz_back_say'));
    }

    /* ----- command bar ----- */
    var pal = $('.a-pal', app), inp = $('.p-input', pal), list = $('.p-list', pal), pnote = $('.p-note', pal);
    /* The labels in data-cmds are translated in each page; the order is fixed. CMD_IDS names each position, so the logic below never reads the words. */
    var CMD_IDS = ['new-mail', 'sync', 'new-event', 'go-calendar', 'go-mail', 'cal-month', 'cal-week', 'cal-agenda', 'settings', 'updates', 'sweep', 'theme-light', 'theme-dark', 'theme-system', 'toggle-pane', 'toggle-conv', 'toggle-focused', 'go-inbox', 'go-unread', 'go-flagged', 'go-pinned', 'go-snoozed', 'go-scheduled', 'go-sent', 'go-drafts', 'go-archive', 'go-junk', 'go-deleted', 'archive', 'delete', 'unread', 'flag', 'pin', 'all-accounts'];
    var cmds = JSON.parse(list.getAttribute('data-cmds')).map(function (label, i) { return { id: CMD_IDS[i] || '', label: label }; });
    var hints = { 'new-mail': 'c', 'sync': 'F5', 'go-mail': 'Ctrl 1', 'go-calendar': 'Ctrl 2', 'archive': 'e', 'delete': '#', 'flag': '*', 'pin': 'p', 'unread': 'u' };
    var shown = [], qi = 0;
    function render() {
      var toks = inp.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      shown = cmds.filter(function (c) { var l = c.label.toLowerCase(); return toks.every(function (t) { return l.indexOf(t) >= 0; }); });
      qi = Math.min(qi, Math.max(0, shown.length - 1));
      var re = toks.length ? new RegExp('(' + toks.map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')', 'ig') : null;
      list.innerHTML = shown.length ? shown.map(function (c, i) {
        return '<li role="option" id="pal-o-' + i + '" data-i="' + i + '" aria-selected="' + (i === qi) + '"><span>' + (re ? esc(c.label).replace(re, '<mark>$1</mark>') : esc(c.label)) + '</span>' + (hints[c.id] ? '<kbd class="hint">' + hints[c.id] + '</kbd>' : '') + '</li>';
      }).join('') : '<li role="presentation" class="none">' + esc(T('story.cmd_none')) + '</li>';
      inp.setAttribute('aria-activedescendant', shown.length ? 'pal-o-' + qi : '');
      pnote.textContent = TN('story.cmd_count', shown.length);
      var s = $('[aria-selected="true"]', list); if (s) { var lb = list.getBoundingClientRect(), sb = s.getBoundingClientRect(); if (sb.top < lb.top) list.scrollTop -= lb.top - sb.top; else if (sb.bottom > lb.bottom) list.scrollTop += sb.bottom - lb.bottom; }
    }
    function runCmd(c) {
      var m = '';
      var tm = /^theme-(light|dark|system)$/.exec(c.id);
      if (tm) { var t = tm[1]; stageTheme = t === 'system' ? (mqDark.matches ? 'dark' : 'light') : t; syncTheme(); m = T('story.cmd_theme', { label: c.label }); }
      else if (c.id === 'toggle-pane') { app.setAttribute('data-pane', app.getAttribute('data-pane') === 'right' ? 'bottom' : 'right'); m = T('story.pane_now', { pos: T(app.getAttribute('data-pane') === 'right' ? 'story.pos_right' : 'story.pos_bottom') }); }
      else if (c.id === 'toggle-conv') { var v = app.getAttribute('data-conv') === 'on' ? 'off' : 'on'; app.setAttribute('data-conv', v); m = T('story.conv_state', { state: T('story.' + v) }); }
      else if (c.id === 'toggle-focused') { var f = app.getAttribute('data-focused') === 'on' ? 'off' : 'on'; app.setAttribute('data-focused', f); m = T('story.focused_state', { state: T('story.' + f) }); }
      else if (c.id === 'archive') { removeRow(current(), T('story.archived')); m = T('story.cmd_archived'); }
      else if (c.id === 'delete') { removeRow(current(), T('story.deleted')); m = T('story.cmd_deleted'); }
      else m = T('story.cmd_demo', { label: c.label });
      pnote.textContent = m; say(m);
    }
    inp.addEventListener('input', function () { qi = 0; render(); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); qi = Math.min(shown.length - 1, qi + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); qi = Math.max(0, qi - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[qi]) runCmd(shown[qi]); }
      else if (e.key === 'Escape') { inp.value = ''; qi = 0; render(); }
    });
    list.addEventListener('click', function (e) { var li = e.target.closest && e.target.closest('li[data-i]'); if (li) { qi = +li.getAttribute('data-i'); render(); runCmd(shown[qi]); inp.focus(); } });
    render();

    /* ----- calendar ----- */
    var calBuilt = false, evCell = null, kBtns = $$('[data-rsvp]', app), kNote = $('.k-note', app);
    function buildCal() {
      if (calBuilt) return; calBuilt = true;
      var n = new Date(), y = n.getFullYear(), m = n.getMonth(), first = new Date(y, m, 1), off = (first.getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
      $('.k-month', app).textContent = n.toLocaleString(LOC, { month: 'long', year: 'numeric' });
      var g = $('.k-grid', app), h = '';
      T('story.weekdays').split('|').forEach(function (d) { h += '<div class="wd">' + d + '</div>'; });
      var thu = 0; for (var d = n.getDate() + 1; d <= days; d++) { if (new Date(y, m, d).getDay() === 4) { thu = d; break; } }
      if (!thu) for (d = days; d >= 1; d--) { if (new Date(y, m, d).getDay() === 4) { thu = d; break; } }
      for (var i = 0; i < off; i++) h += '<div></div>';
      for (d = 1; d <= days; d++) h += '<div' + (d === n.getDate() ? ' class="today"' : '') + (d === thu ? ' data-ev="1"' : '') + '>' + d + '</div>';
      g.innerHTML = h; evCell = $('[data-ev]', g);
      var wk = new Date(y, m, thu).toLocaleString(LOC, { weekday: 'long' }); $('.k-when', app).textContent = T('story.cal_when', { weekday: wk, day: thu });
    }
    kBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-rsvp'), old = $('.k-ev', evCell); if (old) old.remove();
        kBtns.forEach(function (o) { o.setAttribute('aria-pressed', o === b ? 'true' : 'false'); });
        var msg;
        if (v === 'decline') msg = T('story.cal_declined');
        else { var e = document.createElement('span'); e.className = 'k-ev' + (v === 'tentative' ? ' tent' : ''); e.textContent = T('story.cal_event'); evCell.appendChild(e); msg = T(v === 'accept' ? 'story.cal_accepted' : 'story.cal_tentative'); }
        kNote.textContent = msg + ' ' + T('story.cal_note'); say(msg);
      });
    });

    /* ----- remote images ----- */
    var rbm = $('.rb-m', app), loadB = $('[data-act="load-img"]', app), resetB = $('[data-act="reset-img"]', app);
    function images(on) {
      news.classList.toggle('loaded', on); loadB.hidden = on; resetB.hidden = !on;
      rbm.textContent = T(on ? 'story.img_loaded' : 'story.img_blocked');
      say(T(on ? 'story.img_loaded_say' : 'story.img_blocked_say'));
      (on ? resetB : loadB).focus();
    }

    /* ----- stage clicks ----- */
    stage.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-act]'); if (!b) return;
      switch (b.getAttribute('data-act')) {
        case 'key-j': move(1); break; case 'key-k': move(-1); break;
        case 'key-e': case 'archive': removeRow(current(), T('story.archived')); break;
        case 'refill': refill(); break;
        case 'send': startSend(); break;
        case 'undo-send': undoSend(); break;
        case 'compose-again': resetCompose(); break;
        case 'snooze-open': break;
        case 'snz-skip': snzSkip(); break;
        case 'snz-reset': dropSnooze(); break;
        case 'load-img': images(true); break; case 'reset-img': images(false); break;
      }
    });
    rows.forEach(function (r) { r.addEventListener('click', function () { select(r); }); });

    /* ----- keyboard on the stage (only while the stage is on screen, never while typing) ----- */
    function stageVisible() { var r = stage.getBoundingClientRect(); return r.bottom > 80 && r.top < innerHeight - 80; }
    document.addEventListener('keydown', function (e) {
      var k = e.key;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && k.toLowerCase() === 'k') { e.preventDefault(); go('cmd', true); return; }
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target; if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (k === 'Escape') { closeMenus(); return; }
      if (scene !== 'triage' && scene !== 'snooze') return;
      if (!stageVisible()) return;
      if (t && t.closest && t.closest('.a-menu')) return;
      var lk = k.length === 1 ? k.toLowerCase() : k;
      if (lk === 'j') { e.preventDefault(); move(1); }
      else if (lk === 'k') { e.preventDefault(); move(-1); }
      else if (lk === 'e') { e.preventDefault(); removeRow(current(), T('story.archived')); }
      else if (k === '#') { e.preventDefault(); removeRow(current(), T('story.deleted')); }
      else if (k === '!') { e.preventDefault(); removeRow(current(), T('story.junk')); }
      else if (lk === 's') { e.preventDefault(); toggleMenu(snzBtn, snzMenu); }
    });
    document.addEventListener('click', function (e) { if (!e.target.closest || !e.target.closest('.r-snz, .c-later')) closeMenus(); });
    /* menus: Escape returns focus to their button */
    app.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var m = e.target.closest && e.target.closest('.a-menu'); if (!m) return;
      var btn = $('[aria-haspopup]', m.parentNode); closeMenus(); if (btn) btn.focus(); e.stopPropagation();
    });

    /* ----- scenes ----- */
    var titles = {};
    steps.forEach(function (s, i) { titles[s.getAttribute('data-scene')] = [i + 1, $('.st-n', s).childNodes[1].textContent]; });
    function setScene(id) {
      if (id === scene) return;
      var leaving = scene; scene = id; stage.setAttribute('data-scene', id);
      layers.forEach(function (l) { l.classList.toggle('on', l.getAttribute('data-for').split(' ').indexOf(id) >= 0); });
      closeMenus(); if (leaving === 'undo' || leaving === 'later') resetCompose();
      if (leaving === 'snooze') { dropSnooze(); if (snzRow === null) { /* keep count */ } }
      if (id === 'undo' || id === 'later' || id === 'pgp') { if (id !== 'pgp') resetCompose(); }
      if (id === 'cal') buildCal();
      if (id === 'images') { var nr = rows.filter(function (r) { return r.getAttribute('data-news') === '1'; })[0]; nr.classList.remove('out'); nr.removeAttribute('aria-hidden'); select(nr); images(false); say(T('story.newsletter')); }
      if ((id === 'triage' || id === 'snooze') && leaving === 'images') { select(alive()[0] || rows[0]); }
      if (id === 'snooze' && !alive().length) refill();
      hideToast();
      var info = titles[id]; cap.n.textContent = info[0]; cap.t.textContent = info[1];
      dots.forEach(function (d) { if (d.getAttribute('data-go') === id) d.setAttribute('aria-current', 'step'); else d.removeAttribute('aria-current'); });
      steps.forEach(function (s) { s.classList.toggle('on', s.getAttribute('data-scene') === id); });
    }
    function go(id, focusPal) {
      var s = $('#step-' + id), mobile = innerWidth <= 900;
      var y = s.getBoundingClientRect().top + pageYOffset - (mobile ? (64 + stageCol.offsetHeight - 6) : Math.max(0, (innerHeight - s.offsetHeight) / 2));
      window.scrollTo({ top: Math.max(0, y), behavior: HL.motionOn() ? 'smooth' : 'auto' });
      setScene(id);
      if (focusPal) setTimeout(function () { inp.focus({ preventScroll: true }); }, HL.motionOn() ? 500 : 60);
    }
    dots.forEach(function (d) { d.addEventListener('click', function () { go(d.getAttribute('data-go')); }); });
    var tick = false;
    function update() {
      tick = false;
      var mobile = innerWidth <= 900, y = mobile ? stageCol.getBoundingClientRect().bottom + 30 : innerHeight * 0.5, cur = steps[0];
      steps.forEach(function (s) { if (s.getBoundingClientRect().top <= y) cur = s; });
      setScene(cur.getAttribute('data-scene'));
    }
    var onScroll = function () { if (!tick) { tick = true; requestAnimationFrame(update); } };
    addEventListener('scroll', onScroll, { passive: true }); addEventListener('resize', onScroll);
    select(rows[0]); update();
    if (!scene) setScene('triage');
  })();

  /* =============================== the customiser =============================== */
  var form = $('#mk-form');
  if (form) (function () {
    var capp = $('.mk-view .app'), cust = $('#mk-color');
    var DEF = { theme: 'system', accent: '#0f6cbd', density: 'full', pane: 'right', fs: '14' };
    var S = {}, oldestOn = false;
    function read() {
      var d = new FormData(form);
      S.theme = d.get('theme'); S.density = d.get('density'); S.pane = d.get('pane'); S.fs = d.get('fs');
      S.accent = d.get('accent') === 'custom' ? cust.value : d.get('accent');
      S.preview = form.elements.preview.checked; S.conv = form.elements.conv.checked; S.focused = form.elements.focused.checked; S.oldest = form.elements.oldest.checked; S.tint = form.elements.tint.checked;
    }
    function apply() {
      read();
      var res = S.theme === 'system' ? (mqDark.matches ? 'dark' : 'light') : S.theme;
      if (S.theme === 'system') capp.removeAttribute('data-theme'); else capp.setAttribute('data-theme', S.theme);
      var a = accentSet(S.accent, res, res === 'dark' ? '#1b1c20' : '#ffffff');
      capp.style.setProperty('--ac', S.accent); capp.style.setProperty('--a-acc-t', a.text); capp.style.setProperty('--a-acc-fg', a.fg);
      /* light: the primary as the bar itself. dark: the primary as a dark tint, like the app (style.css builds the gradient from the two ends; forced-colors / prefers-contrast: more keep it neutral there) */
      if (res === 'dark') { var dk = darkTopBar(S.accent); capp.style.removeProperty('--a-top'); capp.style.setProperty('--a-top-dk-s', dk.start); capp.style.setProperty('--a-top-dk-e', dk.end); capp.style.setProperty('--a-top-fg', '#ffffff'); }
      else { var tp = topSet(S.accent); capp.style.removeProperty('--a-top-dk-s'); capp.style.removeProperty('--a-top-dk-e'); capp.style.setProperty('--a-top', tp.grad); capp.style.setProperty('--a-top-fg', tp.fg); }
      capp.setAttribute('data-density', S.density); capp.setAttribute('data-pane', S.pane);
      capp.setAttribute('data-preview', S.preview ? 'on' : 'off'); capp.setAttribute('data-conv', S.conv ? 'on' : 'off');
      capp.setAttribute('data-focused', S.focused ? 'on' : 'off'); capp.setAttribute('data-oldest', S.oldest ? 'on' : 'off');
      if (S.oldest !== oldestOn) { oldestOn = S.oldest; var rb = $('.a-rows', capp); [].slice.call(rb.children).reverse().forEach(function (r) { rb.appendChild(r); }); rb.scrollTop = 0; } /* the list really starts with the oldest mail: it is a scroller, so the order is the DOM's, not a reversed flex */
      capp.style.setProperty('--fs', S.fs + 'px');
      tint();
    }
    var TINT = ['--accent-base', '--accent', '--accent-fg', '--accent-text', '--night', '--stamp', '--solid', '--on-solid', '--cta-bg', '--cta-fg'];
    function tint() {
      if (!S.tint) { TINT.forEach(function (p) { root.style.removeProperty(p); }); return; }
      var t = HL.resolvedTheme(), a = accentSet(S.accent, t, t === 'dark' ? '#121316' : '#f3f4f7');
      root.style.setProperty('--accent-base', S.accent); root.style.setProperty('--accent', a.acc); root.style.setProperty('--accent-fg', a.fg); root.style.setProperty('--accent-text', a.text);
      var paper = t === 'dark' ? '#2c2a25' : '#fffcf1', st = S.accent, n = 0; while (contrast(st, paper) < 4.8 && n++ < 60) st = mix(st, t === 'dark' ? '#ffffff' : '#000000', 0.06);
      var sol = t === 'dark' ? S.accent : a.acc, onsol = a.fg; n = 0;
      if (t === 'dark') { onsol = '#ffffff'; while (contrast(sol, '#ffffff') < 4.6 && n++ < 60) sol = mix(sol, '#000000', 0.06); }
      root.style.setProperty('--solid', sol); root.style.setProperty('--on-solid', onsol);
      if (t === 'dark') { root.style.setProperty('--cta-bg', mix(S.accent, '#05070a', 0.84)); root.style.setProperty('--cta-fg', '#f4f8fc'); } else { root.style.setProperty('--cta-bg', a.acc); root.style.setProperty('--cta-fg', a.fg); }
      root.style.setProperty('--stamp', st);
      root.style.setProperty('--night', t === 'dark' ? mix(S.accent, '#05070a', 0.84) : mix(S.accent, '#000000', 0.82));
    }
    form.addEventListener('change', apply);
    cust.addEventListener('input', function () { form.elements.accent.value = 'custom'; apply(); });
    $('#mk-reset-c').addEventListener('click', function () { cust.value = DEF.accent; form.elements.accent.value = DEF.accent; apply(); });
    $('#mk-reset').addEventListener('click', function () {
      form.reset(); cust.value = DEF.accent; apply();
    });
    HL.onTheme(apply);
    apply();
  })();
})();

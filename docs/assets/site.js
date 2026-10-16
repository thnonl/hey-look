/* Hey Look! site v2: theme, motion switch, nav, reveals, hero, tag wall, video slot, download logic, support page.
   No libraries, no analytics, no cookies. localStorage only for the theme and the animation choice (auto | on | off), always in try/catch. */
(function () {
  'use strict';

  var KOFI_USER = 'namthnonl';
  var KOFI_WIDGET = 'https://ko-fi.com/namthnonl/?hidefeed=true&widget=true&embed=true&preview=true'; /* the owner's embed, loaded only after a click */
  var KOFI_SCRIPT = 'https://storage.ko-fi.com/cdn/scripts/overlay-widget.js'; /* Ko-fi's documented widget for other sites, also only after the click */

  var root = document.documentElement;
  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
  var store = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  };
  /* ---------- strings: per-language dictionaries in assets/i18n/<code>.js (loaded before this file); English is the fallback ---------- */
  var LANG = (root.getAttribute('lang') || 'en').split('-')[0];
  var DICT = window.HL_I18N || {};
  function str(key) {
    var d = DICT[LANG];
    if (d && d[key] != null) return d[key];
    d = DICT.en;
    return d && d[key] != null ? d[key] : key;
  }
  function fmt(s, v) { return s.replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] != null ? v[k] : m; }); }
  function t(key, v) { return fmt(str(key), v); }
  /* plural: key.<category from Intl.PluralRules of the page language>, else key.other */
  function tn(key, n, v) {
    var cat = 'other';
    try { cat = new Intl.PluralRules(str('locale')).select(n); } catch (e) { cat = n === 1 ? 'one' : 'other'; }
    var d = DICT[LANG], has = function (k) { return (d && d[k] != null) || (DICT.en && DICT.en[k] != null); };
    var o = { n: n }; if (v) for (var k in v) o[k] = v[k];
    return t(has(key + '.' + cat) ? key + '.' + cat : key + '.other', o);
  }
  function escHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  /* like t(), but returns safe HTML: values are escaped, **text** becomes <b>text</b> */
  function rich(key, v) {
    var e = {}; if (v) for (var k in v) e[k] = escHtml(v[k]);
    return fmt(escHtml(str(key)), e).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  }
  var mqReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: false };
  var listeners = { theme: [], motion: [] };

  /* ---------- theme: auto (system) -> light -> dark ---------- */
  var order = ['auto', 'light', 'dark'];
  var names = function (p) { return t('theme.' + p); };
  function resolvedTheme() {
    var t = root.getAttribute('data-theme');
    return t === 'light' || t === 'dark' ? t : (mqDark.matches ? 'dark' : 'light');
  }
  function applyTheme(pref) {
    if (pref === 'light' || pref === 'dark') root.setAttribute('data-theme', pref); else root.removeAttribute('data-theme');
    root.setAttribute('data-pref', pref);
    var b = $('#theme-btn');
    if (b) b.setAttribute('aria-label', t('theme.label.' + pref)); /* one whole sentence per state (state and next theme agree in every language) */
    listeners.theme.forEach(function (f) { f(resolvedTheme()); });
  }
  var pref = root.getAttribute('data-pref') || 'auto';
  if (order.indexOf(pref) < 0) pref = 'auto';
  applyTheme(pref);
  var tb = $('#theme-btn');
  if (tb) tb.addEventListener('click', function () {
    pref = order[(order.indexOf(pref) + 1) % 3];
    if (!/[?&]theme=/.test(location.search)) store.set('hl2-theme', pref === 'auto' ? '' : pref);
    applyTheme(pref);
    var live = $('#theme-live'); if (live) live.textContent = t('theme.live', { state: names(pref) });
  });
  if (mqDark.addEventListener) mqDark.addEventListener('change', function () { if (pref === 'auto') applyTheme(pref); });

  /* ---------- motion: three states, auto (follow the system), on, off; the header switch decides ----------
     With the system asking for reduced motion, "auto" is off, and the switch can still turn animations ON (html.motion-on lifts the
     reduced-motion rules in style.css). ?motion=on|off|auto is for one visit and is not stored. */
  var mpref = root.classList.contains('calm') ? 'off' : root.classList.contains('motion-on') ? 'on' : 'auto';
  var mnames = function (p) { return t('motion.' + p); };
  function motionOn() { return mpref === 'on' ? true : mpref === 'off' ? false : !mqReduce.matches; }
  function motionOrder() { return mqReduce.matches ? ['auto', 'on', 'off'] : ['auto', 'off', 'on']; }
  function applyMotion() {
    var on = motionOn();
    root.classList.toggle('calm', mpref === 'off');
    root.classList.toggle('motion-on', mpref === 'on');
    root.classList.toggle('motion', on);
    var b = $('#motion-btn');
    if (b) {
      var o = motionOrder(), next = o[(o.indexOf(mpref) + 1) % 3];
      var state = mpref === 'auto' ? t('motion.state.auto', { now: mnames(on ? 'on' : 'off') }) : mnames(mpref);
      b.setAttribute('aria-pressed', on ? 'false' : 'true'); /* pressed = animations are off */
      b.setAttribute('aria-label', t('motion.label.' + mpref + '.' + next)); /* one whole sentence per state and next state */
      b.setAttribute('title', t('motion.status', { state: state }));
      var l = $('.m-lbl', b);
      if (!l) { l = document.createElement('span'); l.className = 'm-lbl'; b.appendChild(l); }
      l.textContent = t('motion.status', { state: mnames(mpref) });
    }
    listeners.motion.forEach(function (f) { f(on); });
  }
  var mb = $('#motion-btn');
  if (mb) mb.addEventListener('click', function () {
    var o = motionOrder();
    mpref = o[(o.indexOf(mpref) + 1) % 3];
    if (!/[?&]motion=|[?&]calm=/.test(location.search)) { store.set('hl2-motion', mpref === 'auto' ? '' : mpref); store.set('hl2-calm', ''); }
    applyMotion();
    var live = $('#theme-live'); if (live) live.textContent = mpref === 'auto' ? t(motionOn() ? 'motion.live.auto.on' : 'motion.live.auto.off') : t('motion.live.' + mpref);
  });
  if (mqReduce.addEventListener) mqReduce.addEventListener('change', applyMotion);
  applyMotion();

  window.HL = {
    motionOn: motionOn, resolvedTheme: resolvedTheme, lang: LANG, t: t, tn: tn, rich: rich, locale: function () { return str('locale'); },
    onTheme: function (f) { listeners.theme.push(f); }, onMotion: function (f) { listeners.motion.push(f); }
  };

  /* ---------- mobile nav ---------- */
  var nt = $('.nav-toggle'), nav = $('#site-nav');
  if (nt && nav) {
    nt.addEventListener('click', function () {
      var open = nav.classList.toggle('open'); nt.setAttribute('aria-expanded', open ? 'true' : 'false');
      var lgm = $('details.lang'); if (open && lgm) lgm.open = false;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('open')) { nav.classList.remove('open'); nt.setAttribute('aria-expanded', 'false'); nt.focus(); }
    });
    nav.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('a')) { nav.classList.remove('open'); nt.setAttribute('aria-expanded', 'false'); } });
  }

  /* ---------- header safety net: above the phone layout the CSS decides when the inline nav gives way to the menu button (measured per language
     with the Windows fonts). If the nav would still touch the buttons - a wider font on macOS or Linux, a classic scrollbar - the menu button takes over here. ---------- */
  var hdr = $('.hdr'), hdrR = $('.hdr-r');
  if (hdr && hdrR && nav && nt) {
    var fitHeader = function () {
      hdr.classList.remove('nav-menu');
      var ncs = getComputedStyle(nav), last = nav.lastElementChild;
      if (ncs.display === 'none' || ncs.position === 'absolute' || !last) return;
      var rr = hdrR.getBoundingClientRect(), hin = hdrR.parentNode, pr = parseFloat(getComputedStyle(hin).paddingRight) || 0;
      if (rr.left - last.getBoundingClientRect().right < 14 || rr.right > hin.getBoundingClientRect().right - pr + 0.5) {
        hdr.classList.add('nav-menu'); nav.classList.remove('open'); nt.setAttribute('aria-expanded', 'false');
      }
    }, fitTimer = 0;
    fitHeader();
    window.addEventListener('resize', function () { if (!fitTimer) fitTimer = requestAnimationFrame(function () { fitTimer = 0; fitHeader(); }); });
    window.addEventListener('load', fitHeader);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitHeader);
  }

  /* ---------- reveal on scroll ---------- */
  if ('IntersectionObserver' in window) {
    var rio = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); rio.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    $$('.rv').forEach(function (el) { rio.observe(el); });
  } else {
    $$('.rv').forEach(function (el) { el.classList.add('in'); });
  }

  /* ---------- TOC highlight ---------- */
  var toc = $$('.toc a[href^="#"]');
  if (toc.length && 'IntersectionObserver' in window) {
    var map = {}; toc.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
    var tio = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting && map[e.target.id]) { toc.forEach(function (a) { a.classList.remove('on'); }); map[e.target.id].classList.add('on'); } });
    }, { rootMargin: '-15% 0px -75% 0px' });
    Object.keys(map).forEach(function (id) { var el = document.getElementById(id); if (el) tio.observe(el); });
  }

  /* ---------- hero: tag-word cycler and eyes ---------- */
  var swap = $('[data-swap]');
  if (swap) {
    var words = $$('.sw-w', swap), cur = 0, timer = null, visible = true;
    var padX = function () { var cs = getComputedStyle(swap); return parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight); };
    var fit = function (i) { swap.style.width = (words[i].getBoundingClientRect().width + padX()) + 'px'; };
    var step = function () {
      if (!motionOn() || !visible || document.hidden) return;
      var prev = cur; cur = (cur + 1) % words.length;
      words[prev].classList.remove('on'); words[prev].classList.add('out');
      words[cur].classList.add('on'); fit(cur);
      setTimeout(function () { words[prev].classList.remove('out'); }, 800);
    };
    var reset = function () {
      words.forEach(function (w, i) { w.classList.toggle('on', i === 0); w.classList.remove('out'); }); cur = 0;
      if (motionOn()) fit(0); else swap.style.removeProperty('width');
    };
    reset();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (motionOn()) fit(cur); });
    window.addEventListener('resize', function () { if (motionOn()) fit(cur); });
    timer = setInterval(step, 2700);
    if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { visible = es[0].isIntersecting; }).observe(swap);
    listeners.motion.push(reset);
  }
  var pupilsAll = $$('.pupils');
  if (pupilsAll.length && window.matchMedia('(pointer: fine)').matches) {
    document.addEventListener('pointermove', function (e) {
      if (!motionOn()) return;
      pupilsAll.forEach(function (g) {
        var svg = g.ownerSVGElement, r = svg.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) return;
        var dx = e.clientX - (r.left + r.width * .5), dy = e.clientY - (r.top + r.height * .4), d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 320) * 11;
        g.style.transform = 'translate(' + (dx / d * k).toFixed(1) + 'px,' + (dy / d * k).toFixed(1) + 'px)';
      });
    }, { passive: true });
    listeners.motion.push(function (on) { if (!on) pupilsAll.forEach(function (g) { g.style.transform = ''; }); });
  }

  /* ---------- film: plays muted when it scrolls into view, never with reduced motion or "animations off" ---------- */
  $$('[data-video-slot]').forEach(function (slot) {
    var v = $('video', slot), miss = $('.vmiss', slot), srcs = $$('source', v);
    var fail = function () { miss.hidden = false; };
    if (srcs.length) srcs[srcs.length - 1].addEventListener('error', fail);
    v.addEventListener('error', fail);
    v.addEventListener('loadedmetadata', function () { miss.hidden = true; });
    var auto = false, byUser = false, inView = false;
    v.addEventListener('pause', function () { if (!auto) byUser = true; auto = false; });
    v.addEventListener('play', function () { if (!auto) byUser = false; auto = false; });
    if ('IntersectionObserver' in window) new IntersectionObserver(function (es) {
      inView = es[0].isIntersecting;
      if (es[0].isIntersecting) {
        if (!motionOn() || byUser || !v.paused) return;
        auto = true; var p = v.play(); if (p && p.catch) p.catch(function () { auto = false; });
      } else if (!v.paused) { auto = true; v.pause(); }
    }, { threshold: 0.5 }).observe(v);
    listeners.motion.push(function (on) {
      if (!on && !v.paused) { auto = true; v.pause(); }
      else if (on && inView && !byUser && v.paused) { auto = true; var p = v.play(); if (p && p.catch) p.catch(function () { auto = false; }); }
    });
  });

  /* ---------- help page: filter the questions, open the one a link points to ---------- */
  var hqTools = $('#hq-tools');
  if (hqTools) {
    var hqs = $$('details.hq'), groups = $$('.hq-group'), inp = $('#hq-filter'), cnt = $('#hq-count'), none = $('#hq-none');
    var text = hqs.map(function (d) { return d.textContent.toLowerCase(); }), wasOpen = hqs.map(function (d) { return d.open; });
    hqTools.hidden = false;
    var run = function () {
      var q = inp.value.trim().toLowerCase(), toks = q.split(/\s+/).filter(Boolean), shown = 0;
      hqs.forEach(function (d, i) {
        var ok = toks.every(function (t) { return text[i].indexOf(t) >= 0; });
        d.hidden = !ok; if (ok) shown++;
        d.open = q ? ok && shown <= 6 : wasOpen[i];
      });
      groups.forEach(function (g) { g.hidden = !$$('details.hq', g).some(function (d) { return !d.hidden; }); });
      none.hidden = shown > 0;
      cnt.textContent = q ? tn('help.match', shown) : '';
    };
    inp.addEventListener('input', run);
    var openHash = function () { var id = location.hash.slice(1), el = id && document.getElementById(id); if (el && el.tagName === 'DETAILS') { el.open = true; el.scrollIntoView(); } };
    window.addEventListener('hashchange', openHash); openHash();
  }

  /* ---------- language menu: a <details> of plain links (works without JavaScript); this adds Escape, a click outside, and keeps the #anchor ---------- */
  var lg = $('details.lang'), onNotFound = !!$('.nf');
  if (lg) {
    var lgSum = $('summary', lg), lgLinks = $$('.lang-menu a', lg), lgBase = lgLinks.map(function (a) { return a.getAttribute('href'); });
    lg.addEventListener('toggle', function () { if (lg.open && nav) { nav.classList.remove('open'); if (nt) nt.setAttribute('aria-expanded', 'false'); } });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && lg.open) { lg.open = false; lgSum.focus(); } });
    document.addEventListener('click', function (e) { if (lg.open && !lg.contains(e.target)) lg.open = false; });
    var keepHash = function () { if (!onNotFound) lgLinks.forEach(function (a, i) { a.setAttribute('href', lgBase[i] + location.hash); }); };
    window.addEventListener('hashchange', keepHash); keepHash();
  }

  /* ---------- 404: GitHub Pages serves one 404.html for every language directory, so the page reads the language from the address
     (<base>/<dir>/...), loads that dictionary, translates every text of the page (data-i18n: text, data-i18n-aria: aria-label; header, nav and footer too) and points its links into that language. Eyes follow the pointer: shared pupils code above. ---------- */
  if (onNotFound && lg) {
    var basePath = new URL(document.baseURI).pathname, here = location.pathname;
    var seg = here.indexOf(basePath) === 0 ? here.slice(basePath.length).split('/')[0] : '';
    var cur = seg && $$('.lang-menu a', lg).filter(function (a) { return a.getAttribute('data-dir') === seg; })[0];
    if (cur) {
      var sc404 = document.createElement('script');
      sc404.src = 'assets/i18n/' + seg + '.js';
      sc404.onload = function () {
        var hl = cur.getAttribute('hreflang');
        root.setAttribute('lang', hl); LANG = hl.split('-')[0];
        $$('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
        $$('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
        document.title = t('nf.title');
        $$('a[href]').forEach(function (a) {
          var h = a.getAttribute('href');
          if (!a.closest('.lang-menu') && /^[a-z-]+\.html(#|$)/.test(h)) a.setAttribute('href', seg + '/' + h);
        });
        $$('.lang-menu a', lg).forEach(function (a) { if (a === cur) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
        var lc = $('.lang-cur', lg); if (lc) lc.textContent = cur.getAttribute('data-short');
        var lsum = $('summary', lg), lmenu = $('.lang-menu', lg); /* the menu block is generated (English labels): its labels come from the dictionary here */
        if (lsum) { lsum.setAttribute('aria-label', t('nf.lang.cur', { lang: cur.textContent })); lsum.setAttribute('title', t('nf.lang')); }
        if (lmenu) lmenu.setAttribute('aria-label', t('nf.lang'));
        applyTheme(pref); applyMotion();
      };
      document.head.appendChild(sc404);
    }
  }

  /* ---------- support page ---------- */
  var kl = $('#kofi-load'), kb = $('#kofi-box');
  if (kl && kb) {
    kl.hidden = false;
    var knote = $('#kofi-note');
    kl.addEventListener('click', function () {
      if (kb.firstChild) return;
      var loaded = false, warn = function () { if (knote) knote.classList.add('warn'); };
      /* 1. the owner's panel (a frame of ko-fi.com). No sandbox attribute: Ko-fi's own checks need to run normally in the frame. */
      var f = document.createElement('iframe');
      f.id = 'kofiframe'; f.src = KOFI_WIDGET; f.height = '712'; f.title = 'namthnonl';
      f.addEventListener('load', function () { loaded = true; });
      f.style.border = 'none'; f.style.width = '100%'; f.style.padding = '4px'; f.style.background = '#f9f9f9';
      kb.appendChild(f); kb.hidden = false; kl.hidden = true;
      /* 2. Ko-fi's documented floating button for other sites (script from storage.ko-fi.com; no extra fonts requested) */
      var sc = document.createElement('script');
      sc.src = KOFI_SCRIPT; sc.async = true;
      sc.onload = function () {
        try {
          window.kofiWidgetOverlay.draw(KOFI_USER, {
            'type': 'floating-chat', 'floating-chat.donateButton.text': t('kofi.button'),
            'floating-chat.donateButton.background-color': '#0f6cbd', 'floating-chat.donateButton.text-color': '#fff',
            'floating-chat.stylesheets': '[]'
          });
        } catch (e) { warn(); }
      };
      sc.onerror = warn;
      document.head.appendChild(sc);
      /* the button above always works; if the frame has not reported in after 6 s the note says so */
      setTimeout(function () { if (!loaded) warn(); }, 6000);
    });
  }
  /* ---------- download logic: the latest release from GitHub, the Releases page when that is not possible ---------- */
  var dl = $('#downloads');
  if (dl) {
    var REPO = 'thnonl/hey-look';
    var RELEASES = 'https://github.com/' + REPO + '/releases';
    var PATTERNS = {
      'win-exe': /_windows_x64-setup\.exe$/i, 'win-msi': /_windows_x64\.msi$/i, 'mac-dmg': /_darwin_universal\.dmg$/i,
      'lin-appimage': /_linux_amd64\.AppImage$/i, 'lin-deb': /_linux_amd64\.deb$/i, 'lin-rpm': /_linux_x86_64\.rpm$/i
    };
    var status = $('#dl-status');
    /* nodes: strings become text, elements are appended as they are (no HTML is parsed) */
    var setStatus = function (state, nodes) {
      status.setAttribute('data-state', state);
      var box = $('.msg', status); while (box.firstChild) box.removeChild(box.firstChild);
      [].concat(nodes).forEach(function (n) { box.appendChild(typeof n === 'string' ? document.createTextNode(n) : n); });
    };
    var mk = function (tag, text, attrs) {
      var e = document.createElement(tag); e.textContent = text;
      if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    };
    var fmtSize = function (n) { return n ? (n / 1048576).toFixed(1) + ' MB' : ''; };
    var fill = function (rel, noRelease) {
      var ver = rel ? rel.tag_name.replace(/^v/, '') : '1.0.6';
      $$('[data-version]').forEach(function (e) { e.textContent = ver; });
      $$('[data-asset]').forEach(function (box) {
        var key = box.getAttribute('data-asset'), a = null, btn = $('a.btn', box), fn = $('.fn', box), sz = $('.sz', box);
        if (rel) rel.assets.forEach(function (x) { if (PATTERNS[key].test(x.name)) a = x; });
        if (a) {
          btn.href = a.browser_download_url; btn.removeAttribute('aria-disabled'); btn.querySelector('.t').textContent = btn.getAttribute('data-label');
          fn.textContent = a.name; sz.textContent = fmtSize(a.size);
        } else {
          if (rel) { btn.removeAttribute('href'); btn.setAttribute('aria-disabled', 'true'); btn.querySelector('.t').textContent = t('dl.not_in_release'); }
          else { btn.href = RELEASES + (noRelease ? '' : '/latest'); btn.removeAttribute('aria-disabled'); btn.querySelector('.t').textContent = t('dl.open_releases'); }
          fn.textContent = box.getAttribute('data-pattern').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); sz.textContent = '';
        }
      });
    };
    var show = function (rel, err) {
      fill(rel, !rel && !err);
      if (rel) {
        var d = new Date(rel.published_at), when = isNaN(d) ? '' : ' (' + d.toISOString().slice(0, 10) + ')';
        setStatus('ok', [mk('strong', t('dl.latest', { tag: rel.tag_name })), when + ' ', mk('a', t('dl.notes'), { href: rel.html_url })]);
      } else if (err) {
        setStatus('error', mk('strong', t('dl.error')));
      } else {
        setStatus('none', [mk('strong', t('dl.none.head')), ' ' + t('dl.none.tail')]);
      }
      var fb = $('#dl-fallback'); if (fb) { fb.hidden = !!rel && !err; fb.href = rel ? rel.html_url : (err ? RELEASES + '/latest' : RELEASES); }
    };
    var load = function () {
      setStatus('', t('dl.loading'));
      fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
        .then(function (r) { if (r.status === 404) return null; if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (j) { show(j && j.assets ? j : null); })
        .catch(function () { show(null, true); });
    };
    /* recommend the card for the visitor's system (computed locally, nothing is sent) */
    var ua = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
    var os = /win/i.test(ua) ? 'windows' : /mac|iphone|ipad/i.test(ua) ? 'macos' : /linux|x11|cros/i.test(ua) && !/android/i.test(navigator.userAgent) ? 'linux' : '';
    var rec = os && document.getElementById('card-' + os);
    if (rec) rec.classList.add('rec');
    var label = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
    $$('[data-os-cta] .t').forEach(function (el) { el.textContent = os ? t('dl.for_os', { os: label[os] }) : t('dl.generic'); });
    $$('.copy button').forEach(function (b) {
      b.addEventListener('click', function () {
        var txt = b.parentNode.querySelector('code').textContent;
        var done = function () { b.textContent = t('dl.copied'); setTimeout(function () { b.textContent = t('dl.copy'); }, 1600); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { });
      });
    });
    load();
  }

  /* a new page starts at the top (anchors and the back button keep working; scroll restoration is left on) */
  document.addEventListener('DOMContentLoaded', function () {
    var nav = window.performance && performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (location.hash || (nav && nav.type === 'back_forward')) return;
    window.scrollTo(0, 0);
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  });
})();

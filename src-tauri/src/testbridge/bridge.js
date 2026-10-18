/* Page side of the test bridge (debug builds with the bridge switched on only). Installed as an initialization script of every window and
   put in front of every request again (idempotent), so a window that was reloaded or never ran it still works.
   Nothing here talks to the app: results are kept in the page and read back by the bridge through the web view's own script call.
   The page's content security policy forbids evaluating text, so nothing here does: the bridge pastes the script text instead. */
(function () {
  'use strict';
  if (window.__hlb) return;
  var CAP = 1000000;
  var H = (window.__hlb = { results: {}, logs: [], seq: 0 });

  // ---- console ring buffer (last 500 entries) --------------------------------------------------------------------------------------------
  function fmt(a) {
    try {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return (a.stack || a.name + ': ' + a.message);
      var s = ser(a);
      return s.length > 4000 ? s.slice(0, 4000) + '...[cut]' : s;
    } catch (e) { return '[unprintable]'; }
  }
  function push(level, parts) {
    var text = '';
    try { text = parts.map(fmt).join(' '); } catch (e) { text = '[unprintable]'; }
    if (text.length > 8000) text = text.slice(0, 8000) + '...[cut]';
    H.logs.push({ n: ++H.seq, t: Date.now(), level: level, text: text });
    if (H.logs.length > 500) H.logs.shift();
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (m) {
    var orig = console[m];
    console[m] = function () {
      try { push(m, Array.prototype.slice.call(arguments)); } catch (e) { /* never break the page */ }
      return orig.apply(console, arguments);
    };
  });
  window.addEventListener('error', function (ev) {
    try { push('error', ['Uncaught ' + (ev.message || (ev.error && ev.error.message) || 'error') + ' at ' + (ev.filename || '') + ':' + (ev.lineno || 0) + ':' + (ev.colno || 0)]); } catch (e) { /* ignore */ }
  }, true);
  window.addEventListener('unhandledrejection', function (ev) {
    try { var r = ev.reason; push('error', ['Unhandled rejection: ' + (r && r.stack ? r.stack : r instanceof Error ? r.message : typeof r === 'string' ? r : ser(r))]); } catch (e) { /* ignore */ }
  });
  H.console = function (since) {
    since = +since || 0;
    return { last: H.seq, entries: H.logs.filter(function (e) { return e.n > since; }) };
  };

  // ---- safe JSON ------------------------------------------------------------------------------------------------------------------------
  function describe(el) {
    if (!el) return null;
    var cls = el.className;
    if (cls && typeof cls === 'object' && 'baseVal' in cls) cls = cls.baseVal;
    return { tag: (el.tagName || el.nodeName || '').toLowerCase(), id: el.id || '', class: typeof cls === 'string' ? cls : '', text: ((el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim().slice(0, 80) };
  }
  H.describe = describe;
  function nodeLabel(n) {
    if (n.nodeType === 1) { var d = describe(n); return '[' + d.tag + (d.id ? '#' + d.id : '') + (d.class ? '.' + d.class.trim().split(/\s+/).join('.') : '') + ']'; }
    return '[' + n.nodeName + ']';
  }
  function ser(v) {
    var stack = [];
    function conv(x, depth) {
      if (x === null || x === undefined) return null;
      var t = typeof x;
      if (t === 'string') return x;
      if (t === 'number') return isFinite(x) ? x : String(x);
      if (t === 'boolean') return x;
      if (t === 'bigint') return String(x) + 'n';
      if (t === 'symbol') return String(x);
      if (t === 'function') return '[Function ' + (x.name || 'anonymous') + ']';
      if (typeof Node !== 'undefined' && x instanceof Node) return nodeLabel(x);
      if (x === window) return '[Window]';
      if (x === document) return '[Document]';
      if (typeof Event !== 'undefined' && x instanceof Event) return '[' + x.constructor.name + ' ' + x.type + ']';
      if (x instanceof Error) return { name: x.name, message: x.message, stack: x.stack || '' };
      if (x instanceof Date) return isNaN(x.getTime()) ? 'Invalid Date' : x.toISOString();
      if (x instanceof RegExp) return String(x);
      if (typeof Promise !== 'undefined' && x instanceof Promise) return '[Promise]';
      if (stack.indexOf(x) >= 0) return '[Circular]';
      if (depth > 8) return '[depth > 8]';
      stack.push(x);
      try {
        if (typeof Map !== 'undefined' && x instanceof Map) { var m = []; x.forEach(function (v, k) { if (m.length < 1000) m.push([conv(k, depth + 1), conv(v, depth + 1)]); }); return { '[Map]': m }; }
        if (typeof Set !== 'undefined' && x instanceof Set) { var s = []; x.forEach(function (v) { if (s.length < 1000) s.push(conv(v, depth + 1)); }); return { '[Set]': s }; }
        if (Array.isArray(x) || (typeof NodeList !== 'undefined' && x instanceof NodeList) || (typeof HTMLCollection !== 'undefined' && x instanceof HTMLCollection) || ArrayBuffer.isView(x)) {
          var a = [], len = Math.min(x.length, 5000);
          for (var i = 0; i < len; i++) a.push(conv(x[i], depth + 1));
          if (x.length > len) a.push('[+' + (x.length - len) + ' more]');
          return a;
        }
        if (typeof x.toJSON === 'function') { try { return conv(x.toJSON(), depth + 1); } catch (e) { /* fall through to the keys */ } }
        var o = {}, keys = Object.keys(x), n = Math.min(keys.length, 1000);
        for (var j = 0; j < n; j++) { try { o[keys[j]] = conv(x[keys[j]], depth + 1); } catch (e) { o[keys[j]] = '[unreadable]'; } }
        if (keys.length > n) o['[more]'] = keys.length - n;
        return o;
      } finally { stack.pop(); }
    }
    var out = JSON.stringify(conv(v, 0));
    return out === undefined ? 'null' : out;
  }
  H.ser = ser;

  // ---- request bookkeeping ----------------------------------------------------------------------------------------------------------------
  // begin(id) -> finish(id, ok, value) -> take(id): the bridge polls take() until the answer is there
  H.begin = function (id) { H.results[id] = null; };
  H.finish = function (id, ok, v) {
    var out;
    try {
      if (ok) {
        var j = ser(v);
        out = j.length > CAP ? '{"done":true,"ok":false,"error":"the result is larger than 1 MB (' + j.length + ' characters)"}' : '{"done":true,"ok":true,"value":' + j + '}';
      } else {
        out = JSON.stringify({ done: true, ok: false, error: v instanceof Error ? (v.name + ': ' + v.message) : (typeof v === 'string' ? v : ser(v)) });
      }
    } catch (e) { out = JSON.stringify({ done: true, ok: false, error: 'could not serialise the result: ' + e }); }
    H.results[id] = out;
  };
  H.take = function (id) {
    var r = H.results[id];
    if (r === null || r === undefined) return '{"done":false}';
    delete H.results[id];
    return r;
  };

  // ---- input ----------------------------------------------------------------------------------------------------------------------------
  var FOCUSABLE = 'input,textarea,select,button,a[href],summary,[tabindex],[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';
  function isVisible(el) { var r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0; }
  function mouseInit(x, y, btn, detail) {
    return { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0), button: btn, buttons: btn === 0 ? 1 : btn === 2 ? 2 : 4, detail: detail, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  }
  function fire(target, type, init) {
    var ev;
    if (type.indexOf('pointer') === 0 && typeof PointerEvent !== 'undefined') ev = new PointerEvent(type, init);
    else ev = new MouseEvent(type, init);
    target.dispatchEvent(ev);
    return ev;
  }
  function pointOf(o) {
    var el = null, x, y;
    if (o.selector) {
      var all = document.querySelectorAll(o.selector);
      var idx = o.index || 0;
      el = all[idx] || null;
      if (!el) throw new Error('no element matches ' + o.selector + (idx ? ' at index ' + idx : ''));
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      if (!isVisible(el)) throw new Error('the element ' + o.selector + ' has no size (hidden?)');
      var r = el.getBoundingClientRect();
      x = r.left + r.width / 2; y = r.top + r.height / 2;
    } else if (typeof o.x === 'number' && typeof o.y === 'number') {
      x = o.x; y = o.y;
    } else {
      throw new Error('click needs selector, or x and y');
    }
    return { el: el, x: x, y: y };
  }
  function placeCaret(hit, x, y) {
    var ed = hit.closest ? hit.closest('[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]') : null;
    if (!ed) return;
    var range = null;
    try {
      if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
      else if (document.caretPositionFromPoint) {
        var cp = document.caretPositionFromPoint(x, y);
        if (cp) { range = document.createRange(); range.setStart(cp.offsetNode, cp.offset); range.collapse(true); }
      }
    } catch (e) { range = null; }
    if (range && ed.contains(range.startContainer)) {
      var sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
    }
  }
  H.click = function (o) {
    var p = pointOf(o);
    var hit = document.elementFromPoint(p.x, p.y);
    if (!hit) throw new Error('nothing at ' + Math.round(p.x) + ',' + Math.round(p.y) + ' (outside the window?)');
    var btn = o.button === 'right' ? 2 : o.button === 'middle' ? 1 : 0;
    var seqOnce = function (detail) {
      var init = mouseInit(p.x, p.y, btn, detail);
      fire(hit, 'pointerdown', init);
      var down = fire(hit, 'mousedown', init);
      if (!down.defaultPrevented) {
        // a real press moves the focus to the nearest control that can have it (or takes it from the one that has it)
        var f = hit.closest ? hit.closest(FOCUSABLE) : null;
        if (f && f.focus) f.focus(); else if (document.activeElement && document.activeElement !== document.body && !hit.contains(document.activeElement)) document.activeElement.blur();
        // ... and in text that can be edited it puts the caret where the press was
        if (btn === 0 && detail === 1) placeCaret(hit, p.x, p.y);
      }
      init.buttons = 0;
      fire(hit, 'pointerup', init);
      fire(hit, 'mouseup', init);
      if (btn === 0) fire(hit, 'click', init);
      else if (btn === 2) fire(hit, 'contextmenu', init);
      else fire(hit, 'auxclick', init);
    };
    seqOnce(1);
    if (o.double) { seqOnce(2); fire(hit, 'dblclick', mouseInit(p.x, p.y, btn, 2)); }
    var res = { target: describe(hit), x: Math.round(p.x), y: Math.round(p.y) };
    if (p.el) res.overlay = !(p.el === hit || p.el.contains(hit));
    return res;
  };

  var NATIVE_VALUE = {};
  function nativeSetter(el) {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var key = proto === HTMLTextAreaElement.prototype ? 'ta' : proto === HTMLSelectElement.prototype ? 'sel' : 'in';
    if (!NATIVE_VALUE[key]) NATIVE_VALUE[key] = Object.getOwnPropertyDescriptor(proto, 'value').set;
    return NATIVE_VALUE[key];
  }
  function focusEl(el) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    el.focus();
  }
  H.type = function (o) {
    var text = String(o.text == null ? '' : o.text), el;
    if (o.selector) {
      el = document.querySelector(o.selector);
      if (!el) throw new Error('no element matches ' + o.selector);
      focusEl(el);
    } else {
      el = document.activeElement;
    }
    if (!el || el === document.body || el === document.documentElement) throw new Error('nothing has the focus (pass a selector)');
    var res = { target: describe(el) };
    if (el instanceof HTMLSelectElement) {
      var opt = Array.prototype.find.call(el.options, function (op) { return op.value === text || op.text === text; });
      if (!opt) throw new Error('the select has no option ' + JSON.stringify(text));
      nativeSetter(el).call(el, opt.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      res.via = 'select'; res.value = el.value;
      return res;
    }
    var isText = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/i.test(el.type));
    if (isText) {
      var v = el.value, s = v.length, e = v.length;
      try { if (el.selectionStart != null) { s = el.selectionStart; e = el.selectionEnd; } } catch (x) { /* email / number inputs have no selection */ }
      if (o.clear) { s = 0; e = v.length; }
      var nv = v.slice(0, s) + text + v.slice(e);
      try { el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text })); } catch (x) { /* ignore */ }
      nativeSetter(el).call(el, nv);
      try { el.setSelectionRange(s + text.length, s + text.length); } catch (x) { /* ignore */ }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      res.via = 'value'; res.value = el.value.length > 200 ? el.value.slice(0, 200) + '...' : el.value;
      return res;
    }
    if (el.isContentEditable) {
      var sel = window.getSelection();
      if (o.clear) { var all = document.createRange(); all.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(all); document.execCommand('delete'); }
      if (!sel.rangeCount || !el.contains(sel.anchorNode)) {
        var r = document.createRange(); r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
      }
      var lines = text.split(/\r\n|\r|\n/);
      for (var i = 0; i < lines.length; i++) {
        if (i > 0 && !document.execCommand('insertParagraph', false)) throw new Error('execCommand insertParagraph was refused');
        if (lines[i] && !document.execCommand('insertText', false, lines[i])) throw new Error('execCommand insertText was refused');
      }
      res.via = 'execCommand'; res.text = ((el.innerText || '') + '').slice(-200);
      return res;
    }
    throw new Error('the focused element (' + (describe(el).tag) + ') cannot take text');
  };

  var KEYS = {
    Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], ' ': [32, 'Space'], Space: [32, 'Space'],
    ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
    Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
  };
  function keyInfo(k) {
    if (KEYS[k]) return { key: k === 'Space' ? ' ' : k, keyCode: KEYS[k][0], code: KEYS[k][1] };
    if (/^F([1-9]|1[0-2])$/.test(k)) return { key: k, keyCode: 111 + (+k.slice(1)), code: k };
    if (k.length === 1) {
      var u = k.toUpperCase();
      if (u >= 'A' && u <= 'Z') return { key: k, keyCode: u.charCodeAt(0), code: 'Key' + u };
      if (u >= '0' && u <= '9') return { key: k, keyCode: u.charCodeAt(0), code: 'Digit' + u };
      return { key: k, keyCode: k.charCodeAt(0), code: '' };
    }
    return { key: k, keyCode: 0, code: k };
  }
  function tabbables() {
    return Array.prototype.filter.call(document.querySelectorAll(FOCUSABLE), function (e) { return !e.disabled && e.tabIndex >= 0 && isVisible(e); });
  }
  H.key = function (o) {
    var el = document.activeElement || document.body, info = keyInfo(String(o.key));
    var init = { key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode, ctrlKey: !!o.ctrl, shiftKey: !!o.shift, altKey: !!o.alt, metaKey: !!o.meta, bubbles: true, cancelable: true, composed: true, view: window };
    var down = el.dispatchEvent(new KeyboardEvent('keydown', init));
    var printable = info.key.length === 1 && !o.ctrl && !o.meta && !o.alt;
    var press = true;
    if (down && (printable || info.key === 'Enter')) press = el.dispatchEvent(new KeyboardEvent('keypress', init));
    var emulated = '';
    if (down && press) {
      var tag = (el.tagName || '').toLowerCase(), editable = el.isContentEditable;
      var isTextInput = el instanceof HTMLInputElement && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/i.test(el.type);
      if (info.key === 'Tab') {
        var list = tabbables(), at = list.indexOf(el);
        if (list.length) { var nx = list[(at + (o.shift ? -1 : 1) + list.length) % list.length]; nx.focus(); emulated = 'focus moved'; }
      } else if (info.key === 'Enter' && !o.ctrl && !o.meta && !o.alt) {
        if (tag === 'button' || tag === 'a' || tag === 'summary' || (tag === 'input' && /^(button|submit|reset|checkbox|radio)$/i.test(el.type))) { el.click(); emulated = 'click'; }
        else if (isTextInput && el.form) { if (el.form.requestSubmit) el.form.requestSubmit(); emulated = 'submit'; }
        else if (tag === 'textarea' || editable) { document.execCommand(o.shift ? 'insertLineBreak' : 'insertParagraph'); emulated = 'newline'; }
      } else if (info.key === ' ' && (tag === 'button' || (tag === 'input' && /^(button|submit|reset|checkbox|radio)$/i.test(el.type)))) {
        el.click(); emulated = 'click';
      } else if ((info.key === 'Backspace' || info.key === 'Delete') && (editable || tag === 'textarea' || isTextInput)) {
        document.execCommand(info.key === 'Backspace' ? 'delete' : 'forwardDelete'); emulated = 'delete';
      } else if (printable && (editable || tag === 'textarea' || isTextInput)) {
        // a typed character is what `type` does
        H.type({ text: info.key }); emulated = 'text';
      }
    }
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    return { target: describe(el), defaultPrevented: !(down && press), emulated: emulated };
  };
})();

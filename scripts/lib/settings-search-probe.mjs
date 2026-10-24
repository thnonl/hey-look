// Probes of Search in Settings (1.0.7 W8.12): what the box, the results and the lit setting look like in the engine that runs the page. DOM only (nothing is added to the page); every
// expression evaluates to a JSON string, so it runs through a CDP `Runtime.evaluate` and through the test bridge's `/eval` alike (scripts/test-bridge.md; WebKit rows in webkit-checks-107.md, section 44).
//
//   node scripts/lib/settings-search-probe.mjs                 prints the state probe (the box, the results, the placeholder fit); paste it into /eval or a console
//   node scripts/lib/settings-search-probe.mjs hit [id]        prints the probe of the lit setting (default: the one that has .set-hit, else #set-<id>)
//
// The state: { box: null | { value, focused, type, role, expanded, activedescendant, placeholder, placeholderPx (the text measured in the box's font at the placeholder's own size), placeholderFontSize ("12px"), roomPx (what the box has for it),
//   fits, fontFamily, fontSize, height, ring: { outlineStyle, boxShadow, borderColor } (the focus ring of the box), clearVisible, nativeCancel (a WebKit search-field cancel button: must be false) },
//   nav: { width, scrollTop, scrollWidth, sticky: position of .set-search, top (its top relative to the navigation) }, options: [{ label, place, lines (rendered lines of the label), clamped,
//   bold (the text of the <b> parts), placeEllipsis (the place line is cut with an ellipsis), width, scrollWidth, active }], none: text of the empty state or null, live: text of the status region }.
// The lit setting: { id, hit, outline: { style, width, color }, bar (box-shadow), background, animation (name, 'none' under reduced motion), centreOffsetPx (its middle against the middle of the
//   settings body), scrollTop, focus: { inside, tag, id } }.
const oneLine = (t) => t.split('\n').map((l) => l.trim()).join(' '); // (the bridge's /eval takes one line)

export const searchProbe = () => oneLine(`(() => {
  const b = document.querySelector('.settings-nav .set-search input');
  const nav = document.querySelector('.settings-nav');
  let box = null;
  if (b) {
    const cs = getComputedStyle(b), cv = document.createElement('canvas').getContext('2d');
    /* the placeholder has its own size, 12 px: the pseudo-element's computed style; older WebKit knows it as ::-webkit-input-placeholder */
    let pf = ''; for (const pe of ['::placeholder', '::-webkit-input-placeholder']) { try { pf = getComputedStyle(b, pe).fontSize; } catch (e) { pf = ''; } if (pf) break; }
    cv.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + (pf || cs.fontSize) + ' ' + cs.fontFamily;
    const room = b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), text = cv.measureText(b.placeholder).width;
    box = {
      value: b.value, focused: document.activeElement === b, type: b.type, role: b.getAttribute('role'), expanded: b.getAttribute('aria-expanded'), activedescendant: b.getAttribute('aria-activedescendant'),
      placeholder: b.placeholder, placeholderPx: Math.round(text * 10) / 10, roomPx: Math.round(room * 10) / 10, fits: text <= room + 0.5, fontFamily: cs.fontFamily, fontSize: cs.fontSize, placeholderFontSize: pf, height: b.getBoundingClientRect().height,
      ring: { outlineStyle: cs.outlineStyle, boxShadow: cs.boxShadow, borderColor: cs.borderColor },
      clearVisible: !!document.querySelector('.settings-nav .set-clear'),
      nativeCancel: b.type === 'search', /* (a type="search" field gets WebKit's own cancel button and Esc behaviour: the box is type="text") */
    };
  }
  const bar = document.querySelector('.settings-nav .set-search');
  const options = [...document.querySelectorAll('.set-opt')].slice(0, 60).map((o) => {
    const l = o.querySelector('.set-opt-label'), p = o.querySelector('.set-opt-place'), lh = parseFloat(getComputedStyle(l).lineHeight) || parseFloat(getComputedStyle(l).fontSize) * 1.3;
    return { label: l.textContent, place: p ? p.textContent : '', lines: Math.round(l.clientHeight / lh), clamped: l.scrollHeight > l.clientHeight + 1, bold: [...l.querySelectorAll('b')].map((x) => x.textContent), boldWeight: l.querySelector('b') ? getComputedStyle(l.querySelector('b')).fontWeight : null,
      placeEllipsis: !!p && p.scrollWidth > p.clientWidth + 1, width: o.clientWidth, scrollWidth: o.scrollWidth, active: o.getAttribute('aria-selected') === 'true' };
  });
  return JSON.stringify({
    box, nav: nav ? { width: nav.clientWidth, scrollTop: nav.scrollTop, scrollWidth: nav.scrollWidth, sticky: bar ? getComputedStyle(bar).position : null, top: bar ? Math.round((bar.getBoundingClientRect().top - nav.getBoundingClientRect().top) * 10) / 10 : null } : null,
    options, none: (document.querySelector('.set-none') || {}).textContent || null, live: (document.querySelector('.set-search [role=status]') || {}).textContent || null,
  });
})()`);

export const hitProbe = (id = '') => oneLine(`(() => {
  const el = ${JSON.stringify(id)} ? document.getElementById('set-' + ${JSON.stringify(id)}) : document.querySelector('.set-hit');
  const body = document.querySelector('.settings-body');
  if (!el || !body) return JSON.stringify(null);
  const cs = getComputedStyle(el), r = el.getBoundingClientRect(), b = body.getBoundingClientRect(), a = document.activeElement;
  return JSON.stringify({
    id: el.id, hit: el.classList.contains('set-hit'), outline: { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor }, bar: cs.boxShadow, background: cs.backgroundColor, animation: cs.animationName,
    centreOffsetPx: Math.round(r.top + r.height / 2 - (b.top + body.clientHeight / 2)), scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
    focus: { inside: el.contains(a), tag: a ? a.tagName : null, id: a ? a.id : null },
  });
})()`);

if (process.argv[1] && process.argv[1].endsWith('settings-search-probe.mjs')) {
  const [cmd, id] = process.argv.slice(2);
  console.log(cmd === 'hit' ? hitProbe(id || '') : searchProbe());
}

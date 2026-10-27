// 1.0.8: probe for the footer under the message list ("Loading…", the "Load older messages" button, the failure with Retry, the end line). DOM only, so it runs in the real
// app through the test bridge (`eval`) on Windows, macOS (WKWebView) and Linux (WebKitGTK), and in the dev preview.
//   node -e "import('./scripts/lib/list-foot-probe.mjs').then(m=>console.log(m.LIST_FOOT_JS))"   prints the expression
//   footVerdict(probe, 'settled' | 'failed') applies the pass criteria and returns a list of problems (empty = pass)
export const LIST_FOOT_JS = `(() => {
  const body = document.querySelector('.ml-body'); if (!body) return JSON.stringify({ body: false });
  const foot = body.querySelector('.ml-foot'); const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
  return JSON.stringify({
    body: true, bodyRect: r(body), scrollX: body.scrollWidth > body.clientWidth + 1,
    rows: body.querySelectorAll('.ml-row').length, spinners: body.querySelectorAll('.spin').length, pill: !!body.querySelector('.ml-loadbar.on'),
    empty: body.querySelector('.empty-state .empty-title')?.textContent || null,
    foot: foot ? { text: foot.textContent.replace(/\\s+/g, ' ').trim(), rect: r(foot), buttons: [...foot.querySelectorAll('button')].map((b) => ({ text: b.textContent.trim(), rect: r(b) })), muted: [...foot.querySelectorAll('.muted')].map((m) => ({ text: m.textContent.trim(), rect: r(m) })) } : null,
  });
})()`;

/** 'settled': nothing spins and the footer is a button, the end line or the cap line (or the empty state is shown); 'failed': a reason and Retry, nothing spins. */
export function footVerdict(p, want) {
  const bad = [];
  if (!p.body) return ['no .ml-body'];
  if (p.spinners !== 0) bad.push(`${p.spinners} spinner(s) in the list`);
  if (p.pill) bad.push('the loading bar is up');
  if (p.scrollX) bad.push('the list scrolls sideways');
  const f = p.foot;
  if (p.rows === 0) { if (!p.empty) bad.push('no rows and no empty state'); return bad; }
  if (!f) { bad.push('no footer under the rows'); return bad; }
  if (f.rect && p.bodyRect && (f.rect.left < p.bodyRect.left - 1 || f.rect.right > p.bodyRect.right + 1)) bad.push('the footer leaves the list sideways');
  for (const x of [...f.buttons, ...f.muted]) if (x.rect && p.bodyRect && x.rect.right > p.bodyRect.right + 1) bad.push(`"${x.text}" leaves the list`);
  if (want === 'failed') { if (f.buttons.length !== 1 || f.buttons[0].text.length === 0 || f.muted.length < 1) bad.push('the failure needs a reason and one button (Retry)'); }
  else if (f.buttons.length === 0 && f.muted.length === 0) bad.push('the footer says nothing');
  return bad;
}

// 1.0.7 D-044: the big pictures of a body stay out of the steps that open a draft (src/pictureDetach.ts) and the check of a picture source does not copy their data
// again and again (src/pastedHtml.ts isLocalPictureSrc). The 14 pictures of a 19 MB draft (25 million characters) took 0.4 s of the open in these steps.
//   node --experimental-strip-types scripts/test-picture-detach.mjs
import assert from 'node:assert/strict';
import { detachPictures } from '../src/pictureDetach.ts';
import { isLocalPictureSrc } from '../src/pastedHtml.ts';

let checks = 0;
const eq = (a, b, msg) => { checks++; assert.equal(a, b, msg); };
const ok = (c, msg) => { checks++; assert.ok(c, msg); };

const b64 = (n, seed = 1) => { let s = ''; const al = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += al[x % 64]; } return s + '=='; };

// ---- detach / restore
{
  const [p1, p2, p3] = [b64(5000, 1), b64(2100, 2), b64(40, 3)];
  const html = `<p>a</p><img src="data:image/png;base64,${p1}" alt="x"><div class="sig">-- <img src='data:image/jpeg;base64,${p2}'></div><img src="data:image/gif;base64,${p3}"><p>end</p>`;
  const d = detachPictures(html);
  ok(d.html.length < 400, `the data of the two big pictures is out (${d.html.length} characters left)`);
  ok(d.html.includes(`data:image/gif;base64,${p3}`), 'a small picture stays where it is');
  ok(/^<p>a<\/p><img src="data:image\/png;base64,hl-detached-0-end" alt="x">/.test(d.html), 'the marker is inside the attribute value');
  eq(d.restore(d.html), html, 'restoring the shortened text gives back the text');
  // a step that rewrites the text around the markers (the signature region, the quote block) still gets them back
  const edited = d.html.replace('<p>end</p>', '<p>end</p><div data-sig-block></div>');
  eq(d.restore(edited), html.replace('<p>end</p>', '<p>end</p><div data-sig-block></div>'), 'restore works on text made from the shortened one');
  eq(d.restore('plain text'), 'plain text', 'text without a marker is returned as it is');
  eq(d.restore('hl-detached-9-end'), 'hl-detached-9-end', 'a marker that is not ours stays');
}
{
  const html = '<p>no pictures</p><img src="https://example.com/a.png">';
  const d = detachPictures(html);
  ok(d.html === html && d.restore(html) === html, 'nothing to detach: the same text');
  const small = `<img src="data:image/png;base64,${b64(1997)}">`;
  eq(detachPictures(small).html, small, 'a picture under 2000 characters is left');
  // not a source attribute: a data URI in CSS, an unterminated one, one without quotes
  const css = `<div style="background:url(data:image/png;base64,${b64(3000)})"></div>`;
  eq(detachPictures(css).html, css, 'a data URI in a style is not touched');
  const open = `<img src="data:image/png;base64,${b64(3000)}`;
  eq(detachPictures(open).html, open, 'an unterminated attribute is not touched');
  // two big pictures in a row, the second right after the first
  const two = `<img src="data:image/png;base64,${b64(2500, 4)}"><img src="data:image/png;base64,${b64(2500, 5)}">`;
  const dd = detachPictures(two);
  eq(dd.html, '<img src="data:image/png;base64,hl-detached-0-end"><img src="data:image/png;base64,hl-detached-1-end">');
  eq(dd.restore(dd.html), two);
}
{
  // speed: the 25 million characters of a 19 MB draft (14 pictures of 1.8 million)
  const big = Array.from({ length: 14 }, (_, i) => `<p><img src="data:image/png;base64,${b64(1_800_000, i + 1)}" alt="p${i}"></p>`).join('');
  const t0 = performance.now();
  const d = detachPictures(big);
  const t1 = performance.now();
  const back = d.restore(d.html);
  const t2 = performance.now();
  eq(back.length, big.length, 'the whole text comes back');
  ok(back === big, 'and it is the same text');
  ok(t1 - t0 < 400 && t2 - t1 < 400, `detach ${Math.round(t1 - t0)} ms, restore ${Math.round(t2 - t1)} ms for 25 MB`);
  console.log(`  25 MB: detach ${Math.round(t1 - t0)} ms, restore ${Math.round(t2 - t1)} ms`);
}

// ---- isLocalPictureSrc: the fast path says yes only where the full check does, and everything else is decided as before
const reference = (src) => {
  // the check as it was (no entity in the inputs below that has a `&`, so decodeEntities is the identity there)
  // eslint-disable-next-line no-control-regex
  const s = src.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020\u00a0]+/, '').toLowerCase();
  return /^cid:[^\s"'<>\\]{1,255}$/.test(s) || /^data:image\/(?!svg)[a-z0-9.+-]{1,30}(;[a-z0-9=._-]+)*;base64,[a-z0-9+/=%\s]+$/.test(s);
};
{
  const cases = [
    'data:image/png;base64,iVBORw0KGgo=', 'DATA:IMAGE/PNG;BASE64,IVBORW0KGGO=', 'data:image/jpeg;base64,/9j/4AAQ', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,',
    'data:image/png;base64,AAAA BBBB', 'data:image/png;base64,AA\nAA\tBB', 'data:image/png;base64,AA"AA', 'data:image/png;base64,AA<AA', 'data:image/png;charset=utf-8;base64,AAAA',
    '  data:image/png;base64,AAAA', '\tdata:image/png;base64,AAAA', 'da\nta:image/png;base64,AAAA', 'data:image/png;base64,%41%41', 'data:image/png;base64,AAAA=====',
    'data:text/html;base64,PGI+', 'data:image/;base64,AAAA', 'data:image/' + 'x'.repeat(31) + ';base64,AAAA', 'data:image/png;base64,' + 'A'.repeat(100_000),
    'cid:logo@x', 'CID:Logo@x', 'cid:', 'cid:a b', 'https://example.com/a.png', '//example.com/a.png', 'file:///c:/a.png', 'blob:null/1', 'javascript:alert(1)', '',
    'data:image/png;base64,AAAA\u212a', 'data:image/png;base64,AA\u00a0AA',
  ];
  for (const c of cases) eq(isLocalPictureSrc(c), reference(c), `isLocalPictureSrc(${JSON.stringify(c.slice(0, 50))})`);
  // generated: random pieces of the characters that matter
  const alphabet = ['data:', 'image/', 'png', 'svg+xml', ';base64,', ';charset=x', 'AA', 'zz', '09', '+/=', '%', ' ', '\n', '\t', '"', "'", '<', '>', 'cid:', '&#65;', '\u00a0', 'İ'];
  let seed = 7;
  for (let i = 0; i < 4000; i++) {
    let s = '';
    const n = 1 + (seed = (seed * 1664525 + 1013904223) >>> 0) % 7;
    for (let k = 0; k < n; k++) s += alphabet[(seed = (seed * 1664525 + 1013904223) >>> 0) % alphabet.length];
    if (s.includes('&')) continue; // (entities: the full check decodes them, the fast path does not accept them: same answer by construction)
    eq(isLocalPictureSrc(s), reference(s), `isLocalPictureSrc(${JSON.stringify(s)})`);
    const t = 'data:image/png;base64,' + s;
    eq(isLocalPictureSrc(t), reference(t), `isLocalPictureSrc(${JSON.stringify(t)})`);
  }
  // entity-coded data stays as it was: the full check
  eq(isLocalPictureSrc('data:image/png;base64,AA&#65;A'), true, 'an entity in the data is decoded by the full check (as before)');
  eq(isLocalPictureSrc('&#100;ata:image/png;base64,AAAA'), true, 'an entity in the scheme too');
  // speed: one source of 1.8 million characters
  const src = 'data:image/png;base64,' + b64(1_800_000, 9);
  const t0 = performance.now();
  for (let i = 0; i < 14; i++) ok(isLocalPictureSrc(src), 'a big picture is local');
  const t = performance.now() - t0;
  ok(t < 600, `14 big sources checked in ${Math.round(t)} ms`);
  console.log(`  14 sources of 1.8 million characters checked in ${Math.round(t)} ms`);
}

console.log(`test-picture-detach: ${checks} checks ok`);

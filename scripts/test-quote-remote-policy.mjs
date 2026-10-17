#!/usr/bin/env node
// ONE remote-picture policy for the quote of a Reply and of a Forward (owner decision 2026-10-18, spec AC-61): a picture from the web STAYS in the sent
// quote (the composer never requests it; the recipient's client does), a tracking pixel of 3 x 3 px or less is dropped. The v1.0.6 QA round 2 saw a remote pixel
// kept in a Forward (round 1: the newsletter's picture had no size) and removed in a Reply (round 2: the pixel was `width="1" height="1"`): both are the policy,
// not an inconsistency: Reply and Forward make their quote with the same two functions (actions.ts `quoteBlockOf` -> editor/quoteClean.ts `quoteOf` and
// editor/quoteBlock.ts `quoteSentHtml`). This test keeps it that way and writes down exactly when a picture is dropped.
//
// A web picture (http / https) is DROPPED when its width or its height is 3 or less, written as a number or in px, in the `width` / `height` attributes or (when the attribute is
// missing) in the style (`style="width:1px"` or a class of a `<style>` sheet); 0 counts. It is KEPT without any size, with a size of 4 or more, with a percentage ("1%"), with a
// unit other than px ("1em", "1pt": the sizes the reader cannot compare) and when the attribute says more than the style (`width="100" style="width:1px"`). Also gone: an
// element hidden by display:none / visibility:hidden / the `hidden` attribute (with its picture), and pictures that are not a `data:` raster or a web address (`cid:`
// that could not be fetched, `file:`, UNC, `//host`, svg), which become their alt text.
//   node --experimental-strip-types scripts/test-quote-remote-policy.mjs
import assert from 'node:assert/strict';
import { quoteOf } from '../src/editor/quoteClean.ts';
import { quoteSentHtml } from '../src/editor/quoteBlock.ts';

const quote = (kind, html) => quoteSentHtml({ kind, head: 'head', html: quoteOf({ html, text: null }, 'cut').html });
const inner = (kind, q) => (kind === 'reply' ? q.slice(q.indexOf('<blockquote'), q.lastIndexOf('</blockquote>')).replace(/^<blockquote[^>]*>/, '') : q.slice(q.indexOf('</div><div>') + '</div><div>'.length, q.length - '</div></div>'.length));
const has = (html, needle) => ['reply', 'forward'].map((k) => inner(k, quote(k, html)).includes(needle));
const R = 'http://127.0.0.1:31304/pixel?id=1';

// [name, html, remote picture stays?]
const CASES = [
  ['no size (a newsletter picture, the Forward of round 1)', `<p>a</p><img src="${R}">`, true],
  ['100 x 50', `<img src="${R}" width="100" height="50">`, true],
  ['4 x 4 (just above the limit)', `<img src="${R}" width="4" height="4">`, true],
  ['width only, 200', `<img src="${R}" width="200">`, true],
  ['style 10px x 10px', `<img src="${R}" style="width:10px;height:10px">`, true],
  ['percentage 1%', `<img src="${R}" width="1%">`, true],
  ['unit em (not comparable)', `<img src="${R}" width="1em" height="1em">`, true],
  ['attribute wins over style (100 vs 1px)', `<img src="${R}" width="100" style="width:1px">`, true],
  ['https', `<img src="https://t.example.com/logo.png" width="120">`, true],
  ['1 x 1 (the pixel of round 2)', `<img src="${R}" width="1" height="1">`, false],
  ['3 x 3 (the limit)', `<img src="${R}" width="3" height="3">`, false],
  ['width 1 only', `<img src="${R}" width="1">`, false],
  ['height 3 only', `<img src="${R}" height="3">`, false],
  ['0 x 0', `<img src="${R}" width="0" height="0">`, false],
  ['1px in px', `<img src="${R}" width="1px" height="1px">`, false],
  ['style 1px', `<img src="${R}" style="width:1px;height:1px">`, false],
  ['class of a style sheet', `<style>.px{width:1px;height:1px}</style><img class="px" src="${R}">`, false],
  ['display:none', `<img src="${R}" style="display:none">`, false],
  ['hidden by its parent', `<div style="display:none"><img src="${R}"></div>`, false],
  ['hidden attribute', `<img src="${R}" hidden>`, false],
  ['protocol relative //host', `<img src="//127.0.0.1:31304/pixel?id=1" width="100">`, false],
  ['UNC', `<img src="\\\\127.0.0.1\\share\\x.png" width="100">`, false],
  ['file:', `<img src="file:///C:/Windows/win.ini" width="100">`, false],
  ['cid that could not be fetched', `<img src="cid:abc@x" width="100">`, false],
  ['svg data', `<img src="data:image/svg+xml;base64,PHN2Zy8+" width="100">`, false],
];
for (const [name, html, stays] of CASES) {
  const [reply, forward] = has(html, '127.0.0.1:31304/pixel?id=1').map((x, i) => (name.startsWith('https') ? has(html, 't.example.com/logo.png')[i] : x));
  assert.equal(reply, forward, `${name}: Reply (${reply}) and Forward (${forward}) must treat the picture alike`);
  assert.equal(reply, stays, `${name}: the picture ${stays ? 'stays' : 'goes'}, but it ${reply ? 'stayed' : 'went'}`);
  // the whole quote is the same in both: only the wrapper differs
  assert.equal(inner('reply', quote('reply', html)), inner('forward', quote('forward', html)), `${name}: the quoted original differs between Reply and Forward`);
}
// a local picture (data:) stays in both, and the alt text of a dropped one stays as text
for (const k of ['reply', 'forward']) {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.ok(quote(k, `<img src="${png}" width="1" height="1">`).includes('<img') === false, `${k}: a 1 x 1 data picture is a pixel too`);
  assert.ok(quote(k, `<img src="${png}" width="50">`).includes(png), `${k}: a data picture stays`);
  assert.ok(quote(k, `<img src="file:///x.png" alt="my picture">`).includes('my picture'), `${k}: the alt text of a dropped picture stays`);
}
console.log('ok - test-quote-remote-policy');

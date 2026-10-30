#!/usr/bin/env node
// The "sent" mark of Compose (1.0.11): its time is about a second, shorter and plain with reduced motion, and the stylesheet keeps the mark visible under reduced motion.
//   node --experimental-strip-types scripts/test-sent-mark.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SENT_MARK_MS, SENT_MARK_MS_REDUCED, prefersReducedMotion, sentMarkMs } from '../src/sentMark.ts';

assert.equal(sentMarkMs(false), SENT_MARK_MS);
assert.equal(sentMarkMs(true), SENT_MARK_MS_REDUCED);
assert.ok(SENT_MARK_MS >= 800 && SENT_MARK_MS <= 1200, 'about one second');
assert.ok(SENT_MARK_MS_REDUCED < SENT_MARK_MS && SENT_MARK_MS_REDUCED >= 400, 'reduced motion: shorter, still readable');

// no matchMedia (node): not reduced; a throwing or reduced matchMedia is read safely
assert.equal(prefersReducedMotion(), false);
globalThis.matchMedia = () => ({ matches: true });
assert.equal(prefersReducedMotion(), true);
globalThis.matchMedia = () => { throw new Error('nope'); };
assert.equal(prefersReducedMotion(), false);

// the sources: Compose draws the mark and the stylesheet animates it (the global reduced-motion rule shortens every animation)
const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8');
const src = readFileSync(new URL('../src/components/Compose.tsx', import.meta.url), 'utf8');
assert.match(css, /\.cp-sent\s*\{/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ animation-duration: \.01ms !important/);
assert.match(src, /className="cp-sent"/);
assert.match(src, /sentMarkMs\(prefersReducedMotion\(\)\)/);
// the pane no longer closes at Send: the lock is used for the pane as well
assert.doesNotMatch(src, /openCompose\(null, \{ sending: wait \}\)/);
assert.ok(src.includes('data-sent-mark={sentMark') && src.includes('hl:sent-mark'), 'QA can observe the mark (class sent-mark, data-sent-mark, performance entry)');
console.log('PASS test-sent-mark');

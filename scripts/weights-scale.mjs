#!/usr/bin/env node
// One pass over the font-weight values of the app chrome (CSS rules and inline styles), from the committed files. The values were tuned for Inter; Source Sans 3 looks heavier at the same number,
// and the owner wants nothing above 600 and 600 only for a few strong spots. Same digit count everywhere, so the CSS size does not change.
//   node scripts/weights-scale.mjs <cur|A|B>      cur = the committed values (restores them)
//   A: every weight of 550 and more becomes 500, except the KEEP selectors which are 600
//   B: like A, but the former 650 / 700 / 800 (the second tier) become 550; the former 600 and 550 become 500; the KEEP selectors are 600
// The text of the editor and of the mail (user content: .tiptap, .rich-body) keeps its bold, the Bold command has to produce bold.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const KEEP = [
  '.rp-head h2', '.reader-pane .rp-head h1',            // the title of the message
  '.settings-body h3', '.cal-head h2',                  // the title of a page
  '.ml-row.unread .who',                                // the unread sender
  '.fp-badge.strong', '.fp-badge.err', '.is-rail .fp-pip', '.is-rail .fp-row .fp-badge', // count badges
];
const MID = ['.btn.primary', '.brand']; // the primary button and the name: 550 (owner)
const which = process.argv[2];
if (!['cur', 'A', 'B'].includes(which)) { console.error('usage: weights-scale.mjs cur|A|B'); process.exit(2); }
const cap = (sel, w) => {
  if (which === 'cur') return w;
  if (+w < 550) return w;
  if (KEEP.includes(sel)) return '600';
  if (MID.includes(sel)) return '550';
  if (which === 'B' && +w >= 650) return '550';
  return '500';
};
const files = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' }).split('\n').filter((f) => /\.(css|tsx|ts)$/.test(f) && !/devMock|i18n\//.test(f));
let n = 0;
for (const f of files) {
  let s = execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (/\.css$/.test(f)) {
    // rule by rule: the selector decides (a group of selectors counts as the one rule)
    s = s.replace(/([^{}]+)\{([^{}]*)\}/g, (m, sel, body) => {
      const name = sel.replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' ');
      if (!/font-weight:\s*\d{3}/.test(body) || /\.tiptap|\.rich-body/.test(name)) return m;
      return m.replace(/(font-weight:\s*)(\d{3})\b/g, (mm, p, w) => { const x = cap(name, w); if (x !== w) n++; return p + x; });
    });
  } else {
    // inline styles / frame rules / attributes: 550 and above is a toolbar sample or a glyph: 600 at most
    s = s.replace(/(font-weight:\s*|fontWeight:\s*["']?|fontWeight=")(\d{3})\b/g, (m, p, w) => { if (which === 'cur' || +w < 550 || /controls\.tsx|Welcome\.tsx/.test(f)) return m; n++; return p + (+w >= 650 && which === 'B' ? '550' : '500'); });
  }
  if (f === 'src/App.css' && which !== 'cur') s = s.replace('body { background: var(--bg); color: var(--fg);', `b, strong, th, h4 { font-weight: ${which === 'B' ? 550 : 500}; } /* (the UA default is bold = 700: nothing in the app is heavier than 600) */
body { background: var(--bg); color: var(--fg);`);
  if (s !== fs.readFileSync(f, 'utf8')) fs.writeFileSync(f, s);
}
console.log(`${which}: ${n} values changed in ${files.length} files`);

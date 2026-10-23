#!/usr/bin/env node
// Production build and optimization for the website in docs/ (no dependencies required).
// Usage: node scripts/build-site.mjs [outDir]
//
// 1. Copies all files from docs/ into the output directory (default: _site).
// 2. Optimizes and minifies assets/style.css and assets/*.js (using esbuild if available, or a safe built-in minifier).
// 3. Verifies that all expected assets exist in the output directory.
//
// The APT repository (WP15, DEC-022): the "Install with APT" block of the 8 download pages sits between <!-- hl:apt-begin --> and <!-- hl:apt-end -->.
// The site is DORMANT unless APT_SITE=on (pages.yml sets it from one fact only: the branch `apt` exists). Off (the default, also when the variable is
// missing or has any other value): every download page loses the block, docs/apt/ (the key and the sources file) is not copied, so the site never
// advertises a repository that does not exist yet. On: nothing is removed and docs/apt/ is copied.
//
// The Store's offline installer (WP14 option B): with STORE_EXE=on (pages.yml sets it from the repository variable STORE_EXE === 'true') the built
// robots.txt also says `Disallow: /downloads/` (the installers that .github/scripts/store-exe-assemble.sh puts there are for Partner Center, not for
// crawlers). Off (the default, also for any other value) the site is exactly what it was; docs/robots.txt itself never changes.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = path.join(ROOT, 'docs');
const OUT_DIR = path.resolve(ROOT, process.argv[2] || '_site');

const APT_ON = process.env.APT_SITE === 'on';
const STORE_EXE_ON = process.env.STORE_EXE === 'on';
const APT_BEGIN = '<!-- hl:apt-begin -->';
const APT_END = '<!-- hl:apt-end -->';

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!APT_ON && src === DOCS && entry.isDirectory() && entry.name === 'apt') continue; // dormant: the key and heylook.sources are not deployed
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Dormant site: takes the APT block (markers included, and the line it sits on) out of the pages. Exactly one pair on each download page, none anywhere else. */
function removeAptBlocks(dir) {
  let removed = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!e.name.endsWith('.html')) continue;
      let html = fs.readFileSync(f, 'utf8');
      const nb = html.split(APT_BEGIN).length - 1;
      const ne = html.split(APT_END).length - 1;
      const rel = path.relative(dir, f).replace(/\\/g, '/');
      const isDownload = /^(?:[a-z]{2}\/)?download\.html$/.test(rel);
      if (!nb && !ne) {
        if (isDownload) throw new Error(`${rel}: no ${APT_BEGIN} ... ${APT_END} pair (the APT block must be wrapped in the source)`);
        continue;
      }
      if (!isDownload) throw new Error(`${rel}: APT markers on a page that is not a download page`);
      if (nb !== 1 || ne !== 1) throw new Error(`${rel}: ${nb} begin and ${ne} end markers, expected exactly one pair`);
      const a = html.indexOf(APT_BEGIN);
      const z = html.indexOf(APT_END) + APT_END.length;
      if (z <= a + APT_BEGIN.length) throw new Error(`${rel}: the APT end marker comes before the begin marker`);
      const lineStart = html.lastIndexOf('\n', a) + 1;
      const onlyIndent = /^[ \t]*$/.test(html.slice(lineStart, a));
      const lineEnd = html[z] === '\n' ? z + 1 : z;
      html = html.slice(0, onlyIndent ? lineStart : a) + html.slice(onlyIndent ? lineEnd : z);
      fs.writeFileSync(f, html);
      removed++;
    }
  };
  walk(dir);
  if (removed !== 8) throw new Error(`the APT block was taken out of ${removed} pages, expected the 8 download pages`);
  return removed;
}

/** Safe built-in CSS minifier that preserves calc() operators */
function minifyCss(css) {
  return css
    // Remove comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Collapse newlines, tabs, and multiple spaces
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    // Remove spaces around block delimiters and punctuation
    .replace(/\s*([{};,>~])\s*/g, '$1')
    // Remove spaces before opening parenthesis, but keep calc() expressions safe
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    // Remove space before colon
    .replace(/\s*:\s*/g, ':')
    // Restore necessary spaces in calc(+ / -)
    .replace(/calc\(([^)]+)\)/g, (m, expr) => 'calc(' + expr.replace(/([^\s])([+-])/g, '$1 $2').replace(/([+-])([^\s])/g, '$1 $2') + ')')
    // Remove trailing semicolons before closing brace
    .replace(/;}/g, '}')
    .trim();
}

/** Safe built-in JS minifier that strips comments and redundant whitespace */
function minifyJs(js) {
  return js
    // Remove block comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Remove whole-line single comments
    .replace(/^[ \t]*\/\/.*$/gm, '')
    // Remove multiple blank lines
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

function hasEsbuild() {
  try {
    execSync('esbuild --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function build() {
  const t0 = Date.now();
  console.log(`Building website for production: ${DOCS} -> ${OUT_DIR}`);

  if (fs.existsSync(OUT_DIR)) {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }
  copyDir(DOCS, OUT_DIR);
  if (APT_ON) console.log('  APT_SITE=on: the APT block and docs/apt/ stay in the site');
  else console.log(`  APT block left out (APT_SITE is not "on"): removed from ${removeAptBlocks(OUT_DIR)} download pages, docs/apt/ not copied`);

  if (STORE_EXE_ON) {
    const robots = path.join(OUT_DIR, 'robots.txt');
    const text = fs.readFileSync(robots, 'utf8');
    if (!/^Disallow: \/apt\/\r?$/m.test(text)) throw new Error('robots.txt has no "Disallow: /apt/" line to put "Disallow: /downloads/" after');
    fs.writeFileSync(robots, text.replace(/^(Disallow: \/apt\/)(\r?)$/m, '$1$2\nDisallow: /downloads/$2'));
    console.log('  STORE_EXE=on: robots.txt disallows /downloads/');
  }

  const esbuildAvailable = hasEsbuild();
  let totalSaved = 0;
  let totalOrig = 0;

  // 1. Minify CSS
  const cssPath = path.join(OUT_DIR, 'assets', 'style.css');
  if (fs.existsSync(cssPath)) {
    const raw = fs.readFileSync(cssPath, 'utf8');
    totalOrig += raw.length;
    let minified = '';
    if (esbuildAvailable) {
      try {
        execSync(`npx --yes esbuild "${cssPath}" --minify --outfile="${cssPath}"`, { stdio: 'pipe' });
        minified = fs.readFileSync(cssPath, 'utf8');
      } catch {
        minified = minifyCss(raw);
        fs.writeFileSync(cssPath, minified);
      }
    } else {
      minified = minifyCss(raw);
      fs.writeFileSync(cssPath, minified);
    }
    const saved = raw.length - minified.length;
    totalSaved += saved;
    console.log(`  assets/style.css: ${raw.length} -> ${minified.length} bytes (-${((saved / raw.length) * 100).toFixed(1)}%)`);
  }

  // 2. Minify JS
  const jsFiles = [
    path.join(OUT_DIR, 'assets', 'site.js'),
    path.join(OUT_DIR, 'assets', 'story.js'),
    path.join(OUT_DIR, 'assets', 'theme-init.js'),
  ];
  const i18nDir = path.join(OUT_DIR, 'assets', 'i18n');
  if (fs.existsSync(i18nDir)) {
    for (const f of fs.readdirSync(i18nDir)) {
      if (f.endsWith('.js')) jsFiles.push(path.join(i18nDir, f));
    }
  }

  for (const jsFile of jsFiles) {
    if (!fs.existsSync(jsFile)) continue;
    const raw = fs.readFileSync(jsFile, 'utf8');
    totalOrig += raw.length;
    let minified = '';
    if (esbuildAvailable) {
      try {
        execSync(`npx --yes esbuild "${jsFile}" --minify --outfile="${jsFile}"`, { stdio: 'pipe' });
        minified = fs.readFileSync(jsFile, 'utf8');
      } catch {
        minified = minifyJs(raw);
        fs.writeFileSync(jsFile, minified);
      }
    } else {
      minified = minifyJs(raw);
      fs.writeFileSync(jsFile, minified);
    }
    const saved = raw.length - minified.length;
    totalSaved += saved;
    const rel = path.relative(OUT_DIR, jsFile).replace(/\\/g, '/');
    console.log(`  ${rel}: ${raw.length} -> ${minified.length} bytes (-${((saved / raw.length) * 100).toFixed(1)}%)`);
  }

  console.log(`Build complete in ${Date.now() - t0}ms: total assets reduced by ${totalSaved} bytes (-${((totalSaved / totalOrig) * 100).toFixed(1)}%)`);
}

build();

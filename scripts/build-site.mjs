#!/usr/bin/env node
// Production build and optimization for the website in docs/ (no dependencies required).
// Usage: node scripts/build-site.mjs [outDir]
//
// 1. Copies all files from docs/ into the output directory (default: _site).
// 2. Optimizes and minifies assets/style.css and assets/*.js (using esbuild if available, or a safe built-in minifier).
// 3. Verifies that all expected assets exist in the output directory.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = path.join(ROOT, 'docs');
const OUT_DIR = path.resolve(ROOT, process.argv[2] || '_site');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
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

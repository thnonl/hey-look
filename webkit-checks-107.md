# WebKit and font checks for 1.0.7 (macOS WKWebView, Linux WebKitGTK)

Status: OPEN checklist, append-friendly. Created 2026-10-19 by QA (planner).
Source head: origin/release/v1.0.7 = 329b41b (the head of the round being planned). Every result must name the SHA it ran on.
Owner rules behind this file: RULE-WEBKIT-FONTS (findings.md row 337, 2026-10-19: "fonts and WebKit on macOS and Linux must be CHECKED, not skipped"), QA-SCOPE-PLATFORM-2 (findings.md row 146: UI/UX changes, fonts and visible text are tested on Mac and Linux too), QA-SCOPE-PLATFORM (findings.md row 143).
Executor: the Mac + Linux QA session (memory `mac-qa-session-routing`: every message starts with the ACK line; a result counts only when tied to the SHA; own PID frontmost before any screen click, MAC-M9 rule). Notes: `~/qa-heylook/r107/` on the Mac, `~/qa-heylook/linux/notes/` in the VM (spec-107-wp11-wp12.md section 1).

Nothing in this file was run. No app was started, no session was contacted. The probes below were only parsed (syntax-checked as async function bodies). PASS must come from a real run.

Sources read: coder-v107-*.md and coder-v106-*.md ("not verified" / Mac / Linux / WebKit / fonts sections), qa-queue-107.md (D-012 steps, WP1/WP2 "QA looks at" lines), qa-v107-wp1-windows.md, qa-v107-wp2a-windows.md, qa-v107-retest1-windows.md, qa-v107-wp10ab.md, defects-107.md, findings.md (Mac and Linux rows, DRYRUN rows), spec-107-wp1, wp2, wp3..wp13 ("Mac/Linux session" lines), the merge history of origin/release/v1.0.7 (100 non-merge commits since 39af592), src/App.css, src/i18n, src-tauri/tauri.conf.json, src-tauri/Cargo.toml, scripts/test-notice-baseline.mjs, scripts/lib/baseline-probe.mjs, scripts/test-compose-fit.mjs, scripts/test-popover-fit.mjs, scripts/test-tab-stops.mjs, scripts/test-sidebar-collapse.mjs, test-builds/v107-329b41b/bridge-README.md.

---

## 0. How to run this file (Mac and Linux session)

0.1 Build: debug build of the SHA with the test bridge (`HEYLOOK_TEST_BRIDGE=0`, throw-away `HEYLOOK_DATA_DIR`, own identifier). Start from Terminal (so the env vars are inherited). Port and token: `grep "test bridge: listening" $HEYLOOK_DATA_DIR/startup.log | tail -1`.

0.2 Bridge facts (bridge-README.md, verified in the kit):
- `POST /eval {window, js}`: `js` is ONE expression (one line, no `;`, no `return`) OR the body of an async function that `return`s its value. Every probe below is a function body that ends with `return JSON.stringify(...)`.
- The page's CSP forbids `eval` and `new Function`: probes use DOM calls only.
- `GET /windows`: `logicalWidth` / `logicalHeight` (CSS px = the sizes the person thinks in; 960 x 560 at scale 2 is 1920 x 1120 physical). Use it to confirm a window size before every row.
- There is NO resize endpoint and NO drag endpoint in the kit. Window sizes are set with the OS (macOS: System Events `set size` via osascript, Accessibility permission for Terminal; Linux X11: `xdotool getactivewindow windowsize 960 560`). Drags (chips, cell selection, file drop) are OS input (xdotool on Linux; OS input rules on the Mac). Record the method in the row.
- Dev hooks do NOT exist in this build: `window.__store`, `window.__baselines` (except what PROBE_JS installs), devMock threads (nl1, t12 ...) are DEV-only (src/devMock.ts:876, src/main.tsx:22). Use real UI steps and the stub mailbox.

0.3 Fixtures (stub mailbox of the kit, QA-made, not in the repo):
- Newsletter mail: a mail with a List-Unsubscribe header (the app shows "This looks like a newsletter. Unsubscribe" when `m.canUnsubscribe`, src/components/ReadingPane.tsx:657-665). Body with three pictures: `<img width="600" height="200" alt="Header">`, `<img>` without size, `<img width="1" height="1">`.
- Plain-text mail with an ASCII table (columns aligned with spaces), a line indented by 4 spaces, two blank lines in a row, a tab.
- Calendar: an event 19:00 to 20:00 on Wednesday of next week.
- Accounts: one account on the stub; a second address "outlook" or "yahoo" for the webmail row (findings V107-MAC-ROUND2-DONE: the webmail search copy needs such an address).
- STATUS: the kit folder test-builds/v107-329b41b/fixtures has only README.md and sign-only.asc. The newsletter and table fixtures do not exist yet: rows that need them are BLOCKED until QA adds them to the stub (QA owner, not coder).

0.4 Window sizes used (logical px): 960 x 560 (minWidth 960, minHeight 560, tauri.conf.json:18-19), 960 x 480 (WP1-fix1 case, D-003/D-012), 946 x 480 (popover matrix, test-popover-fit), 1000 x 700 (side menu), 1099 and 1100 (list-hidden threshold, sidebarState.ts:23), 1280 x 800 (default, tauri.conf.json:16-17), 375 wide (site, phone header).

0.4a Linux client sizes (reported by the session on 329b41b): the bridge reports `logicalWidth` / `logicalHeight` (CSS px). xdotool reads the X client area, which is the logical height minus 28 px (KDE title bar). So "window 960 x 480" means bridge logicalHeight 480 = xdotool client height 452. Set the window to the logical size you need, and confirm it with `/windows` logicalHeight, never with the xdotool number.

0.5 Languages: at least de, ru, ja for every row; vi, fr, es, zh-Hans where a row says "8 languages". Language is changed in Settings > General (no store hook).

0.6 Screenshot name (every row that says "screenshot"): `webkit-107-<mac|linux>-<row-id>-<lang>-<WxH>-<light|dark>.png` in `~/qa-heylook/r107/shots/` (Mac) or `~/qa-heylook/linux/notes/shots/` (Linux). Quote the file name in the status cell.

0.7 Status cells: `OPEN` (not run) / `PASS yyyy-mm-dd @<sha7> <evidence file>` / `FAIL yyyy-mm-dd @<sha7> <bug id or new BUG>` / `BLOCKED yyyy-mm-dd @<sha7> <reason>` / `N/A <reason>`. NOT RUN is never PASS. Append a line to section 9 (status log) for each change.

---

## 1. Engine floors and what the engine must support

1.1 Facts (from source, not from memory):
- macOS: src-tauri/tauri.conf.json:41 `minimumSystemVersion: "11.0"` (macOS 11 = Safari 14 WebKit). WKWebView follows the macOS point release (Safari version = macOS version's WebKit).
- Build target: vite.config.ts sets no `build.target`. Vite 8.3.4 (node_modules of the main clone; release package.json has ^8.0.16) uses `baseline-widely-available`, which resolves to chrome111, edge111, firefox114, safari16.4, ios16.4 (vite dist/node/chunks/node.js:720). esbuild lowers SYNTAX to that target; it does NOT polyfill APIs or CSS features, and it cannot lower a regex lookbehind.
- Linux: src-tauri/Cargo.toml: `webkit2gtk = "=2.0.2"` with feature `v2_40` (WebKitGTK 2.40 API at build time), `gtk = "0.18"`. Test VM: Kubuntu 24.04 arm64 (KDE) in UTM on the Mac (owner decision V107-OWNER-DECISIONS-3, findings.md row 275). x86_64 Linux is not tested (known limit).
- CSP (tauri.conf.json): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; frame-src blob:; object-src 'none'`. There is no external font and no @font-face in the app (only a string in devMock.ts:186).

1.2 CONFLICT for the BA and owner (not a test result): the declared floor is macOS 11 (Safari 14), but the build target is Safari 16.4 (macOS 13.3) and several CSS and JS features need 15.4 to 16.4. Until a floor is decided, QA tests the OLDEST macOS available to the Mac session and records the version in each row. The floor decision is open question Q1 (section 10).

1.3 Engine feature table. "First" = the first WebKit/Safari version where the feature exists. These numbers are from memory: P-ENV (section 3) reads the real support on the machine under test; confirm the number on the Mac/VM before quoting it in a row.

| Feature | Where in the branch | First (verify with P-ENV) | If missing | Risk |
|---|---|---|---|---|
| clamp() | App.css:517-518 | Safari 13.1 | the px declaration before it stays (12px, 46px) | low |
| percentage inside scroll-padding (`calc(100% - 75px)`) | App.css:517-518 | not known for WebKit: P-CPHEAD reads the computed value | px fallback 12 / 46 px in effect; focus check still applies | medium |
| scroll-padding | App.css:319, 364, 517, 518 | Safari 14.1 (verify) | no scroll margin: a focused field is brought in under the sticky bar | medium |
| `1lh` unit (inside @supports) | App.css:144 | Safari 16.4 | 4 px padding fallback (click box 24 px needs the calc) | low, 1-2 px visual |
| `:has()` | App.css:1009 (body:has(...) hides picture handles behind a pinned popover) | Safari 15.4 | rule dropped: handles stay visible over the popover | medium below 15.4 |
| `inert` attribute | AppearancePreview.tsx:27; Compose.tsx:2190 (locked compose), 2261; MessageList.tsx:312; App.css:527 comment | Safari 15.5 | attribute ignored, no polyfill in the repo: the preview and the locked compose stay focusable and clickable | HIGH below 15.5 |
| `color-mix()` (62 uses in App.css; the dark theme tokens derive --accent, --accent-soft, --top from it) | App.css theme block lines 30-60 and the rest | Safari 16.2 | token invalid: accent and hover colours fall back to nothing in dark theme | HIGH below 16.2 |
| container queries (`@container`) | App.css:610-611 (pv-label, pv-txt), 1510 (cf-subject imp text) | Safari 16.0 | labels stay visible in narrow panes | medium below 16.0 |
| RegExp lookbehind `(?<!E)` | src/i18n/format.ts (WEEKDAY_EEE, the date patterns) | Safari 16.4 | SyntaxError at parse time: the module that holds it does not load. HYPOTHESIS: the app does not start on a WebKit below 16.4. Verify on the oldest macOS. | BLOCKER if the floor stays at 11.0 |
| `overflow: clip` | App.css:1041 (`.pic-handles`, after `overflow: hidden`) | Safari 16.0 (verify) | the `hidden` declaration stays | low |
| backdrop-filter (unprefixed) | App.css:408 (group header), 734 (modal backdrop) | unprefixed Safari 18 (verify); earlier WebKit ignores it | no blur: cosmetic | low |
| content-visibility, contain-intrinsic-size | App.css:412, 424 | Safari 18 (verify) | rows render without skipping: performance only | low |
| font-variant-emoji | App.css:1061 (`.symbol-btn`) | Safari 17.4 (verify) | emoji presentation left to the font | low |
| translate property | App.css (1 use) | Safari 14.1 (verify) | ignored | low |
| oklch() | 3 uses (grep) | Safari 15.4 (verify) | ignored value | low |
| ::after overlays with pointer-events none | App.css:1022 (selected table cell) and 8 others | all engines | none | low |
| ResizeObserver | Compose.tsx, FormatBar.tsx, Calendar.tsx, ReadingPane.tsx, VirtualList.tsx and others (some with typeof guards) | Safari 13.1 | throws where unguarded | low at the floor |
| navigator.clipboard | open.ts, contextPolicy.ts, devMock.ts | WKWebView refuses it outside a trusted gesture; WebKitGTK may lack it | copyToClipboard chain: backend first (macclip / Linux), then page, then a text box (11e5862) | medium: row 106.06 |
| canvas measureText fontBoundingBoxDescent | scripts/lib/baseline-probe.mjs (used by P-NOTICE) | Safari 11.1 (verify) | the baseline probe returns NaN: P-NOTICE is invalid on that engine | P-ENV reports it |
| dvh, svh, lvh, field-sizing, text-wrap, subgrid, anchor() | 0 uses in src | n/a | n/a | none: do not test |

1.4 Minimum versions to quote in the report: macOS: the oldest the Mac session has (record `sw_vers` and the WebKit version: P-ENV `ua`). Linux: WebKitGTK from `dpkg -s libwebkit2gtk-4.1-0 | grep Version` (expected 2.44 or newer on Kubuntu 24.04; verify). The app's build needs 2.40 at least (v2_40 feature).

---

## 2. Font facts

### 2.1 Font stacks the app asks for (verified in the source of origin/release/v1.0.7)

| # | Where | Stack (as written) | Used by |
|---|---|---|---|
| F1 | src/App.css:39 (`:root`) | "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif | all UI text |
| F2 | src/App.css:75 `:root:lang(zh-Hans)` | F1 + "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC" | zh-Hans UI (Han glyphs) |
| F3 | src/App.css:76 `:root:lang(ja)` | F1 + "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Meiryo UI", "Noto Sans CJK JP", "Noto Sans JP", "Source Han Sans" | ja UI (kana, kanji) |
| F4 | src/App.css:97, 867, 980, 981, 1189; kbd | "Cascadia Mono", Consolas, monospace | kbd, .mono, .fpr, .original, .pv-text |
| F5 | src/App.css:680, 682 (`.rich-body .tiptap pre` and `code`) | Consolas, Menlo, 'Courier New', monospace | code in mail |
| F6 | src/App.css:1058 (`.emoji-btn`), 1049-1062 | "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif | emoji picker grid |
| F7 | src/App.css:1061 (`.symbol-btn`) | "Segoe UI Symbol", "Segoe UI", -apple-system, "Helvetica Neue", "Noto Sans", sans-serif; font-variant-emoji: text | Symbol panel |
| F8 | src/App.css:634 (`.editor .tiptap`, `.rich-body .tiptap`), 691 (`.sig-body`) | var(--cp-font, Calibri, Carlito, Arial, sans-serif) at var(--cp-size, 11pt) | the body of the message being written |
| F9 | src/editor/fonts.ts (FONTS, DEFAULT_FONT_NAME = "Calibri", DEFAULT_FONT_SIZE = 11) | Calibri -> "Calibri,Carlito,Arial,sans-serif"; Aptos -> "Aptos,Calibri,Carlito,Arial,sans-serif"; Consolas -> "Consolas,Menlo,'Courier New',monospace"; Segoe UI -> "'Segoe UI',-apple-system,'Helvetica Neue',Arial,sans-serif" | the font menu; the HTML that is sent |
| F10 | docs/assets/style.css:6-8 (website, not the app) | --font: "Segoe UI Variable Display", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif; --mono: ui-monospace, "Cascadia Mono", "SF Mono", "Roboto Mono", Consolas, "Liberation Mono", monospace | website |

Facts about what is NOT there:
- There is NO src/index.css on this branch (`git ls-tree origin/release/v1.0.7 src` lists only src/App.css as the global stylesheet). Any sheet named index.css in an old note is stale.
- There are no web fonts (no @font-face in the app, CSP font-src 'self' data:). Every glyph comes from a font installed on the machine.
- The CJK line of F2 and F3 keeps the Latin stack first: Latin text keeps its width; only Han and kana use the regional font (App.css comment lines 73-74).
- Cyrillic, German and Spanish need nothing beyond F1; Vietnamese needs the Latin stack to have the combining marks (ệ, ơ, ư, ế; check in P-ENV `sample`).

### 2.2 What is installed by default (expected; P-ENV reads the truth on the machine)

| Font | Windows 11 (test PC, reference) | macOS 12 to 15 (default install) | Kubuntu 24.04 KDE (VM) |
|---|---|---|---|
| Segoe UI Variable Text / Segoe UI | yes | no | no |
| system-ui | Segoe UI Variable (via F1) | San Francisco (SF Pro Text / Display) | the KDE desktop font: Noto Sans expected (verify) |
| Helvetica Neue, Arial | yes (Arial) | Helvetica Neue and Arial: yes | Arial: no; Liberation Sans if fonts-liberation is installed (verify) |
| Calibri, Carlito | Calibri yes (Office or Windows), Carlito no | Calibri only with Office for Mac; Carlito no | Calibri no; Carlito only if fonts-crosextra-carlito is installed (verify, expected no) |
| Cascadia Mono, Consolas | yes | Cascadia no; Consolas only with Office for Mac | no |
| Menlo | no | yes (default) | no |
| monospace (generic) | Consolas (browser default) | WebKit default fixed font (Courier or Menlo: verify with P-ENV) | DejaVu Sans Mono or Hack (KDE default monospace is Hack: verify) |
| DejaVu Sans | no | no | yes (fonts-dejavu-core, expected; verify) |
| Noto Sans | no | no | yes as the KDE UI font (verify) |
| Emoji | Segoe UI Emoji | Apple Color Emoji (default) | Noto Color Emoji expected; evidence: no tofu in the 8-language run (LINUX-RC-344a88a, findings row 130) (verify) |
| Symbols | Segoe UI Symbol | Helvetica Neue / system glyphs | Noto Sans / DejaVu Sans glyphs |
| Han, kana | Microsoft YaHei UI, Yu Gothic UI | PingFang SC, Hiragino Sans, Hiragino Kaku Gothic ProN (default) | Noto Sans CJK JP / SC: evidence of rendering ja and de/ru without tofu on the VM (MAC-LINUX-ba299fd, LINUX-FINAL-0bda43e); verify with P-ENV |

### 2.3 What renders (the fallback in use)

| UI text | Windows 11 | macOS 12 to 15 | Kubuntu 24.04 (VM) |
|---|---|---|---|
| en, de, fr, es, ru, vi (Latin, Cyrillic) | Segoe UI Variable Text | system-ui = SF | system-ui = Noto Sans (verify) |
| ja (kana, kanji) | Yu Gothic UI (Han/kana), Segoe UI (Latin) | Hiragino Sans (kana/kanji), SF (Latin) | Noto Sans CJK JP (kana/kanji), Noto Sans (Latin) |
| zh-Hans (Han) | Microsoft YaHei UI | PingFang SC | Noto Sans CJK SC |
| Emoji in the picker | Segoe UI Emoji (colour) | Apple Color Emoji (colour) | Noto Color Emoji (colour) if installed; otherwise a fallback glyph or tofu: FAIL |
| Symbol panel | Segoe UI Symbol | fallback to SF / Helvetica Neue | fallback to Noto Sans / DejaVu Sans |
| Mono (kbd, code in mail) | Cascadia Mono / Consolas | generic monospace (WebKit default) | generic monospace (DejaVu Sans Mono or Hack) |
| Composed mail body (Calibri 11) | Calibri | Calibri not present: Carlito not present: Arial (Arial metrics) | Calibri not present: Carlito if installed, else Arial, else Liberation Sans, else DejaVu Sans (WIDER than Arial: a layout change of the body text) |

Layout consequence: the widths and wraps of Windows numbers do NOT carry over. Every PASS criterion below is a measurement made on the machine under test (no Windows number is reused). The composed-mail body row (F9) can wrap differently on Kubuntu if Carlito is missing: record which fallback rendered (P-ENV `fonts` for Carlito, Arial, Liberation Sans, DejaVu Sans).

### 2.4 Glyph coverage for the 8 languages

- en, de, fr, es, ru, vi: Latin, Cyrillic and Vietnamese marks come from the UI font on all three platforms. Check the Vietnamese marks (ệ ơ ư ế) in the screenshot of each row.
- ja: kana and kanji come from the regional font (Hiragino / Yu Gothic UI / Noto Sans CJK JP). Tofu (empty boxes) = FAIL.
- zh-Hans: Han from PingFang SC / Microsoft YaHei UI / Noto Sans CJK SC. Tofu = FAIL.
- Evidence already in the findings: Linux 8 languages 0 tofu (LINUX-RC-344a88a); Linux ja, de, ru main window and compose without tofu (MAC-LINUX-ba299fd); Linux 1251e86 no tofu. These are one run each on one build: re-check on the SHA under test.

### 2.5 What the session reads about fonts (every row with a font question)

1. `getComputedStyle(el).fontFamily` (the DECLARED stack, the text above). Record it for body and the element in the row. It is not the font in use.
2. The font IN USE: P-ENV `fonts` (canvas width comparison: a name is present when a sample string measures differently from the three generic fallbacks). Record the names that are `true`.
3. `document.fonts.status` and `document.fonts.check(...)`: the app loads NO web fonts, so these answer only "is a web font pending". They are NOT a presence test for an installed font. Record them, but do not use them for PASS.
4. A screenshot named as in 0.6, with the row ID.

### 2.6 New UI strings of 1.0.7 (length in code points, from the i18n files of the branch)

The 32 keys added since 39af592 (src/i18n/ns/*.ts with en, vi, fr blocks; src/i18n/locales/{de,es,ja,ru,zh-Hans}/*.ts). Full table: scratchpad `i18n-lengths.tsv` (QA). The longest and riskiest:

| Key | en | longest (lang: code points) | Where it shows | Row |
|---|---|---|---|---|
| errors.sendRefused | 146 | de: 191 | send failed toast | 2d.09 |
| compose.rcpt.signOnlyHelp | 113 | de: 188 | recipient popover | 2d.09 |
| settings.profile.replyToHint | 95 | fr: 140 | Settings > Accounts, Reply-To hint | 2b.03 |
| updates.toast.mailtoFailedNotCopied | 95 | fr: 122 | toast | 2d.09 |
| compose.toast.draftOriginalGone | 99 | de: 120 | toast after Discard | 2a.02 |
| compose.pic.askConvertGif | 96 | de: 117 | picture prompt | 2d.01 |
| compose.dlg.discardChangesBody | 53 | de: 71 | Discard dialog | 2a.02 |
| compose.pic.askCompress | 76 | de: 88 | picture prompt | 2d.01 |
| compose.sec.theirSignOnly | 63 | de: 96 | send security notice | 2d.09 |
| updates.toast.mailtoFailedCopied | 76 | fr: 110 | toast | 2d.09 |
| compose.table.merge / split | 11 / 10 | fr: 22 / 22 | table tools buttons | 2d.06 |
| compose.emoji.search | 12 | vi: 22 | emoji search placeholder | 2d.07 |
| compose.pic.compress / convert | 8 / 14 | de: 12 / ru: 19 | picture prompt buttons | 2d.01 |
| settings.keys.addCcBcc | 28 | fr: 39 | Settings > Shortcuts row | 2c.03 |
| compose.dlg.discardChanges (button) | 15 | de: 20 | dialog button | 2a.02 |

---

## 3. Probes (bridge `/eval` bodies)

Each probe is the body of an async function (multi-line allowed) that `return`s a JSON string. Paste it as the `js` value of `POST /eval` (the bridge client `scripts/test-bridge-client.mjs` or curl with a JSON-encoded body). Use `timeoutMs` 10000 for P-CSP and P-NOTICE. All probes read the DOM only and change nothing, except P-CSP, which inserts one inert inline script and removes it (it writes `window.__hlCspProbe` only if the script runs).

Probe names used in the rows: P-ENV, P-NOTICE, P-CPHEAD, P-ACT, P-POP, P-ROVE, P-HAS, P-WEEK, P-BLK, P-FRAME, P-PEEK, P-LAY, P-INERT, P-LINK, P-EMO, P-TBL, P-PRS, P-RPL, P-CHIP, P-TXT, P-DARK, P-CSP, P-SITE, P-PLAIN.

### P-ENV (run once per build and per language; record in section 9)

```js
const cs = (p) => { try { return CSS.supports(p); } catch (e) { return 'threw'; } };
const ctx = document.createElement('canvas').getContext('2d');
const sample = 'mmmWWWiil0O@#%\u{1F600}中文日本語Тест tiếng Việt éè';
const width = (font) => { ctx.font = font; return ctx.measureText(sample).width; };
const has = (name) => ['monospace', 'serif', 'sans-serif'].some((g) => width('72px ' + g) !== width('72px "' + name + '", ' + g));
const names = ['Segoe UI Variable Text', 'Segoe UI', 'Helvetica Neue', 'Arial', 'Calibri', 'Carlito', 'Liberation Sans', 'DejaVu Sans', 'Noto Sans', 'Cantarell', 'Cascadia Mono', 'Consolas', 'Menlo', 'Liberation Mono', 'DejaVu Sans Mono', 'Hack', 'Noto Mono', 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', 'PingFang SC', 'Hiragino Sans', 'Noto Sans CJK JP', 'Noto Sans CJK SC', 'Yu Gothic UI', 'Microsoft YaHei UI'];
const fonts = {};
for (const n of names) fonts[n] = has(n);
return JSON.stringify({
  ua: navigator.userAgent, lang: document.documentElement.lang, inner: [innerWidth, innerHeight], dpr: devicePixelRatio,
  dark: matchMedia('(prefers-color-scheme: dark)').matches, dataTheme: document.documentElement.dataset.theme || null,
  css: { lh1: cs('height: 1lh'), colorMix: cs('color: color-mix(in srgb, red, white)'), has: cs('selector(:has(a))'), clampPct: cs('scroll-padding-top: clamp(0px, calc(100% - 75px), 12px)'), scrollPadding: cs('scroll-padding: 1px'), containerInline: cs('container-type: inline-size'), overflowClip: cs('overflow: clip'), backdropFilter: cs('backdrop-filter: blur(3px)'), fontVariantEmoji: cs('font-variant-emoji: text'), contentVisibility: cs('content-visibility: auto') },
  js: { inert: 'inert' in HTMLElement.prototype, popover: 'popover' in HTMLElement.prototype, lookbehind: (() => { try { new RegExp('(?<!E)E'); return true; } catch (e) { return false; } })(), fontBoundingBox: typeof ctx.measureText('x').fontBoundingBoxDescent === 'number', resizeObserver: typeof ResizeObserver },
  fonts, systemUiDiffersFromSansSerif: width('72px system-ui') !== width('72px sans-serif'),
  bodyFontFamily: getComputedStyle(document.body).fontFamily, fontsStatus: document.fonts.status, fontsCheckSystemUi: document.fonts.check('14px system-ui')
});
```

Reading P-ENV: `css.lh1`, `css.has`, `css.colorMix`, `js.inert`, `js.lookbehind`, `js.fontBoundingBox` are the engine answers that decide which fallback a row is looking at. `fonts` is the font in use (section 2.5). `systemUiDiffersFromSansSerif: false` means system-ui is not a distinct font on that machine (note it).

### P-NOTICE (D-023 notice baseline; reuses scripts/lib/baseline-probe.mjs)

Step 1: take the probe string from the branch, not from memory:
`git show 329b41b:scripts/lib/baseline-probe.mjs > baseline-probe.mjs` then in that folder `node --input-type=module -e "import { PROBE_JS } from './baseline-probe.mjs'; console.log(PROBE_JS)"`. Paste the printed IIFE (it installs `window.__baselines`) as the first part of the body; then the tail below.

Step 2 (tail, after the PROBE_JS text, one body):
```js
const root = document.querySelector('.rp-msg-body > .notice:not(.conf-banner)') || document.querySelector('.rp-msg-body .notice:not(.conf-banner)');
if (!root) return JSON.stringify({ error: 'no newsletter notice on screen' });
return JSON.stringify({ lh1: CSS.supports('height: 1lh'), rows: window.__baselines(root) });
```

Reading: `rows[].offset` = baseline of the link minus baseline of the sentence (px). `rows[].h` = click box height. `rows[].lineH` and `refPitch` = the line height the link adds vs a line of text (wrapped links).

### P-CPHEAD (compose header scroll margins and focus; clamp and % check)

```js
const pane = document.querySelector('.compose-pane');
if (!pane) return JSON.stringify({ error: 'no compose pane' });
const head = pane.querySelector('.cp-head'), bar = pane.querySelector('.cp-bar'), fmt = pane.querySelector('.cp-fmt');
const H = head.clientHeight;
const cs = getComputedStyle(head);
const barB = bar.getBoundingClientRect().bottom, fmtT = fmt.getBoundingClientRect().top;
const a = document.activeElement, r = a.getBoundingClientRect();
const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
const hit = document.elementFromPoint(cx, Math.min(Math.max(cy, barB + 1), fmtT - 1));
return JSON.stringify({
  headClientHeight: H, scrollPaddingBottom: cs.scrollPaddingBottom, scrollPaddingTop: cs.scrollPaddingTop,
  expectedBottom: Math.min(12, Math.max(0, H - 75)), expectedTopCompact: Math.min(46, Math.max(42, H - 29)),
  compact: pane.classList.contains('compact') && !pane.classList.contains('bar-wraps'),
  barBottom: Math.round(barB * 10) / 10, fmtTop: Math.round(fmtT * 10) / 10,
  active: a.getAttribute('aria-label') || a.id || a.tagName, activeTop: Math.round(r.top * 10) / 10, activeBottom: Math.round(r.bottom * 10) / 10,
  activeWhole: r.top >= barB - 0.5 && r.bottom <= fmtT + 0.5,
  hitIsActive: !!hit && (hit === a || a.contains(hit))
});
```

Reading (updated after 329b41b): on WKWebView and WebKitGTK the session found `scrollPaddingBottom` / `scrollPaddingTop` come back as the UNRESOLVED clamp() string, so the computed value cannot tell whether the clamp was resolved. clamp() resolution is therefore not observable with this probe, and the scroll-padding values and the expected* fields are informational only. The PASS criteria are the focus numbers only: activeWhole and hitIsActive.

### P-ACT (compose action row: one row, More actions)

```js
const bar = document.querySelector('.compose-pane .cp-bar');
if (!bar) return JSON.stringify({ error: 'no compose action row' });
const btns = [...bar.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0);
const barR = bar.getBoundingClientRect();
const tops = btns.map((b) => b.getBoundingClientRect().top);
const topSpread = Math.round((Math.max(...tops) - Math.min(...tops)) * 10) / 10;
const maxButtonHeight = Math.round(Math.max(...btns.map((b) => b.getBoundingClientRect().height)) * 10) / 10;
const more = bar.querySelector('.rb.more');
const moreShown = !!more && more.getBoundingClientRect().width > 0;
const outside = btns.filter((b) => { const r = b.getBoundingClientRect(); return r.right > barR.right + 0.5 || r.left < barR.left - 0.5; }).map((b) => (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 24));
const clipped = btns.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 24));
return JSON.stringify({ lang: document.documentElement.lang, width: innerWidth, buttons: btns.length, topSpread, maxButtonHeight, oneRow: topSpread <= maxButtonHeight / 2, moreShown, outside, clipped, paneWidth: Math.round(bar.closest('.compose-pane').getBoundingClientRect().width) });
```

### P-POP (every popover and menu box inside the window, and hit-tested)

```js
const SEL = '.popover, .dd-fixed, .menu, .fmt-pop, .suggest, .sched-picker, .fld-pop, [role=dialog], [role=menu], [role=listbox]';
const W = innerWidth, H = innerHeight, out = [];
for (const e of document.querySelectorAll(SEL)) {
  const r = e.getBoundingClientRect(), s = getComputedStyle(e);
  if (r.width <= 0 || r.height <= 0 || s.visibility === 'hidden' || s.display === 'none') continue;
  const px = Math.min(Math.max(r.left + 12, 0), W - 1), py = Math.min(Math.max(r.top + 12, 0), H - 1);
  const hit = document.elementFromPoint(px, py);
  out.push({ cls: String(e.className).slice(0, 36), box: [r.left, r.top, r.right, r.bottom].map((n) => Math.round(n)), inside: r.left >= -0.5 && r.top >= -0.5 && r.right <= W + 0.5 && r.bottom <= H + 0.5, hitInside: !!hit && e.contains(hit) });
}
return JSON.stringify({ viewport: [W, H], boxes: out, outside: out.filter((o) => !o.inside).length, notHit: out.filter((o) => !o.hitInside).length, total: out.length });
```

Open the popover first (click the control), then run P-POP. Repeat per popover listed in the row.

### P-ROVE (picture toolbar: one tab stop, Alt+F10)

```js
const tools = document.querySelector('.img-tools');
if (!tools) return JSON.stringify({ error: 'select a picture in the editor first (no .img-tools)' });
const items = [...tools.querySelectorAll('button, [tabindex]')];
const a = document.activeElement;
let focusVisible = null; try { focusVisible = a.matches(':focus-visible'); } catch (e) { focusVisible = 'n/a'; }
return JSON.stringify({ items: items.length, tabStops: items.filter((b) => b.tabIndex === 0).length, others: items.filter((b) => b.tabIndex === -1).length, activeInTools: tools.contains(a), active: a.getAttribute('aria-label') || a.textContent.trim().slice(0, 24), focusVisible });
```

### P-HAS (the :has() rule for picture handles)

```js
const h = document.querySelector('.pic-handles');
const pin = document.querySelector('.popover.pinned:not(.alt-pop), .suggest.pinned, .dd-fixed');
return JSON.stringify({ hasSupported: CSS.supports('selector(:has(a))'), handlesVisibility: h ? getComputedStyle(h).visibility : 'no handles (no picture selected)', popoverPinned: !!pin, overflow: h ? getComputedStyle(h).overflow : null });
```

### P-WEEK (Calendar Week view: hour height, 19:00 event, 08:00 at the top)

```js
const hours = [...document.querySelectorAll('.wk-hours .wk-hour')];
if (!hours.length) return JSON.stringify({ error: 'open Calendar, Week view first' });
const hr = hours.map((h) => h.getBoundingClientRect());
const ev = [...document.querySelectorAll('.wk-ev')].map((e) => { const r = e.getBoundingClientRect(); return { text: e.textContent.trim().slice(0, 40), top: Math.round(r.top), bottom: Math.round(r.bottom) }; });
return JSON.stringify({ inner: [innerWidth, innerHeight], hourCount: hours.length, hourHeight: Math.round(hr[0].height * 10) / 10, firstHourLabel: hours[0].textContent.trim(), firstHourTop: Math.round(hr[0].top), events: ev, viewportBottom: innerHeight });
```

Expected: hourHeight between 32 and 48 (src/weekHours.ts: HOUR_PX_MIN 32, HOUR_PX_MAX 48); the 19:00 to 20:00 event bottom at or above viewportBottom at 1280 x 800.

### P-BLK (blocked picture boxes inside the mail frame)

```js
const f = document.querySelector('.rp-msg-body iframe');
const d = f && f.contentDocument;
if (!d) return JSON.stringify({ error: 'no message frame, or no same-origin access' });
const boxes = [...d.querySelectorAll('.hl-bp')].map((b) => { const r = b.getBoundingClientRect(), s = getComputedStyle(b); return { w: Math.round(r.width), h: Math.round(r.height), icon: !!b.querySelector('.hl-bp-ico'), alt: ((b.querySelector('.hl-bp-alt') || {}).textContent || '').trim(), bg: s.backgroundColor, border: s.borderTopColor }; });
return JSON.stringify({ frameWidth: Math.round(f.getBoundingClientRect().width), boxes, remainingBlockedImgs: d.querySelectorAll('img[data-hl-blocked]').length });
```

Expected (AC-1.13.2): one box 600 x 200 (or the frame width if narrower, then the same height ratio), alt "Header", icon true; one box 48 x 48, icon true, no alt; the 1 x 1 picture gives no box (ReadingPane.tsx:81-90 removes it). `remainingBlockedImgs` must be 0 only after "Show pictures".

### P-FRAME (the mail frame: sandbox and CSP on WebKit)

```js
const f = document.querySelector('.rp-msg-body iframe');
if (!f) return JSON.stringify({ error: 'no message frame: open a mail with a body' });
const d = f.contentDocument;
const meta = d ? d.querySelector('meta[http-equiv="Content-Security-Policy"]') : null;
return JSON.stringify({ sandbox: f.getAttribute('sandbox'), sameOriginAccess: !!d, frameCspMeta: meta ? meta.getAttribute('content').slice(0, 200) : null, scriptElements: d ? d.querySelectorAll('script').length : null, inlineHandlers: d ? d.querySelectorAll('[onerror],[onload],[onclick]').length : null });
```

Expected: `sandbox` contains allow-same-origin. On WebKit it also contains allow-scripts by design (src/frameSandbox.ts:4-11: WebKit does not run listeners on a frame without it). Then `frameCspMeta` must contain `script-src 'none'` and `scriptElements` and `inlineHandlers` must be 0 (the sanitiser removes them first).

### P-PEEK (side menu peek over the list)

```js
const fp = document.querySelector('.folder-pane'), sf = fp && fp.querySelector('.fp-surface');
if (!sf) return JSON.stringify({ error: 'no side menu in the window' });
const s = getComputedStyle(sf), r = sf.getBoundingClientRect();
const ml = document.querySelector('.msg-list');
const mr = ml ? ml.getBoundingClientRect() : null;
const hit = mr ? document.elementFromPoint(mr.left + 40, mr.top + 60) : null;
const a = document.activeElement;
return JSON.stringify({ peek: fp.classList.contains('is-peek'), rail: fp.classList.contains('is-rail'), position: s.position, zIndex: s.zIndex, width: Math.round(r.width), hitInFolderPane: !!hit && fp.contains(hit), activeInFolderPane: fp.contains(a), active: a.getAttribute('aria-label') || a.textContent.trim().slice(0, 30), inner: [innerWidth, innerHeight] });
```

Expected in a peek (App.css:361): position absolute, zIndex 40, width 248 (plus or minus 2), hitInFolderPane true over the list, focus on the selected folder row after Ctrl+B / Cmd+B.

### P-LAY (list hidden while writing below 1100 px)

```js
const ws = document.querySelector('.workspace'), ml = document.querySelector('.msg-list'), cp = document.querySelector('.compose-pane'), fp = document.querySelector('.folder-pane');
const cpr = cp ? cp.getBoundingClientRect() : null;
return JSON.stringify({ inner: [innerWidth, innerHeight], listHiddenClass: !!ws && ws.classList.contains('list-hidden'), listVisibility: ml ? getComputedStyle(ml).visibility : 'no list', listWidth: ml ? Math.round(ml.getBoundingClientRect().width) : null, composeWidth: cpr ? Math.round(cpr.width) : null, composeLeft: cpr ? Math.round(cpr.left) : null, sideMenuRight: fp ? Math.round(fp.getBoundingClientRect().right) : null });
```

Expected: window 1099 wide: listHiddenClass true while writing; 1100 wide: false (App.tsx threshold and sidebarState.ts:23 AUTO_COLLAPSE_BELOW). Compose width (960 wide, side menu icons) >= 560.

### P-INERT (inert preview, locked compose, hidden file inputs)

```js
const ap = document.querySelector('.ap-preview'), cp = document.querySelector('.compose-pane'), a = document.activeElement;
return JSON.stringify({
  inertSupported: 'inert' in HTMLElement.prototype,
  appearancePreviewInertAttr: ap ? ap.hasAttribute('inert') : 'no preview on screen',
  appearancePreviewInertProp: ap ? (ap.inert === true) : null,
  activeInAppearancePreview: !!ap && ap.contains(a),
  composeInertProp: cp ? (cp.inert === true) : 'no compose pane',
  fileInputsTabbable: [...document.querySelectorAll('input[type=file]')].filter((i) => i.tabIndex >= 0).length,
  active: a.getAttribute('aria-label') || a.textContent.trim().slice(0, 24) || a.tagName
});
```

Expected: inertSupported true (on every engine under test; false means the rows below it FAIL on that engine); appearancePreviewInertProp true; activeInAppearancePreview false after every Tab; fileInputsTabbable 0.

### P-LINK (link dialog, Ctrl/Cmd+K)

```js
const p = document.querySelector('.popover.link-pop');
if (!p) return JSON.stringify({ error: 'open the link dialog (Ctrl or Cmd+K) first' });
const r = p.getBoundingClientRect(), a = document.activeElement;
const fields = [...p.querySelectorAll('.link-pop-field')].map((f) => ({ label: f.textContent.trim().slice(0, 24), top: Math.round(f.getBoundingClientRect().top) }));
const buttons = [...p.querySelectorAll('.link-pop-btns button, .link-pop-btns .btn')].map((b) => b.textContent.trim());
return JSON.stringify({ box: [r.left, r.top, r.right, r.bottom].map((n) => Math.round(n)), inner: [innerWidth, innerHeight], inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, fields, buttons, activeInPopover: p.contains(a), active: a.tagName + ':' + (a.name || a.id || a.getAttribute('aria-label') || '') });
```

Expected (LinkPopover.tsx:166-193): fields[0] (Text to display) above fields[1] (Address): fields[0].top < fields[1].top; buttons ["Cancel", "Insert"] for a new link; inside true; activeInPopover true with Address focused.

### P-EMO (emoji grid: names, size, glyph presence)

```js
const btns = [...document.querySelectorAll('.emoji-grid .emoji-btn')];
if (!btns.length) return JSON.stringify({ error: 'open Insert > Emoji first' });
const s = getComputedStyle(btns[0]);
const first16 = btns.slice(0, 16).map((b) => b.textContent.trim());
const ctx = document.createElement('canvas').getContext('2d');
const w = (font, t) => { ctx.font = font; return ctx.measureText(t).width; };
const glyph = '\u{1F600}', tofu = '￿';
return JSON.stringify({ fontFamily: s.fontFamily, size: [Math.round(btns[0].getBoundingClientRect().width), Math.round(btns[0].getBoundingClientRect().height)], count: btns.length, first16, emptyGlyphs: first16.filter((t) => !t).length, emojiAdvancePx: w('32px ' + s.fontFamily, glyph), tofuAdvancePx: w('32px ' + s.fontFamily, tofu), emojiAdvanceEm: Math.round(w('32px ' + s.fontFamily, glyph) / 32 * 100) / 100, emojiSeparateFromTofu: Math.abs(w('32px ' + s.fontFamily, glyph) - w('32px ' + s.fontFamily, tofu)) > 1 });
```

Expected: size 32 x 32; emptyGlyphs 0; emojiAdvanceEm >= 1.0; emojiSeparateFromTofu true (the emoji advance is not the width of the box a missing glyph gets). Colour and "no tofu" are judged on the screenshot, not on the probe.

Why the old check was removed: the probe used to compare the emoji width in the stack with the width in `monospace`. When the emoji comes from a fallback font, both answers are the same font, so the comparison is always equal and says nothing about presence. The session confirmed colour glyphs and no tofu on Mac and Linux by screenshot (1.0.7 notes, 329b41b). Presence is now read from the advance width and the screenshot only; `monospace` is not a reference.

### P-TBL (merged and split cells in the message editor)

```js
const root = document.querySelector('.compose-pane .tiptap') || document.querySelector('.tiptap');
if (!root) return JSON.stringify({ error: 'no editor' });
const cells = [...root.querySelectorAll('td, th')];
const spans = cells.filter((c) => c.hasAttribute('colspan') || c.hasAttribute('rowspan')).map((c) => ({ text: c.textContent.trim().slice(0, 12), colspan: +(c.getAttribute('colspan') || 1), rowspan: +(c.getAttribute('rowspan') || 1), width: Math.round(c.getBoundingClientRect().width) }));
const selected = root.querySelectorAll('.selectedCell').length;
return JSON.stringify({ cells: cells.length, spans, selectedCells: selected, selectionText: String(getSelection()).slice(0, 40) });
```

Expected after "A1:B1 Merge": one cell with colspan 2 and text "A1 B1"; after "A2:A3 Merge": rowspan 2; while dragging across cells, selectedCells = the cells in the range and selectionText is the cell text only (not a text range across cells).

### P-PRS (pressed states and toggle roles)

```js
const els = [...document.querySelectorAll('[aria-pressed]')].filter((e) => e.getBoundingClientRect().width > 0);
const rows = els.map((e) => ({ name: (e.getAttribute('aria-label') || e.title || e.textContent || '').trim().slice(0, 24), pressed: e.getAttribute('aria-pressed'), bg: getComputedStyle(e).backgroundColor }));
return JSON.stringify({ toggles: rows.length, pressed: rows.filter((r) => r.pressed === 'true').slice(0, 8), notPressed: rows.filter((r) => r.pressed === 'false').slice(0, 8), pressedBg: [...new Set(rows.filter((r) => r.pressed === 'true').map((r) => r.bg))], notPressedBg: [...new Set(rows.filter((r) => r.pressed === 'false').map((r) => r.bg))] });
```

Expected: every visible toggle has aria-pressed true or false; pressedBg differs from notPressedBg (the pressed look is real, not only a name).

### P-RPL (Settings > Accounts > Reply-To field)

How the field is found (SettingsDialog.tsx on origin/release/v1.0.7): `Row` renders `<div class="set-row" id="set-replyTo">` for the Reply-To row; the label is `.set-lbl > div` (first child), the hint `.set-lbl .muted`, the control `.set-ctl`. The input has no id; `Row` sets its aria-label to the label text. The row id, not an input id, is the anchor (the session found no #replyTo: that was the 2nd text input of the mailbox page).

```js
const row = document.getElementById('set-replyTo');
if (!row) return JSON.stringify({ error: 'open Settings > Accounts, the mailbox profile, first (no #set-replyTo row)' });
const inp = row.querySelector('.set-ctl input');
const r = inp.getBoundingClientRect();
const lab = row.querySelector('.set-lbl > div');
const lr = lab ? lab.getBoundingClientRect() : null;
const dlg = row.closest('[role=dialog], .modal, .settings') || document.body;
const dr = dlg.getBoundingClientRect();
const hint = row.querySelector('.set-lbl .muted');
const hr = hint ? hint.getBoundingClientRect() : null;
return JSON.stringify({ inputW: Math.round(r.width), inputH: Math.round(r.height), inputTop: Math.round(r.top), labelBottom: lr ? Math.round(lr.bottom) : null, hintBottom: hr ? Math.round(hr.bottom) : null, dialogRight: Math.round(dr.right), inputRight: Math.round(r.right), dialogOverflowX: dlg.scrollWidth > dlg.clientWidth + 1, lang: document.documentElement.lang });
```

Expected (960 x 560): inputW >= 200; labelBottom <= inputTop + 1 (no overlap); hintBottom <= dialog bottom; inputRight <= dialogRight; dialogOverflowX false.

### P-CHIP (recipient chips are draggable)

```js
const chips = [...document.querySelectorAll('.cp-fields [draggable="true"]')];
return JSON.stringify({ draggableChips: chips.length, labels: chips.slice(0, 8).map((c) => c.textContent.trim().slice(0, 30)) });
```

Expected: a chip in To, Cc and Bcc is draggable (count 2 or more with Cc and Bcc visible). The drag itself is OS input (no bridge endpoint).

### P-TXT (text that does not fit: clipped or overflowing)

```js
const sel = '.compose-pane button, .compose-pane label, [role=dialog] button, [role=dialog] label, .toast, .notice, .link-pop-btns button, .emoji-tab, .fld-pop button, .settings-body button, .settings-body label';
const hits = [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().width > 0 && e.scrollWidth > e.clientWidth + 1).map((e) => ({ t: e.textContent.trim().slice(0, 40), sw: e.scrollWidth, cw: e.clientWidth, ellipsis: getComputedStyle(e).textOverflow === 'ellipsis' }));
return JSON.stringify({ lang: document.documentElement.lang, width: innerWidth, count: hits.length, hits: hits.slice(0, 20) });
```

Expected: `count` 0, or only entries with ellipsis true where the design uses an ellipsis (record them). Every entry is judged in the screenshot.

### P-DARK (dark theme: colour-mix tokens resolve)

```js
const root = getComputedStyle(document.documentElement);
const btn = document.querySelector('.btn.primary, .rb.on, .seg button.on');
const link = document.querySelector('.link');
return JSON.stringify({ prefersDark: matchMedia('(prefers-color-scheme: dark)').matches, dataTheme: document.documentElement.dataset.theme || null, colorScheme: root.colorScheme, accentToken: root.getPropertyValue('--accent').trim(), accentBg: btn ? getComputedStyle(btn).backgroundColor : null, linkColor: link ? getComputedStyle(link).color : null, colorMixSupported: CSS.supports('color: color-mix(in srgb, red, white)') });
```

Expected: accentToken not empty; accentBg not `rgba(0, 0, 0, 0)` when the button is primary; linkColor not transparent. On an engine with colorMixSupported false the accentToken is still a string, but the colours that use it are invalid: that is the FAIL to record.

### P-CSP (CSP is enforced in the app page: async)

```js
const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
let violated = null;
const onViolation = (e) => { violated = e.violatedDirective; };
document.addEventListener('securitypolicyviolation', onViolation);
const s = document.createElement('script');
s.textContent = 'window.__hlCspProbe = 1';
document.head.appendChild(s);
await new Promise((done) => setTimeout(done, 400));
document.removeEventListener('securitypolicyviolation', onViolation);
const ran = window.__hlCspProbe === 1;
s.remove();
return JSON.stringify({ metaCsp: meta ? meta.getAttribute('content').slice(0, 200) : 'no meta CSP in the page (the policy comes from tauri.conf.json)', violatedDirective: violated, inlineScriptRan: ran });
```

Expected: violatedDirective "script-src" (or "script-src-elem") and inlineScriptRan false. If inlineScriptRan is true, the CSP is NOT enforced on that engine: FAIL, P1 (a security control is missing).

### P-SITE (website on Safari only; header targets and fonts)

```js
const items = [...document.querySelectorAll('header a, header button')].map((e) => { const r = e.getBoundingClientRect(); return [(e.textContent.trim() || e.getAttribute('aria-label') || '').slice(0, 16), Math.round(r.width), Math.round(r.height)]; });
const h = document.querySelector('h1');
return JSON.stringify({ inner: [innerWidth, innerHeight], headerTargets: items, h1Font: h ? getComputedStyle(h).fontFamily.slice(0, 120) : null, bodyFont: getComputedStyle(document.body).fontFamily.slice(0, 120), lang: document.documentElement.lang });
```

Expected at 375 px wide: the logo link and every header button 44 x 44 or larger (AC-10.9.1).

### P-PLAIN (plain-text original keeps its spaces, reader side)

```js
const f = document.querySelector('.rp-msg-body iframe');
const root = (f && f.contentDocument) ? f.contentDocument : document;
const el = [...root.querySelectorAll('body *, .rp-msg-body *')].find((e) => getComputedStyle(e).whiteSpace.startsWith('pre') && /\|/.test(e.textContent));
if (!el) return JSON.stringify({ error: 'no pre-wrap element with a | in the open mail' });
const xs = [];
const walker = (el.ownerDocument || document).createTreeWalker(el, NodeFilter.SHOW_TEXT);
let n;
while ((n = walker.nextNode())) {
  let i = n.data.indexOf('|');
  while (i >= 0) { const rg = (el.ownerDocument || document).createRange(); rg.setStart(n, i); rg.setEnd(n, i + 1); xs.push(Math.round(rg.getBoundingClientRect().left * 10) / 10); i = n.data.indexOf('|', i + 1); }
}
return JSON.stringify({ whiteSpace: getComputedStyle(el).whiteSpace, barX: xs, font: getComputedStyle(el).fontFamily.slice(0, 80) });
```

Expected: whiteSpace pre-wrap or pre; the `|` of one column have the same x in every row (within 0.5 px); the blank lines are there (check the screenshot). Note the probe reads inside the frame: the frame has allow-same-origin (P-FRAME).

---

## 4. Work-package tables (one table per WP; status per platform)

Columns: ID | Change (commit, file) | Look at (Mac) | Look at (Linux) | Probe | PASS (numbers) | Mac status | Linux status.

The status cells in this section are the first-draft state (all OPEN). The state after 329b41b is in section 9.1 and overrides them. Evidence so far for every row is Windows or Chromium, unless a row says otherwise. Coder notes say "not verified on macOS/Linux" for all of them.

### 4.1 WP1 (merged: 3589657 and fixes 44354fc, 6246529; UI-FIX1 7737ef3)

| ID | Change (commit, file) | Look at (Mac) | Look at (Linux) | Probe | PASS (numbers) | Mac status | Linux status |
|---|---|---|---|---|---|---|---|
| WK-1.01 | Notice link on the sentence baseline, D-023 (b56ad91; App.css:142-144 `.notice .link` inline-flex, 1lh @supports) | newsletter notice in de and ja, light and dark, at 960 x 560; blocked-pictures banner; the link "Unsubscribe" against the words before it (screenshot) | same, plus KDE HiDPI scale 1.5 (GDK_SCALE) | P-NOTICE, P-ENV (lh1) | every link: abs(offset) <= 1.0 px; sameLine links h >= 24; wrapped link lineH within 1.0 px of refPitch; if lh1 false, record the 4 px fallback values (still must pass offset) | OPEN | OPEN |
| WK-1.02 | Compose header scroll margins: clamp() with % (95ae14e; App.css:517-518) | pop-out at 960 x 480 and 960 x 560, Meeting on; Shift+Tab from To to Where; screenshot after each step | same | P-CPHEAD after each step | activeWhole true and hitIsActive true (scroll-padding values are not a criterion: unresolved clamp() string on WebKit, see P-CPHEAD) | OPEN | OPEN |
| WK-1.03 | Action row: one row, More actions from the end (dda01dd; App.css:523-526, 1211-1219; composeFit.ts; Compose.tsx) | pop-out 960 x 560 in de and ru (AC-1.7.1); main 1280 x 800 in en, de, ru, ja (AC-1.7.2); language switch with compose open (AC-1.7.4) | same, at 1280 x 800 and 960 x 560 | P-ACT, P-TXT | oneRow true in every case (topSpread <= maxButtonHeight / 2: the first and last visible button; the first probe read rowCount 2 from 29 px and 31 px buttons of one row, so a row count is not used); moreShown true when an action is missing from the row; outside []; clipped [] | OPEN | OPEN |
| WK-1.04 | Blocked picture boxes (b0c5d53; blockedPicture.ts; ReadingPane.tsx:81-90 `.hl-bp`) | newsletter fixture: 600 x 200 box (cut to pane width), icon, alt "Header"; 48 x 48 box; 1 x 1 nothing (AC-1.13.2); dark theme box visible, not glaring (AC-1.13.3) | same, on WebKitGTK | P-BLK, P-FRAME | boxes = [600 x 200 or frame-width, icon, alt Header], [48 x 48, icon]; 2 boxes; no box for the 1 x 1; bg differs from the frame background in dark | OPEN | OPEN |
| WK-1.05 | Week view: hour height 32 to 48 px, 08:00 to 20:00 fits (b0c5d53; weekHours.ts; Calendar.tsx:689-690) | 1280 x 800 Week view of next week, event 19:00-20:00 Wednesday (AC-1.13.4); 960 x 560 new event at 15:30 (AC-1.13.5) | same; note D-022 (event bottom 798 of 800: watch) | P-WEEK | hourHeight in [32, 48]; event bottom <= viewportBottom at 1280 x 800; firstHourLabel is 08:00 and firstHourTop inside the header-free area | OPEN | OPEN |
| WK-1.06 | Side menu peek and Ctrl+B / Cmd+B (5b61770; sidebarPeek.ts; App.css:361-362; FolderPane.tsx) | 1000 x 700: Cmd+B opens the full menu over the list; focus on the selected folder; second Cmd+B closes (AC-1.6.1, AC-1.6.6); 1400 x 800: fold and unfold, choice kept after restart (AC-1.6.3) | same with Ctrl+B | P-PEEK | peek true, position absolute, zIndex 40, width 248 +/- 2, hitInFolderPane true, activeInFolderPane true | OPEN | OPEN |
| WK-1.07 | Popover placement (placePopover in popoverRoom.ts:53; ui.tsx:112, 239; LinkPopover.tsx:130; DateTimeFields.tsx:52; qafix4) | pop-out 946 x 480 (logical 960 x 480): Send later date and time pickers ("Today" reachable), More menu, To suggestions, link popover, Emoji and Symbol panels | same; this is the row of the Linux CI failure DRYRUN-838010a-FAIL (findings row 248) | P-POP after each open | outside 0 and notHit 0 for every popover (a toast that covers a box: record the toast); the Today button reachable (box inside) | OPEN | OPEN |
| WK-1.08 | Appearance preview inert, no Tab stop in it (d059187; AppearancePreview.tsx:27; AC-1.14.2) | Settings > Appearance: Tab from the last control above the preview goes to "Shuffle" (AC-1.14.2); click Other / Focused in the preview: nothing changes, arrow pointer (AC-1.14.1) | same | P-INERT after each Tab | inertSupported true; appearancePreviewInertProp true; activeInAppearancePreview false after every Tab | OPEN | OPEN |
| WK-1.09 | Hidden copies and file inputs are not Tab stops (d059187; 6246529; App.css:527; Compose.tsx:2261) | Tab through the compose bar and the attachments: no focus in the hidden measuring copy; no focus on file inputs | same | P-INERT (fileInputsTabbable), P-ACT (active inside .cp-probe never) | fileInputsTabbable 0; no focus stop in .cp-probe | OPEN | OPEN |
| WK-1.10 | Dark theme tokens built with color-mix() (App.css theme block; 62 uses; carried from 1.0.6) | dark theme, Send button, selected row, link colour; screenshot | same | P-DARK, P-ENV (colorMix) | colorMixSupported true; accentBg not transparent; linkColor not transparent; if false: record the visible damage (accent buttons, hover) and the floor | OPEN | OPEN |
| WK-1.11 | Top bar search contrast 4.5:1 with each of 7 accents (b0c5d53; topBarLight.ts) | light theme, each preset accent (Settings > Appearance): placeholder and typed text on the field (AC-1.13.1): colour sampling of the screenshot | same | screenshot only | >= 4.5:1 for the placeholder and typed text in all 7 accents | OPEN | OPEN |
| WK-1.12 | Settings labels say "tray" on Mac (D-019, P3, open; W1.12 changed only the quit question and the Send later picker) | Settings > General: "Keep running in the tray when the window is closed", "Tray icon badge", "Starts minimized to the tray" (screenshot) | N/A (tray is the right word on Linux) | P-TXT, screenshot | recorded as the open P3 D-019; FAIL only if a NEW tray word appears in a Mac string that was changed in 1.0.7 | OPEN (known defect D-019) | N/A |
| WK-1.13 | Quit question on Mac: three buttons fit on one line in 8 languages; Linux keeps the tray wording (W1.12; AC-1.12.4 and AC-1.12.5) | Mac: schedule a message, Cmd+Q: "Cancel", "Keep running in the menu bar", "Quit anyway" each on one line in 8 languages (screenshot de and ru) | Linux: tray Quit with a scheduled message: "Keep running in the tray" wording unchanged (AC-1.12.5) | P-TXT on [role=dialog] | every button height <= 1.5 x line height; P-TXT count 0 | OPEN | OPEN |

### 4.2 WP2a (merged cf70a5a; fixes 329b41b / a956402 / 80035ac)

| ID | Change (commit, file) | Look at (Mac) | Look at (Linux) | Probe | PASS (numbers) | Mac status | Linux status |
|---|---|---|---|---|---|---|---|
| WK-2a.01 | Pop-out compose close by the OS (X, Cmd+W; alt+F4 on Linux). Engine window events differ per WebKit (2d1beaa, 2591620, 852d381) | Cmd+W on an untouched pop-out: window closes, no question (AC-2.2.3); on an edited one: "Save your message?" with Cancel / Save / Discard; Discard: Drafts holds the original only | the same with the window close button of KDE and with alt+F4 (use alt+F4: an earlier xdotool windowclose killed the pop-out, see findings V107-LINUX-ROUND2-DONE) | none (manual; startup.log lines) | untouched: no question, Drafts unchanged; edited: question shown; Discard: one draft with the original text | OPEN | OPEN |
| WK-2a.02 | Discard dialog text and buttons fit (compose.dlg.discardChanges*, W2.2) | German and Japanese at 960 x 560: "Discard your changes?" and "The draft goes back to how it was when you opened it." (AC-2.2.1) | same | P-TXT on [role=dialog] | count 0; buttons one line | OPEN | OPEN |
| WK-2a.03 | Pop-out opened again after close (2d1beaa bridge loop; D-007 was Windows only) | 10 cycles: open the same draft in a pop-out, close it (Cmd+W), open again | 10 cycles: alt+F4, open again | GET /windows after each cycle | 10 of 10 windows open; no "could not be created" line in startup.log | OPEN | OPEN |

### 4.3 WP2b (merged 8908020, e5c1451, 01f13da; 0fba4f1 merge)

| ID | Change (commit, file) | Look at (Mac) | Look at (Linux) | Probe | PASS (numbers) | Mac status | Linux status |
|---|---|---|---|---|---|---|---|
| WK-2b.01 | Plain-text originals keep spaces, indents, blank lines in the reader (e5c1451; AC-2.25.1 reader part) | stub text/plain mail with the ASCII table (fixture 0.3): table aligned; 4-space indent; two blank lines; a tab. Select and copy the text, paste in TextEdit | same, paste in gedit | P-PLAIN | whiteSpace pre-wrap or pre; barX of one column equal within 0.5 px in every row; blank lines visible in the screenshot | OPEN (fixture BLOCKED until 0.3) | OPEN (fixture BLOCKED until 0.3) |
| WK-2b.02 | Chip drag between To, Cc, Bcc (01f13da; Compose.tsx:189-222; custom MIME type CHIP_DRAG; HTML5 drag) | drag the To chip onto Cc with the trackpad (AC-2.21.5): outline while over Cc; then in Cc only; Cc to Bcc; drop on the same field: no change | drag with xdotool mousedown / mousemove / mouseup; same checks; drop onto the Subject field: nothing | P-CHIP (count), manual | one chip in Cc, none left in To; the drop outline shows; no duplicate chip; text of the message unchanged | OPEN | OPEN |
| WK-2b.03 | Reply-To row in Settings > Accounts, 8 languages (01f13da; SettingsDialog.tsx:1183-1184; AC-2.21.6) | 960 x 560 Settings > Accounts, Reply-To in de, ru, ja, vi: label and hint not clipped | same | P-RPL | inputW >= 200; labelBottom <= inputTop + 1; dialogOverflowX false; hintBottom within dialog | OPEN | OPEN |

### 4.4 WP2c (merged 852d381, e75b37c, e690940, 9039afa; merge 3578d19)

| ID | Change (commit, file) | Look at (Mac) | Look at (Linux) | Probe | PASS (numbers) | Mac status | Linux status |
|---|---|---|---|---|---|---|---|
| WK-2c.01 | Message list hidden while writing in a window below 1100 px (9039afa W2.26; App.css `.workspace.list-hidden`; App.tsx:485 and 90; sidebarState.ts:23) | 1099 wide: New mail: list hidden (glides away), compose >= 560 px wide (AC-2.26.1); press Inbox: list next to compose, text kept (AC-2.26.3); Send: list back at its old width; then 1100 wide: list shown | same | P-LAY at 1099 and 1100 | 1099: listHiddenClass true, listVisibility hidden, composeWidth >= 560; 1100: listHiddenClass false | OPEN | OPEN |
| WK-2c.02 | D-012: All-day switch and the Where row stay in the header box when focused (9039afa; App.css `.switch input` 40 x 22 inside the label box; D-012 in defects-107.md) | exact steps: qa-queue-107.md section "D-012 exact retest steps for Mac and Linux" (960 x 480, light and dark, English): Shift+Tab one press at a time from Where to To; after each press P-CPHEAD; screenshot of the All-day stop and the Where stop | same | P-CPHEAD after each press | every focused stop activeWhole true and hitIsActive true; To never above the header box while Where has focus; known remainder (Where below the box until focused) is accepted | OPEN | OPEN |
| WK-2c.03 | Ctrl/Cmd+Shift+K opens the command bar from anywhere (e690940; composeKeys.ts; AC-2.14.1, AC-2.14.4) | Cmd+Shift+K in the body: command bar opens (AC-2.14.1 on Mac); German or Polish layout AltGr+K types its character and opens nothing (AC-2.14.4); Esc: body text unchanged, selection kept | Ctrl+Shift+K same checks (AC-2.14.1 on Linux) | manual (no probe: the command bar's class is not in the spec) | bar opens within 1 s; body text unchanged after Esc; AltGr+K types the character | OPEN | OPEN |

### 4.5 WP2d (merged 3e32e60, 738cfea, 040ecd9, 06dbbf9, b6283be)

| ID | Change (commit, file) | Look at (Mac) | Look at (Linux) | Probe | PASS (numbers) | Mac status | Linux status |
|---|---|---|---|---|---|---|---|
| WK-2d.01 | Picture prompts name the real action; no "1600" in compress / convert prompts; picture toolbar in Settings fits (3e32e60 W2.1, W2.15; compose.pic.*) | add a 1.5 MB JPEG 1200 x 900 with Auto-resize off (AC-2.1.1): prompt "Compress"; press: "Compressed <name>"; 8 languages, de and ru at 960 x 560 not clipped (AC-2.1.6); Settings > Signatures picture: Small, Medium, Large, Original, alignment, link, Alt text, remove (AC-2.15.1, AC-2.15.4) | same; WebKitGTK canvas encoder for the JPEG size | P-TXT; toolbar box inside the dialog from the screenshot | no "1600" in the compress and convert prompts; P-TXT count 0 in de and ru; "Small" makes the picture 120 px wide (+/- 2) | OPEN | OPEN |
| WK-2d.02 | Picture toolbar: one Tab stop, Alt+F10, roving arrows (3e32e60 W2.18; PictureTools.tsx:89, 155 rove, 215 .img-tools) | Full Keyboard Access on (AC-2.18.1): select a picture with Shift+Right, Alt+F10: focus on "Small"; Right moves the sizes; Tab to Align, Link, Alt text, As attachment, Remove; Enter on "Large"; Esc back to the body, picture still selected | Alt+F10 (KDE may take Alt+F10: record the result); arrows as on Mac | P-ROVE after each key | tabStops 1; others = items - 1; Alt+F10 active label "Small"; Esc leaves the toolbar | OPEN | OPEN |
| WK-2d.03 | Picture handles hidden behind a pinned popover (3e32e60; App.css:1009 `body:has(...)`, 1041-1042 `.pic-handles` overflow clip) | picture selected, open the link popover or the More menu: the handles hide (P-HAS: popoverPinned true, handlesVisibility hidden); close it: visible | same | P-HAS | hasSupported true AND handlesVisibility hidden with popoverPinned true; visible without; on an engine with hasSupported false: record the FAIL (handles over the popover) | OPEN | OPEN |
| WK-2d.04 | Link dialog: wording, Esc, focus on Address, Cancel / Insert / Remove link (738cfea W2.16; LinkPopover.tsx:166-193; Ctrl/Cmd+K) | select a word, Cmd+K: title "Insert link", "Text to display" above "Address" (focus in Address), buttons Cancel and Insert (AC-2.16.1); Esc: closes, selection unchanged (AC-2.16.3); Cmd+K on Mac (AC-2.16.3 on Mac) | Ctrl+K same | P-LINK | fields[0].top < fields[1].top; buttons ["Cancel","Insert"]; inside true; activeInPopover true; Esc: no link inserted | OPEN | OPEN |
| WK-2d.05 | Pressed states and check box roles (738cfea W2.20; controls.tsx) | Bold on a selected bold word: "Bold, toggle button, pressed" with VoiceOver (AC-2.20.1); More menu: "Subscript, check box menu item, not checked" (AC-2.20.2); screenshot pressed and not pressed | Orca optional; visual pressed look as on Mac | P-PRS | every visible toggle has aria-pressed; pressedBg differs from notPressedBg (and not transparent) | OPEN | OPEN |
| WK-2d.06 | Table merge and split; outside borders follow the spans; mouse drag selects cells (040ecd9 W2.19; tableCommands.ts; App.css:1022 selectedCell) | insert a 3 x 3 table, type A1..C3, select A1:B1 with the mouse (drag across cells: WebKit drag selection is the risk, AC-2.19.1), Merge; A2:A3 Merge; Split; Save draft, reopen (AC-2.19.3) | same with xdotool drag | P-TBL | after merge: colspan 2, text "A1 B1"; A2:A3: rowspan 2; drag gives selectedCells = cells of the range and selectionText not a multi-cell text range | OPEN | OPEN |
| WK-2d.07 | Emoji picker: search by name and keyword, Recently used, names, Symbol font (06dbbf9 W2.17; insertUi.tsx:521-523; App.css:1058-1061; emojiSearch.ts) | Insert > Emoji: "heart" shows hearts only (AC-2.17.1); "xyz": "No emoji found"; vi "tim" shows hearts; insert 😀 then 👍: reopen, "Recently used" first (AC-2.17.2); VoiceOver reads the CLDR name (AC-2.17.4); Insert > Symbol: © € ™ ★ show as text | Insert > Emoji on KDE: colour glyphs from Noto Color Emoji; no tofu; same checks minus VoiceOver | P-EMO | size 32 x 32; emptyGlyphs 0; emojiAdvanceEm >= 1.0 and emojiSeparateFromTofu true; colour and no tofu on the screenshot (session: confirmed on Mac and Linux) | OPEN | OPEN |
| WK-2d.08 | Paste as plain text: Mac Cmd+Option+Shift+V; Linux Ctrl+Shift+V for an HTML-only clipboard (b6283be W2.24, W2.23; composeKeys.ts; pasteOptions.tsx; clipdecode.rs; lib.rs) | Safari copy of formatted text, Cmd+Option+Shift+V in the body: plain text (AC-2.24.1); Cmd+Option+1 still Heading 1 (AC-2.24.2); Subject field too | xclip -selection clipboard -t text/html -i sample.html; Ctrl+Shift+V in the body: text with lists "1. " and links "text (url)" (AC-2.23.1); no Paste options button | manual; startup.log paste lines | text only; Heading 1 unchanged on Mac; Linux: no formatting. PRECONDITION: the Linux Rust code (clipboard read, gtk 0.18) was never compiled (coder-v107-wp2d.md): the Linux build of 329b41b must compile first; if not built, BLOCKED | OPEN | BLOCKED until the Linux build of 329b41b compiles |
| WK-2d.09 | New 8-language strings do not overflow at 960 x 560 (32 keys, section 2.6; errors.sendRefused, compose.rcpt.signOnlyHelp, settings.profile.replyToHint, updates.toast.mailtoFailedNotCopied, compose.toast.draftOriginalGone, compose.pic.askConvertGif) | the toasts and dialogs of section 2.6 in de, fr, vi, ru, zh-Hans, ja at 960 x 560, light and dark (trigger: send failed with a long server text; recipient popover; Discard dialog; picture prompts; Reply-To hint) | same | P-TXT on each dialog and toast | count 0 for each language; every text complete in the screenshot | OPEN | OPEN |

### 4.6 WP13 (merged a9ff677 W13.1; the W13.5 row is in section 4.10)

| ID | Change (commit, file) | Look at (Mac) | Look at (Linux) | Probe | PASS (numbers) | Mac status | Linux status |
|---|---|---|---|---|---|---|---|
| WK-13.01 | Sending keeps the compose window on screen, locked (inert), with "Sending" and an Undo toast (a9ff677 W13.1; Compose.tsx:601, 2190 `inert={locked}`; AC-13.1.1, AC-13.1.3, AC-13.1.6) | pop-out: To, subject and 3 lines of text; scroll the body; Send: the compose stays with all text; type in the body while locked: no change; Undo at 6 s: editable again, caret in the body, Ctrl+Z undoes the typing before Send; close with X during "Sending... 7 s": window gone, message arrives after the Undo time | same with Ctrl+Z and alt+F4 | P-INERT (composeInertProp) during the lock and after Undo | composeInertProp true during the lock; false after Undo; text identical before and after the lock; inertSupported true (else FAIL on that engine) | OPEN | OPEN |
| WK-13.02 | Undo toast length follows the Undo-send setting; toast does not cover the compose action row (a9ff677; toast stack) | Settings > Composing Undo time 10 s: the toast text and the countdown visible; compose action row not covered | same | P-POP (toast box vs the action row) | the toast box does not overlap .cp-bar; countdown text visible | OPEN | OPEN |

### 4.7 WP10 (site, merged to release via 6a0a5e2; site work WP10a and WP10b; the app does not contain these)

| ID | Change (commit, file) | Look at (Mac) | Look at (Linux) | Probe | PASS (numbers) | Mac status | Linux status |
|---|---|---|---|---|---|---|---|
| WK-10.01 | Phone header: logo link and buttons 44 x 44 (6859695, 28f70fc; AC-10.9.1) | Safari > Develop > Enter Responsive Design at 375 px: header (heylook.namthai.site home page) | optional: a WebKitGTK MiniBrowser (webkit2gtk-driver) if installed; else N/A | P-SITE | logo link 44 x 44 or more; every header button 44 x 44 or more | OPEN | N/A unless MiniBrowser |
| WK-10.02 | Poster srcset: 768 px for phones, 1280 px for wide screens (e87e3ba; AC-10.5.x) | Safari at 375 px and at 1080 px: which poster file loads (Web Inspector: currentSrc) | optional | JS in Web Inspector: document.querySelector('img').currentSrc | currentSrc 768 px file at 375 px; 1280 px file at 1080 px | OPEN | N/A unless MiniBrowser |
| WK-10.03 | Website UI font stack and the hero heading (docs/assets/style.css:6-8; LANG-site-2 "hero descender clipped" was open in findings row 34) | Safari: body font is SF / system-ui; hero heading in en and ja not clipped; line breaks in the header menu at 981 to 1100 px (LANG-site-3) | optional | P-SITE (h1Font, bodyFont), screenshot | no clipped descender in the hero screenshot (g, y, p); header nav one line or wrapped without overlap | OPEN | N/A unless MiniBrowser |

### 4.8 WP-1.0.6 carry-over (engine items still in the code; from coder-v106-*.md "not verified" sections)

| ID | Change (commit, file) | Look at (Mac) | Look at (Linux) | Probe | PASS (numbers) | Mac status | Linux status |
|---|---|---|---|---|---|---|---|
| WK-106.01 | Compose pop-out title bar follows the OS appearance (coder-v106-titlebar*; set_appearance; macOS PASS on 37ae699 in findings row 235 and 244) | 4 windows (main, reader, compose created Dark, compose created Light): switch macOS Light / Dark: all title bars follow (screenshot) | N/A (Linux title bar is the KDE one) | screenshot | all four follow; no mismatch in startup.log | OPEN (regression of 37ae699) | N/A |
| WK-106.02 | Webview default context menu off everywhere (NOTE-CTXMENU, installContextGuard; coder-v106-ctxmenu) | right-click in the message body, compose body, reader window, Subject: only the app menu (no WebKit "Look Up", "Reload", "Inspect Element") | same | manual | no WebKit menu on any of the four places | OPEN | OPEN |
| WK-106.03 | CSP is enforced in the app page (tauri.conf.json CSP; coder-v106-wp1:63 "tauri:// scheme: not verified") | none needed | none needed | P-CSP | violatedDirective script-src; inlineScriptRan false | OPEN | OPEN |
| WK-106.04 | Mail frame on WebKit: sandbox adds allow-scripts; the frame CSP still says script-src none (frameSandbox.ts:4-11) | open a mail with a body (any): frame sandbox and CSP values; a stub mail with `<img src="x" onerror="document.title='X'">` (sanitiser must remove it): the window title stays | same | P-FRAME; manual title check | sandbox has allow-same-origin; frameCspMeta contains script-src 'none'; scriptElements 0; inlineHandlers 0; document.title unchanged | OPEN | OPEN |
| WK-106.05 | Quit paths on Linux (quitwait.rs; SIGTERM/SIGHUP/SIGINT exit path, WP5 decision; coder-v106-linux-quit; D-021 Ctrl+Q does nothing, open P3) | tray Quit with a compose open: quits within 8 s (no question if empty); Ctrl+Q: record (D-021 open) | same; signals: kill -TERM on the pid: quits without a question, draft saved or kept | manual; startup.log quit lines | tray Quit < 8 s; SIGTERM exits without a question; D-021 recorded (not a PASS/FAIL row) | OPEN | OPEN |
| WK-106.06 | Copy buttons: copyToClipboard chain, backend first (11e5862; macclip.rs copy_text; lib.rs Linux path; AC-1.11.1) | "Copy sender email", PGP fingerprint Copy, "View original" Copy: paste into TextEdit, exact text | same: paste into gedit; xclip path | manual; log lines | exact text pasted in both; COPY_FAIL toast only when the clipboard fails | OPEN | OPEN |
| WK-106.07 | Spell check in WebKitGTK is NOT implemented (coder-v106-wp5f REQ-48; AC-73/74 not verified) | misspelled word in the compose body: red underline? (no native menu, expected NO spell check on Mac unless the system does it) | misspelled word: expected no underline | manual | KNOWN GAP (record only; not a FAIL unless the 1.0.7 notes promise it) | N/A (record) | KNOWN GAP (record) |

### 4.9 Fonts (rows for font facts; section 2)

| ID | Change (commit, file) | Look at (Mac) | Look at (Linux) | Probe | PASS (numbers) | Mac status | Linux status |
|---|---|---|---|---|---|---|---|
| WK-F.01 | 8-language glyph coverage in the UI (section 2.4) | main window and compose in ja, zh-Hans, vi, ru, de, fr, es, en at 960 x 560 (screenshots); Han from PingFang SC, kana from Hiragino Sans | same: Han from Noto Sans CJK SC / JP; no tofu | P-ENV (fonts), screenshots | zero tofu boxes in the 8 screenshots; P-ENV fonts for PingFang SC (Mac) and Noto Sans CJK JP / SC (Linux) true | OPEN | OPEN |
| WK-F.02 | Monospace in kbd, code in mail, .original, .pv-text (F4, F5) | Settings > Keyboard shortcuts (kbd), a mail with code (pre): monospace (screenshot); P-ENV: Menlo true | DejaVu Sans Mono or Hack true (P-ENV); pre text monospace | P-ENV, screenshot | a monospace family is used (P-ENV names true for the platform default); no proportional text in kbd | OPEN | OPEN |
| WK-F.03 | Default composed-mail font Calibri 11 and its fallback (F8, F9; fonts.ts; App.css:634) | new message: body text in the editor; P-ENV: Calibri, Carlito, Arial, Liberation Sans, DejaVu Sans; record which renders | same: Carlito and Liberation Sans presence recorded; if only DejaVu Sans renders the body is wider: record the line wraps | P-ENV, screenshot | body text fits (no horizontal clipping) in every case; the rendering family recorded in the row (no number FAIL) | OPEN | OPEN |
| WK-F.04 | system-ui resolves to a distinct desktop font (F1) | Settings screenshot: SF in the UI | Settings screenshot: the KDE font (Noto Sans expected) | P-ENV (systemUiDiffersFromSansSerif, fonts) | recorded; FAIL only if the UI text is in a font with missing glyphs for en or de | OPEN | OPEN |

---

### 4.10 Rows added after the first draft (merged or reported after the first draft; coordinator remarks on 329b41b)

Defect descriptions below are the ones relayed by the coordinator. The detail of each D-entry is in the session notes, which QA could not read. Where the relayed remark gives no platform, the platform column says so; QA does not guess it.

| ID | WP | Change or defect (source) | Look at (Mac) | Look at (Linux) | Probe | PASS (numbers or AC) | Status after 329b41b (session, relayed) |
|---|---|---|---|---|---|---|---|
| WK-13.03 | WP13 | W13.5: a message with only recipients, or nothing in it, is never saved as a draft (2bd22ca, 6efd8ae, 20d9bdd; AC-13.5.1, AC-13.5.7) | type a recipient only, wait 60 s: Drafts unchanged; click another mail: compose closes without a question; kill the app and restart: recovery toast says the message was kept on this computer | same, with kill -9 | manual; Drafts listing of the stub | no APPEND for a recipient-only draft; recovery toast text as AC-13.5.7 | Mac and Linux steps were run on 329b41b; not listed open. Result per the notes (unread by QA). The earlier C4b P2 on a590ee2 (findings V107-MAC-ROUND2-DONE) was the case W13.5 fixes |
| WK-13.04 | WP13 | D-030: scroll position after Undo (W13.1; AC-13.1.3 requires the same scroll position) | pop-out, scroll the body down a little, Send, Undo at 6 s: body scroll position equal to the one before Send | same | manual; screenshot before and after | body scroll position the same before Send and after Undo (plus or minus 2 px) | OPEN: new defect D-030 (platform not relayed) |
| WK-13.05 | WP13 | D-025: large draft freeze threshold (path B table; loading indicator when a big draft opens, W13.7; AC-13.7.1) | open a large draft from Drafts: "Opening draft..." ring within 150 ms; the UI stays responsive; list scrolls | same | manual; the path B table gives the size | ring within 150 ms; no freeze at the sizes in the path B table | OPEN: new defect D-025 (platform not relayed) |
| WK-2c.04 | WP2c | D-034: scheduled row refresh after an edit (e75b37c, W2.10; AC-2.10.1) | Scheduled > Edit, change the text, Schedule: the Scheduled list shows the new text and time at once | same | manual; list screenshot | the row shows the new text and time without reopening | OPEN: new defect D-034 (platform not relayed) |
| WK-2d.10 | WP2d | D-024: Cmd+Option+1/2/3 keyCode path (AC-2.24.2: Cmd+Option+1 still makes Heading 1) | Cmd+Option+1, +2, +3 in the body: Heading 1, 2, 3 | N/A (Mac shortcut) | manual | the three headings applied | FAIL on Mac (D-024), per session |
| WK-2d.11 | WP2d | D-026: Edit menu "Paste and Match Style" (AC-2.24.1: the Edit menu item does the same as Cmd+Option+Shift+V) | copy formatted Safari text; Edit > Paste and Match Style in the body: plain text, as with Cmd+Option+Shift+V | N/A | manual | same result as Cmd+Option+Shift+V | FAIL on Mac (D-026), per session |
| WK-2d.12 | WP2d | D-027: table tools bar position (W2.19; App.css:1036-1037 `.tbl-tools` fixed) | insert a table near the bottom of the window: the tools bar stays inside the window and does not cover the table's header | same | P-POP with `.tbl-tools` added to SEL | the tools bar box inside the viewport; notHit 0 | OPEN: new defect D-027 (platform not relayed) |
| WK-2d.13 | WP2d | D-032: Ctrl+Shift+V with an HTML-only clipboard on Linux (b6283be W2.23; AC-2.23.1) | N/A | xclip -selection clipboard -t text/html -i sample.html; Ctrl+Shift+V in the body: text, no formatting, lists "1. ", links "text (url)" | manual; startup.log paste lines | AC-2.23.1 | FAIL on Linux (D-032), per session; see WK-2d.08 |
| WK-2d.14 | WP2d | D-033: Esc keeps the picture selected (AC-2.18.1: Esc returns to the body, picture still selected) | as WK-2d.02 | Esc after the Alt+F10 toolbar: the picture must stay selected | P-ROVE after Esc (activeInTools false; picture still selected) | AC-2.18.1 | FAIL on Linux (D-033), per session; the WK-2d.02 Linux FAIL |

## 5. Engine gate: rules for reading the results

5.1 A row with `inertSupported`, `css.has`, `css.colorMix`, `css.lh1` false is a FAIL on that engine when the row says the feature must work, and the engine is in the supported range of the floor decision (section 10, Q1). Otherwise it is recorded as "engine below floor: expected".
5.2 A FAIL caused by the engine lacking a feature gets a BUG with severity P1 if the app loses function (e.g. a locked compose accepts typing), P2 if it looks wrong, P3 if it is cosmetic.
5.3 A row can PASS on a fallback (clamp, lh1, :has) only if the fallback's own numbers pass. Record which branch was in effect.
5.4 Mac and Linux results are never inferred from Windows or Chromium evidence.

---

## 6. Excluded from this checklist (non-visual, or covered by another file)

- Backend and logic: W2.2 (Discard of a reopened draft, APPEND/EXPUNGE order), W2.3, W2.4, W2.5, W2.6, W2.7 (signature), W2.8 (header folding), W2.12 (reply key), W2.22 (encrypted drafts), W2.11 (draft open in the pane): tested on Windows and by the stub log (qa-queue-107.md). Mac/Linux steps for these exist in the spec "QA Mac/Linux session" lines and are run by the session with the other rows of its brief.
- W1.3, W1.4, W1.5 (tray and window rules, owned by the WP1 Mac/Linux steps in spec-107-wp1.md), W1.8 and W1.9 (AI, AC-1.8.1 and AC-1.9.x), W1.10 (Show in folder: AC-1.10.x; the Linux row AC-1.10.3 is in spec-107-wp1.md), W1.12 (mailto fallback: AC-1.12.1; the Mac and Linux wording rows are WK-1.13), W1.11 (copy: see WK-106.06).
- W2.23 Linux code path and W2.24 Mac key: WK-2d.08.
- Site legal text, html-validate, sitemap, robots, Lighthouse, the bundle budget (WP9): no visual change.
- Items not merged yet (WP3 Format Painter, WP4 pop-out windows, WP5 PDF inline and Linux dark mode, WP6, WP7 calendar, WP8, WP11, WP12): NOT part of the 1.0.7 head at 329b41b. They get their own checklist rows when they merge.

---

## 7. Coverage map: owner list to rows

| Item asked for | Row(s) |
|---|---|
| notice link baseline (D-023, App.css .notice .link inline-flex) | WK-1.01 |
| compose header scroll-padding clamp() | WK-1.02, WK-2c.02 |
| All-day switch focus (D-012) | WK-2c.02 |
| action row one row + More actions | WK-1.03 |
| blocked picture boxes | WK-1.04 |
| Week view hours | WK-1.05 |
| blocked and popover placement (placePopover) | WK-1.07 |
| inert preview | WK-1.08, WK-1.09 |
| sidebar peek | WK-1.06 |
| picture toolbar roving tab stop and keyboard | WK-2d.02 |
| table merge and split rendering | WK-2d.06 |
| emoji picker (glyph coverage, Noto Color Emoji) | WK-2d.07, WK-F.01 |
| link dialog | WK-2d.04 |
| pressed states | WK-2d.05 |
| resize prompt | WK-2d.01 |
| signature picture handles | WK-2d.03 |
| compose pane width and list hiding below 1100 px | WK-2c.01 |
| Reply-To layout in Settings | WK-2b.03 |
| chip drag in WebKit | WK-2b.02 |
| text overflow of the new 8-language strings | WK-2d.09, WK-1.13, WK-2a.02 |
| engine features (clamp %, scroll-padding %, :has, inert, color-mix, dvh, container queries, ::after) | section 1.3; WK-1.02, WK-2d.03, WK-1.08, WK-13.01, WK-1.10, WK-1.04 (container query rows are the pv/cf labels: record in P-TXT) |
| fonts facts | section 2; WK-F.01 to WK-F.04 |
| 1.0.6 engine items still open | WK-106.01 to WK-106.07 |
| site (WebKit) | WK-10.01 to WK-10.03 |

Note on dvh: the branch uses no dvh/svh/lvh units (0 matches), so there is no row for it; note it so the session does not look for it.

---

## 8. Counts per work package (rows in this file)

| WP | Rows |
|---|---|
| WP1 (incl. UI-FIX1, merged) | 13 |
| WP2a | 3 |
| WP2b | 3 |
| WP2c | 3 |
| WP2d | 9 |
| WP13 (W13.1; W13.5 excluded) | 2 |
| WP10 (site) | 3 |
| WP-1.0.6 carry-over | 7 |
| Fonts | 4 |
| Total, first draft | 47 |
| Added after 329b41b (section 4.10): WP13 +3, WP2c +1, WP2d +5 | 9 |
| Total now | 56 |

---

## 9. Status log (append only; coders and QA add lines; never edit an old line)

| Date | Platform | Row | Result | SHA | Evidence |
|---|---|---|---|---|---|
| 2026-10-19 | (planner) | all | checklist written, nothing run | 329b41b | this file |
| 2026-10-19 | Mac and Linux session | all rows | run on 329b41b; the rows below are the ones it reports open or failed (relayed by the coordinator; the notes are unreadable by QA) | 329b41b | ~/qa-heylook/r10/notes-329b41b-mac.txt, ~/qa-heylook/linux/notes/linux-329b41b.txt (not read by QA) |
| 2026-10-19 | (coder, Windows) | WK-106.02, D-036 | cause found and fixed on Windows (a debug build kept the engine menu everywhere; the frame, labels, ribbon, headers were not guarded; the reader and compose windows had two menu hosts); real WebView2 debug build: base 329b41b 14 of 35 checks fail, this change 0 of 35. Mac and Linux: rows WK-D036.01 to .06 (section 14) replace the WK-106.02 criterion; the Mac Subject case (c) is not explained by the code | e17a949 | coder-v107-ctxmenu-fix.md; E:hey-maile2e-v107-ctxfixesult-base.txt, result-a.txt |

9.1 Status after 329b41b (session remarks as relayed; QA has not verified any of them)

Rows that are still OPEN after 329b41b:

| Row | Platform | Why open (per session) |
|---|---|---|
| WK-1.07 | Mac, Linux | most popovers not confirmed; the rest per the notes |
| WK-1.11 | Mac, Linux | open |
| WK-1.13 | Mac, Linux | open (regression AC-1.12.5 on Linux) |
| WK-2a.02 | Mac, Linux | open |
| WK-2a.03 | Mac, Linux | open |
| WK-2d.03 | Mac, Linux | P-HAS: open (the :has() result is one of the engine questions, section 1.3) |
| WK-2d.09 | Mac, Linux | open (8-language strings) |
| WK-13.02 | Mac, Linux | open |
| WK-106.01 | Mac | open (regression of 37ae699) |
| WK-106.02 | Mac, Linux | open |
| WK-106.05 | Linux | open (D-021 Ctrl+Q; quit paths) |
| WK-106.06 | Mac, Linux | open (copy paths) |
| WK-F.01 | Mac, Linux | open (glyph coverage) |
| WK-F.02 | Mac, Linux | open (monospace) |
| WK-10.01, WK-10.02, WK-10.03 | Safari (Mac) | open: Safari JS checks not done |
| VoiceOver and Orca parts of WK-2d.05 and WK-2d.07 | Mac (VoiceOver), Linux (Orca) | not run |
| WK-1.01, Linux part | Linux | KDE scale 1.5 not run |
| Floor (section 1.4, Q1) | Mac, oldest version | cannot be measured on the Mac the session has; QA cannot measure here |

FAIL rows:

| Row | Platform | Defects |
|---|---|---|
| WK-2d.08 | Mac | FAIL: D-024, D-026 (rows WK-2d.10 and WK-2d.11) |
| WK-2d.08 | Linux | FAIL: D-032 (row WK-2d.13) |
| WK-2d.02 | Linux | FAIL: D-033 (row WK-2d.14) |

New defects, status open on 329b41b (no platform relayed): D-025 (WK-13.05), D-027 (WK-2d.12), D-030 (WK-13.04), D-034 (WK-2c.04).

Not listed as open or failed by the session: the other rows of section 4 that the session ran. Their result is in the notes, which QA has not read. They are NOT PASS here. QA will mark them after reading the notes.

9.2 Probe changes made after the first run (coordinator remarks)

- P-EMO: the monospace comparison (emojiFontFallbackSeen) is removed; it is always equal when the emoji comes from a fallback font. Use the advance width and a screenshot.
- P-RPL: the field is found by the row id `set-replyTo` (see the probe); `labelBottom` now reads `.set-lbl > div`.
- P-ACT: the row count is replaced by a tolerance of half the tallest button height (topSpread, maxButtonHeight, oneRow).
- P-CPHEAD: the scroll-padding values are not a criterion; clamp() resolution is not observable (unresolved string on WKWebView and WebKitGTK). PASS is the focus numbers.
- Section 0.4a: Linux window sizes (logical minus 28 px client height).

---

## 10. Open questions and gaps (for BA, coder and owner)

Q1 macOS floor. tauri.conf.json says 11.0; the build target is Safari 16.4 (macOS 13.3); features need 15.4 to 16.4 (section 1.3). Decide the floor. QA tests the oldest macOS the session has and records its version.
Q2 RegExp lookbehind in src/i18n/format.ts (WEEKDAY_EEE). If the floor stays below 16.4 this is a possible start-up failure (BLOCKER). Needs a decision and a verification on the oldest macOS (P-ENV js.lookbehind). Not verified.
Q3 `inert` without a polyfill (AppearancePreview.tsx:27, Compose.tsx:2190, MessageList.tsx:312). Below Safari 15.5 the preview and the locked compose are focusable and clickable. Decide: floor, or a fallback (aria-hidden plus a pointer-events and tabindex guard).
Q4 `color-mix()` in the theme tokens (62 uses). Below Safari 16.2 the dark accents disappear. Same decision as Q1.
Q5 Drag tests need OS input (no drag endpoint in the bridge kit). Approve xdotool (Linux) and OS input (Mac, MAC-M9 rule) for WK-2b.02, WK-2d.06 and WK-2d.08.
Q6 Rust code that the Linux and Mac sessions depend on was never compiled on its own platform: the Linux block of attachment_reveal (W1.10) and the macOS branch of copy_text (W1.11) (coder-v107-wp1.md, "Not verified"), and the Linux clipboard read of W2.23 (coder-v107-wp2d.md, "Not verified": gtk 0.18 calls written from memory). WK-2d.08 is BLOCKED until a Linux build of the SHA compiles in the VM (or CI platforms=linux is green on that SHA).
Q7 Linux CI runner fonts: the dry run DRYRUN-838010a-FAIL failed in test-popover-fit on the runner's fonts (findings row 248). The runner font list is not recorded. Ask the coder to log `fc-list` (family names) in the Linux CI job so a font-dependent failure can be read.
Q8 Newsletter, plain-text and table fixtures for the real app do not exist in the kit (section 0.3). QA adds them to the stub; rows WK-1.01, WK-1.04, WK-2b.01 stay BLOCKED until they do.
Q9 Calibri and Carlito are not on macOS or Kubuntu by default (section 2.2). The composed-mail body can render in Arial, Liberation Sans or DejaVu Sans, which have different widths. WK-F.03 records the fallback; no fix is asked for by this file.
Q10 The 1.0.7 notes must not promise spell check on WebKitGTK (WK-106.07, coder-v106-wp5f).
Q11 Session notes: the Mac and Linux notes for 329b41b are unreadable from the QA side. Every status in section 9 is a relayed remark until QA reads the notes. The QA marks PASS only after reading them.
Q12 Publishing: this file is a report under E:\hey-mail\reports\v1-0-1\ and stays there. QA does not commit or push reports into the repo (repo hygiene rule). The existing branch origin/qa/webkit-checks-107 (commit 213f5e2, "qa: WebKit and font checks runbook for 1.0.7 (temporary branch, not for merging)", author Nam Thai) was not created or updated by QA, and QA did not touch it. Whoever owns that branch decides what happens to it. The session reads this file from the reports folder.

---

## 11. Probe syntax check (QA, 2026-10-19)

Every probe body in section 3 was parsed as an async function body (no execution). P-NOTICE was checked with the tail only; its head is the PROBE_JS string of scripts/lib/baseline-probe.mjs at 329b41b.


---

## 12. D-025 freeze fix (coder, `feature/v107-freeze-fix`, e11bbb3)

Visible change: one new error sentence, shown in the standard error toast of the Save draft button ("Save draft failed: This message is too large to keep as a draft (128 MB; the limit is 100 MB). Remove attachments or shrink pictures.") in 8 languages. No CSS, layout, font, focus or scroll change. The rest of the change is backend timing, which is engine independent but whose result on the Mac has to be measured (the Mac QA table is in qa-queue-107.md, "D-025").

Engine features relied on: none new. The toast is the existing `.toast` (`width: min(520px, 92vw)` on `.toasts`, `.toast-text { flex:1; min-width:0 }`; `min()` is Safari 11.1+ / WebKitGTK 2.40 fine). No fallback needed.

WK-D025-1 (toast text fits). Trigger: a message whose pictures and files add up to more than 100 MB of base64 text (55 or more pictures of 1.4 MB, or three 30 MB files), Save draft pressed (More actions > Save draft). Language en, de, ja (the long ones), window 960 x 560 and 1280 x 800. Probe (bridge eval, while the toast is on screen; a toast stays about 6 s, run it at once):

```
const t = document.querySelector('.toast .toast-text'); const box = document.querySelector('.toast'); const r = t.getBoundingClientRect(); const lh = parseFloat(getComputedStyle(t).lineHeight); const br = box.getBoundingClientRect(); return { text: t.innerText, lines: Math.round(r.height / lh), textWidth: Math.round(r.width), clipped: t.scrollWidth > t.clientWidth + 1, boxWidth: Math.round(br.width), insideWindow: br.left >= 0 && br.right <= innerWidth && br.bottom <= innerHeight };
```
Pass: `lines` between 2 and 4 (en 3, de 3 to 4, ja 2 to 3), `clipped` false, `boxWidth` <= 520 and <= 0.92 x window width, `insideWindow` true, the text ends with a full stop and is in the language in use. Also on Linux (WebKitGTK) with its fallback fonts: same limits, lines may be one more.

WK-D025-2 (the freeze, not engine-bound but measured per platform). Probe through the bridge while the save of 14 pictures (path B) runs: repeat `POST /eval {"js":"1+1"}` without pause for the duration of the save and record the largest wait; pass: < 500 ms (the one stall at the start of the save is the argument being handed over). `GET /windows` is on another thread and proves nothing. Script in the kit: `E:\hey-mail\e2e-freezefix\tl.mjs` (runs the whole thing on Windows; on the Mac replace the spawn by the Mac binary path and the data folder and run `node tl.mjs <binary> <data dir> 14 1`; it needs an account (any IMAP account, the script takes the first one) and an own PGP key for path B: set both up first).

---

## 13. WP2 fix batch 3 (coder, `feature/v107-wp2-fix3`, head e0b1ad5)

Visible changes and what to look at on a Mac (WKWebView) and on Linux (WebKitGTK). Probes are bridge `eval` bodies (a function body that returns JSON; the page CSP forbids `eval`, so DOM calls only). Nothing here was run on a Mac or Linux. Engine features relied on: `KeyboardEvent.code` and `keyCode` (D-024: prosemirror-keymap's keyCode fallback), `document.elementFromPoint`, `requestAnimationFrame`, `position: fixed`, ProseMirror NodeSelection and the DOM `selectionchange` it reads, `inert` (existing), the Tauri event `mac-paste-match` (D-026); no new CSS feature (no `clamp()`, `:has()`, `color-mix()`, `dvh`, scroll-padding in this batch), so no CSS fallback was needed.

| ID | Platform | Look at | Probe | PASS (numbers) |
|---|---|---|---|---|
| WK-F3.01 (D-024) | Mac | real Cmd+Option+1, 2, 3 in the message body | after each key: `const n = getSelection().anchorNode; const el = n.nodeType === 3 ? n.parentElement : n; const b = el.closest('h1,h2,h3,p'); return JSON.stringify({ tag: b && b.tagName });` | H1, H2, H3; Cmd+Option+4 and Cmd+Option+C: P (unchanged); the Styles menu still lists the keys. Record `event.key` / `code` / `keyCode` of the press (expected `¡`/`Digit1`/49 on a US layout) |
| WK-F3.02 (D-026) | Mac | Edit menu; the key and the menu item with formatted text copied from Safari, in the body and in Subject | after the paste: `return JSON.stringify({ body: document.querySelector('.cp-editor .tiptap').innerText, bold: !!document.querySelector('.cp-editor .tiptap strong, .cp-editor .tiptap b'), button: !!document.querySelector('.paste-opt') });` | item after Paste, text in the app language (de "Einsetzen und Stil anpassen", ja "ペーストしてスタイルを合わせる" ...), not clipped; the text appears exactly once, `bold` false, `button` false |
| WK-F3.03 (D-027) | Mac, Linux | 960x560 and 1280x800, light and dark: new message, a table as the first thing in the body, click a cell; also a table with text above it; also a 30-row table | `const b = document.querySelector('.tbl-tools').getBoundingClientRect(), t = document.querySelector('.cp-editor .tiptap table').getBoundingClientRect(); return JSON.stringify({ bar: { top: b.top, bottom: b.bottom, left: b.left, right: b.right }, table: { top: t.top, bottom: t.bottom }, overlap: Math.max(0, Math.min(b.bottom, t.bottom) - Math.max(b.top, t.top)), win: [innerWidth, innerHeight] });` | `overlap` 0 (<= 0.5 px), `bar.top` >= 0, `bar.bottom` <= `win[1]`, `bar.left` >= 0, `bar.right` <= `win[0]`; first-in-body table: `bar.top` >= `table.bottom - 0.5` |
| WK-F3.04 (D-030) | Linux (Mac regression) | pop-out with 40+ lines, scroll to about 150, Send, Undo | before Send: `return document.querySelector('.cp-editor').scrollTop;` then at 0, 100, 300 and 1000 ms after Undo the same, and `return !!document.activeElement.closest('.ProseMirror');` | all readings within 1 px of the value before Send (Linux before the fix: 150 -> 544); the caret is in the body |
| WK-F3.05 (D-032) | Linux | `xclip -selection clipboard -t text/html -i sample.html` (an ordered list, a link, bold text); Ctrl+Shift+V in the body; then Ctrl+V | `const e = document.querySelector('.cp-editor .tiptap'); return JSON.stringify({ text: e.innerText, strong: !!e.querySelector('strong,b'), list: !!e.querySelector('ol,ul'), button: !!document.querySelector('.paste-opt') });` | after Ctrl+Shift+V: the text once, with "1. " markers and "text (url)" or the link text, `strong` false, `list` false, `button` false; after Ctrl+V of the same clipboard: `list` true. Log: no `read_clipboard_text` error line |
| WK-F3.06 (D-033) | Linux (Mac regression) | select a picture (click or Shift+Right), Alt+F10, Esc, wait 600 ms, Delete | after Esc: `return JSON.stringify({ toolbar: !!document.querySelector('.img-tools'), selected: !!document.querySelector('.cp-editor .tiptap .ProseMirror-selectednode'), inEditor: !!document.activeElement.closest('.ProseMirror') });` then after Delete: `return document.querySelectorAll('.cp-editor .tiptap img').length;` | after Esc: all three true (Linux before: toolbar and selected false); after Delete one picture fewer |
| WK-F3.07 (D-034) | Linux (Mac regression) | Scheduled folder, setting "open in a separate window" on, open a scheduled message, wait until its row says "Paused · editing", close the window with Ctrl+W without a change | poll every 100 ms from the key: `const r = [...document.querySelectorAll('.ml-row.sched')].find(x => x.innerText.includes('SUBJECT')); return r ? /editing/.test(r.innerText) : null;` | `false` within 1000 ms of the key (Windows 264 ms; Linux before the fix: still `true` after 14 s) |
| WK-F3.08 (O-1, D-029) | Mac, Linux | toolbar Discard: hit test, then 1, 3 and 5 presses | `const b = [...document.querySelectorAll('.cp-bar button')].find(x => /^Discard$/.test(x.textContent.trim())); const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return JSON.stringify({ w: r.width, h: r.height, reached: b.contains(hit), dialogs: document.querySelectorAll('[role=alertdialog]').length });` | `reached` true, `w` and `h` >= 24 (icon-only toolbar at 960 px too: about 29 x 32); after any number of presses `dialogs` <= 1 and Drafts on the server unchanged until Discard is answered; after the answer the message is gone and Drafts has one copy fewer |
| WK-F3.09 (D-012, run on Windows by the coder) | Mac, Linux | 960x480, Meeting on (More actions), focus Where, Shift+Tab | `const head = document.querySelector('.cp-head').getBoundingClientRect(), bar = document.querySelector('.cp-bar').getBoundingClientRect(), a = document.activeElement.getBoundingClientRect(), to = document.querySelector('.cf-field.rcpt').getBoundingClientRect(); return JSON.stringify({ active: document.activeElement.closest('label')?.innerText ?? document.activeElement.tagName, actTop: a.top, actBottom: a.bottom, barBottom: bar.bottom, headBottom: head.bottom, toTop: to.top, headTop: head.top, scroll: document.querySelector('.cp-head').scrollTop });` | All day switch focused, `actTop` >= `barBottom` - 0.5 and `actBottom` <= `headBottom` + 0.5, switch box 40 x 22 (Windows). The To field scrolled above the header box (`toTop` < `headTop`) while Where has the focus is the known 77 px band (Windows: toTop 95, headTop 141, scroll 114); report the numbers, no PASS or FAIL on that part |

Fonts: no text of the batch changes length except the Edit menu item (native menu, not measured by DOM) and no CSS changed; the Windows font of the main window is the one recorded in section 6 of the round 3a report.

## 14. D-036 right-click menus (coder, `feature/v107-ctxmenu-fix`, head e17a949)

Visible change: no CSS, layout, font, focus or scroll change. What changes is which menu opens on a right-click: the engine's own (WKWebView: Look Up, Translate, Search with ..., Share, Show Writing Tools, Services, Inspect Element; WebKitGTK: Back, Forward, Reload, Open Frame in New Window, Inspect Element) is now never shown outside a field that takes text. Cause, reproduced on Windows with the base build: the Mac and Linux QA builds are DEBUG builds (test bridge, `HEYLOOK_DATA_DIR`); until now a debug build kept the engine's menu everywhere (for Inspect), so the guard did nothing there: a message in the frame, a folder label, a ribbon button, a header all gave `defaultPrevented` false (that is what the QA measured), and the debug build shows "Inspect Element". A built debug app now has the release rules; `#nativemenu=on` in the page address (set it with a bridge `eval`: `location.hash='#nativemenu=on'`) brings the engine's menu back for Inspect, `location.hash=''` takes it away again. Release builds ignore the switch. Second defect found on the way: the reader window and the compose window mounted a second app-menu host (main.tsx already mounts one), so one right-click opened two stacked menus; removed.

Engine features relied on (no fallback needed unless stated):
- a `contextmenu` event in the document of the sandboxed message frame, and `preventDefault()` on it stopping the engine's menu (WKWebView, WebKitGTK). The listener is added by the PARENT page on `frame.contentDocument`; on WebKit the frame sandbox has `allow-scripts` for exactly this (frameSandbox.ts, BUG-M9), the frame CSP still forbids every script. No script runs in the frame and the sandbox / CSP are unchanged.
- `document.caretRangeFromPoint` (WebKit has it; `caretPositionFromPoint` is the fallback in the code), `Selection.containsNode`, `Range.getClientRects`, `getComputedStyle(el).webkitUserSelect`, `Element.closest(':disabled')`, `MouseEvent` built from the frame's own `defaultView`, `HTMLElement.offsetLeft / offsetTop` (the probe). Not used: `:has()`, `inert`, `clamp()`, `color-mix()`, `dvh`, `scroll-padding`, container queries.
- Fallback: a probe that throws in an engine fails closed: the engine's menu is suppressed (except in a field that takes text) instead of being let through.

Probes (bridge `eval`). All of them in one go: `node scripts/lib/context-menu-probe.mjs <data folder> main` (and `reader-1` for the reader window): three bridge calls, nothing waits inside the page, prints JSON, exit 1 when something is wrong.

P-CTX (that script). Pass: `pass` true; every target with `found` true has `ok` true: `folder label`, `ribbon button`, `reading-pane header`, `settings / dialog text` have `prevented` true; `search box (field)`, `compose Subject (field)`, `compose body (field)` have `prevented` false; `frame.prevented` true, `frame.appMenus` 1, `frame.menuAt` equal to `frame.expectedAt` within 2 px (expected = frame left/top + the event's clientX / clientY), `closed` true. A target that is not on screen says `found` false: open a message first (frame), a compose (fields), Settings (dialog text) and run it again. (It leaves out the top bar on purpose: on a custom-frame window, Windows, a right-click there opens the system's window menu, a modal native menu that blocks the bridge; Mac and Linux have none.)

P-CTX-ONE (the frame alone, one synchronous `eval`):
```
const f = document.querySelector('iframe.msg-frame'); const d = f.contentDocument; const ev = new d.defaultView.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 20, button: 2, view: d.defaultView }); (d.querySelector('p, div, td, span') || d.body).dispatchEvent(ev); const r = f.getBoundingClientRect(); return { prevented: ev.defaultPrevented, frameAt: [Math.round(r.left), Math.round(r.top)], hash: location.hash };
```
and a moment later `return [...document.querySelectorAll('.ctx-menu')].map(m => [m.offsetLeft, m.offsetTop])` must be `[[frameAt[0] + 30, frameAt[1] + 20]]`. Pass: `prevented` true, one menu at that point (with `#nativemenu=on` in `hash`, false is right).

P-CTX-REC (for REAL right-clicks; records and does not prevent, so the engine's menu opens as it would; install it, right-click with the mouse, read it, dismiss the engine's menu with Esc; install it again after opening a message: the frame is a new document each time):
```
window.__rec = []; const rec = (w) => (e) => window.__rec.push({ w, prevented: e.defaultPrevented, trusted: e.isTrusted, tag: e.target.tagName, id: e.target.id, cls: String(e.target.className).slice(0, 30), active: (document.activeElement || {}).tagName, empty: e.target.value === '', x: e.clientX, y: e.clientY }); window.addEventListener('contextmenu', rec('window'), false); for (const f of document.querySelectorAll('iframe.msg-frame')) { try { f.contentDocument.addEventListener('contextmenu', rec('frame'), false); } catch (e) {} } return 1;
```
Read it with `return window.__rec`. `prevented` true: the app stopped the engine's menu (an app menu or nothing opens); false: the engine's own menu opens.

| ID | Change | Look at (Mac) | Look at (Linux) | Probe | PASS (numbers) | Mac status | Linux status |
|---|---|---|---|---|---|---|---|
| WK-D036.01 | message body in the inline reading pane: the guard works in the frame document (D-036 a) | open a mail with text; right-click on a word: only the app menu "Copy" (grey without a selection) and "Select all", at the pointer; NO Look Up, Translate, Search with ..., Share, Writing Tools, Services, Inspect Element. Select a few words, right-click on them: Copy is enabled; paste afterwards gives the same text | same: NO Back, Forward, Stop, Reload, Open Frame in New Window, Inspect Element | P-CTX-ONE, P-CTX (`frame`), P-CTX-REC (real click) | prevented true; 1 app menu; menu within 2 px of the pointer (frame offset included); the menu stays inside the window when the click is near the bottom / right edge | OPEN | OPEN |
| WK-D036.02 | the reader window (`reader-1`): same frame, its own webview | open a mail in its own window (double-click a row); right-click a word and the sender line: ONE app menu (before: two stacked); the sender line has "Copy email address" first | same | P-CTX on `reader-1` (`frame` part and `reading-pane header`), P-CTX-REC | prevented true; `appMenus` 1 (not 2); `menuAt` = `expectedAt` +- 2 px | OPEN | OPEN |
| WK-D036.03 | non-editable text and controls outside the list (D-036 b): folder labels, ribbon buttons, headers, the subject line, Settings text and selects, the dialog backdrop | right-click each: never the WebKit menu; text gives the app's "Copy / Select all", buttons and the backdrop nothing; a mail list row gives its own menu (Open in new window, Reply ...) | same | P-CTX (`folder label`, `ribbon button`, `reading-pane header`, `settings / dialog text`), P-CTX-REC | each `prevented` true | OPEN | OPEN |
| WK-D036.04 | editable fields keep the engine's menu: Subject, To / Cc / Bcc input, compose body (inline compose and the compose window), search box, Settings text inputs (D-036 c) | right-click in each: the native menu opens (Cut, Copy, Paste, Select All, Spelling and Grammar, Substitutions ...). On the Mac try the Subject EMPTY and with text typed in it, focused and not focused, and with Ctrl+click. If NOTHING opens, install P-CTX-REC first and send its JSON (`prevented`, `trusted`, `active`, `empty`): `prevented` false means the app did not touch the event and the missing menu is the engine's | Cut, Copy, Paste, Delete, Select All, Input Methods (no spell check in WebKitGTK, WK-106.07) | P-CTX (`search box`, `compose Subject (field)`, `compose body (field)`), P-CTX-REC | each `prevented` false and the engine's menu shows; `prevented` true on a field would be a defect of the guard | OPEN (the Mac "no menu at all in the Subject" of D-036 c is not explained by the code: Windows shows the menu in the Subject, inline and in the compose window, with the guard on) | OPEN |
| WK-D036.05 | a built debug app has the release rules; `#nativemenu=on` / `=off` | start the QA build with no hash: WK-D036.01 and .03 hold. `location.hash = '#nativemenu=on'`: the engine's menu (with Inspect Element) is back on a label and in the frame; `location.hash = ''`: gone again | same | eval `location.hash`; P-CTX before and after | with `#nativemenu=on` the label's `prevented` is false; without it true | OPEN | OPEN |
| WK-D036.06 | a PDF in the engine's own viewer keeps the engine's menu (`object`, `embed`, the PDF frame are no target of the guard) | attachment preview of a PDF (macOS draws it in an object element): right-click inside the PDF: the viewer's own menu | N/A (no PDF preview on Linux) | eval: `const o = document.createElement('object'); o.type = 'application/pdf'; document.body.appendChild(o); const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); o.dispatchEvent(ev); o.remove(); return ev.defaultPrevented;` | false | OPEN | N/A |

Real right-click steps (Mac: also Ctrl+click, which WKWebView sends as a right-click; Shift+F10 on a selection in the frame still opens the app menu below the selection): WK-D036.01 to .04 with the mouse in light and dark; once with a window narrower than 960 px, and once near the bottom / right edge, so the menu has to flip; once with a mail wide enough that the frame zooms out (P-FRAME): the menu must still open at the pointer.

Windows evidence (real WebView2 debug build, real right-clicks through CDP, no `#nativemenu` switch; base 329b41b against this change): `E:\hey-mail\e2e-v107-ctxfix\result-base.txt` (35 checks, 14 failures: D-036 a and b reproduced on the frame, the reader window, folder label, ribbon, subject line, compose label) and `E:\hey-mail\e2e-v107-ctxfix\result-a.txt` (35 checks, 0 failures). Dev preview, light and dark: `node scripts/test-context-targets.mjs --require-browser` (208 checks).


---

## 15. WP2 fix batch 4 (coder, `feature/v107-wp2-fix4`, head c254f08)

Visible changes and what to look at on a Mac (WKWebView) and on Linux (WebKitGTK). Probes are bridge `eval` bodies (a function body that returns JSON; the page CSP forbids `eval`, so DOM calls only) or scripts under `scripts/lib` that print JSON. Nothing here was run on a Mac or Linux. Engine features relied on: `requestAnimationFrame`, `MessageChannel`, `offsetHeight` as a layout flush, a capture-phase `scroll` listener on the document, `useLayoutEffect` (D-041); real `pointerdown` / `mousedown` / `mouseup` / `contextmenu` events and `document.elementFromPoint` (D-038 probe); the native Edit menu text (D-040); the web view's own inspector (D-037). No CSS, `clamp()`, `:has()`, `inert` (existing), `color-mix()`, `dvh` or scroll-padding was added, so no CSS fallback was needed.

| ID | Platform | Look at | Probe | PASS (numbers) |
|---|---|---|---|---|
| WK-F4.01 (D-038) | Mac (Linux, Windows regression) | open a compose; REAL right-click in the To input: empty, focused, with chips, with text typed, with the suggestion list open; the same in Cc and Bcc (More: Cc / Bcc) and in a compose window; Ctrl+click on a Mac | no click: `node scripts/lib/rcpt-context-probe.mjs <data folder> static`. Then `... arm`, ONE real right-click in the To input, `... read` (script `scripts/lib/rcpt-context-probe.mjs`: records the events of the window in the capture phase and reads `defaultPrevented` afterwards) | `static`: `pass` true (for To, Cc, Bcc: `hitIsInput` true, `disabled` / `readOnly` / `inert` false, `pointerEvents` not `none`). `read`: events `pointerdown`, `mousedown`, `mouseup`, `contextmenu` each once, every `prevented` false, `hit` = `input...`, `appMenus` 0, and the engine's menu (Cut, Copy, Paste, Select All, Spelling ...) opens. If it does not: no event at all = the press did not reach the page (a native layer); `pointerdown` / `mousedown` `prevented` true = a page listener cancelled the press (send the JSON); events without `contextmenu` and nothing prevented = the engine did not send it (send the JSON). On Windows the same recorder runs in `node scripts/test-recipient-menu.mjs` (169 checks) |
| WK-F4.02 (D-039) | Mac, Linux | Scheduled folder, setting "open in a separate window" on, press Edit on a row, look at the main window's row at once, WITHOUT clicking the main window and without waiting | poll every 100 ms from the click: `const r = [...document.querySelectorAll('.ml-row.sched')].find(x => x.innerText.includes('SUBJECT')); return r ? { paused: /editing/.test(r.innerText), label: r.getAttribute('aria-label') } : null;` | `paused` true and the `label` ends with the same text ("Paused · editing", in the app's language) within 3000 ms of the click (owner's limit, every system; the dev preview measures 65 ms: the list is read again by the Edit itself, `node scripts/test-popout-scheduled.mjs` prints the ms; Windows QA r4 measured 23.5 s before the fix, the 30 s timer); then the window's X without a change: `paused` false within 3000 ms (WK-F3.07; dev preview 95 ms, Windows 263 ms). Not a timer: the main window may be covered, App Nap throttles its 30 s refresh |
| WK-F4.03 (D-040) | Mac | Edit menu item after Paste, Spanish (es and es-419) and Russian; compare with the same item in TextEdit set to the same language | not DOM (a native menu item); the strings are pinned by `cargo test --lib paste_and_match_style_reads_like_the_system_item` | es: "Pegar con el mismo estilo"; ru: "Вставить и согласовать стиль" with a NO-BREAK SPACE (U+00A0) after "и"; each identical to TextEdit's item; the item is not clipped. Other 6 languages unchanged |
| WK-F4.04 (D-041) | Linux (Mac regression) | compose window with 40+ lines, scroll to about 150, Send, Undo in the toast: no frame may show another position | before Send run: `const pane = document.querySelector('.compose-pane'), box = document.querySelector('.cp-editor'); window.__drawn = null; const sample = () => requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => { window.__drawn.push([Math.round(performance.now()), box.scrollTop]); if (window.__drawn.length < 40) sample(); }; ch.port2.postMessage(0); }); new MutationObserver(() => { if (!pane.hasAttribute('inert') && !window.__drawn) { window.__drawn = []; sample(); } }).observe(pane, { attributes: true, attributeFilter: ['inert'] }); return box.scrollTop;` then after Undo `return window.__drawn;` | every sample within 1 px of the value before Send (Linux before the fix: 557 in the first 1 to 2 samples, 4 to 36 ms, then 150); the caret is in the body. The Mac "449 once" after selectAll + insertText: that was the set-up (no Send / Undo had run): the engine moves the caret into view while a long text is inserted; if it shows after an Undo, this probe tells |
| WK-F4.05 (D-042) | Linux | `xclip -selection clipboard -t text/html -i sample.html` with `<ol><li>one</li><li>two</li></ol><p>after <a href="https://x.test/">a link</a> and <b>bold</b></p>`, Ctrl+Shift+V in the body | `const e = document.querySelector('.cp-editor .tiptap'); return JSON.stringify({ text: e.innerText, strong: !!e.querySelector('strong,b'), list: !!e.querySelector('ol,ul'), a: !!e.querySelector('a'), button: !!document.querySelector('.paste-opt') });` | "1. one", "2. two", "after a link and bold" once, `strong` / `list` / `a` / `button` false. The address of the link is NOT written (the Keep text only rules, the same words on every system); spec AC-2.23.1 says "text (url)": open question for BA, see the fix-4 report |
| WK-F4.06 (D-043) | Mac | draft opened from Drafts, edited, wait for the autosave ("Draft saved at"), delete the server copy with another IMAP client (STORE +FLAGS (\Deleted), EXPUNGE; or only the flag), press Discard changes | stub `GET /state` (Drafts) and `startup.log`: the lines `[draft ...]` | Drafts holds ONE message that is not flagged `deleted`: the draft as it was opened (before the fix, with the old copy only flagged `deleted` and not expunged: none); no toast "The original version of this draft is no longer available" (that notice is only for "no opened version kept", with the log line "Discard changes found no opened version to put back"); with the draft deleted BEFORE any autosave and Discard changes at once: nothing is written (REQ-2.2.3), Drafts has no copy |
| WK-F4.07 (D-037) | Mac, Linux | right-click in Subject and in the body of a QA build (no `#nativemenu`): the engine's menu has no "Inspect Element"; `startup.log` has `[devtools ...] this QA build makes its windows without the web view inspector`; F12 / Cmd+Option+I do nothing | `grep devtools <data folder>/startup.log` | the log line present; no Inspect Element in the native menus of Subject, body, To; with `HEYLOOK_DEVTOOLS=1` in the environment the line is absent and Inspect Element is back. A RELEASE build has no inspector under any condition (no `devtools` feature in Cargo.toml, pinned by `cargo test --lib a_release_build_has_no_devtools_feature`) |

Fonts: no text changes length in the DOM (the Edit menu items are native).


---

## 15. WP13e Count Other default and unread numbers on the Focused / Other tabs (coder, `feature/v107-wp13e`, head 11e8297)

Rows WK-13.06 to WK-13.08 of `spec-107-wp13e.md` section 6, with the probe and the pass criteria made executable. Nothing here was run on a Mac or Linux; the Windows run (Chromium in the dev preview, `scripts/test-focus-tabs.mjs`, 960 x 480, en / de / ru / ja, light and dark) is the only evidence so far. The Windows widths and wraps do NOT carry over: every number is measured on the machine under test.

Visible changes:
1. A number after the label inside each tab button of the message list (`.pivots button` > `span.fp-badge`, `aria-hidden`): Focused `fp-badge strong` (accent text, weight 650), Other `fp-badge` (muted). `margin-inline-start: 6px`, `font-size: .86em`, `font-variant-numeric: tabular-nums`, inline on the label's baseline. `.pivots` is `flex: none`, the buttons `white-space: nowrap`.
2. The Filter button gives way when the tabs and the whole button do not fit in the header row (width 272 px at the list's minimum of 300): first to its icon only (funnel + caret, the text is visually hidden; `title` and `aria-label` are the full text, for example "Filter: Unread"); when even the icon does not fit beside the tabs (Russian, "99+" on both) the button drops to a line of its own under the tabs, right aligned (`.ml-title.wrap`). The decision is made in the page: `MessageList.tsx` measures two hidden copies of the button (`.ml-filter-probe.full` and `.icon`) and the tab list with `offsetWidth`, `clientWidth` and `getComputedStyle(row).columnGap`, in a `ResizeObserver` and a layout effect (language, Filter text and the numbers re-run it).
3. Preview tabs in Settings > Appearance (`.ap-pivots > span` with the same badge) and its Inbox number.
4. The hint under "Count Other (bulk) mail" in Settings > Notifications & tray is longer in 8 languages (wraps; no fixed height).
5. No other CSS: the side menu numbers are unchanged.

Engine features relied on (no fallback needed unless stated): `ResizeObserver` (Safari 13.1, WebKitGTK 2.26), `Element.offsetWidth`, `getComputedStyle().columnGap` (Safari 14.1 for gap in flex; the value is read as a number and a missing value is 0 = the 8 px gap is not counted, so the Filter may go icon-only one step late: the probe `headOk` shows it), `margin-inline-start` (Safari 12.1), `font-variant-numeric: tabular-nums` (Safari 9.1), `canvas.measureText().fontBoundingBoxDescent` for the probe only (Safari 11.1), `Range.getClientRects`. Not used: `clamp()`, `:has()`, container queries, `inset`, `inert` on the header, `color-mix` (the badge colours are the existing tokens). The visually hidden Filter text uses `clip: rect(0 0 0 0)` (not `clip-path`, not `inset`).

Probe P-TABN (all rows): `node scripts/lib/tab-number-probe.mjs <data folder | test-bridge.json | port:token> [window=main]` (one bridge call, prints the measurements and `problems`, exit 1 on a problem). It needs the Inbox of a mailbox open with Focused Inbox on and no search. Same body for a hand-made `/eval`: `return` + `TABN_JS` from `scripts/lib/tab-number-probe.mjs`. The spec's P-TABN is replaced by this one: the Inbox colour is read from a plain copy of `.fp-badge.strong` (in the icon column of the side menu, below about 1000 px, the real number is a pill with white text, so the spec's `.fp-row.active .fp-badge.strong` gives white there), and the Filter may be below the tabs.

Pass criteria in numbers, per probe run (`problems` is `[]`): `tabsOk` true (the two tabs have the same `top` within 1 px); `rowOk` true or `filterBelow` true; `headOk` true (the header row does not scroll sideways, the Filter lies inside the list box within 0.5 px); each tab: `clipped` false, `labelLines` 1, `sameLine` true, `inside` true, `|offset| <= 1.0` px (badge baseline minus label baseline), `tabular` true (digits 1 and 8 take the same width within 0.5 px), `ratio` 0.86 (+-0.01), `fvn` contains `tabular-nums`; Focused `color` equals `strongColor`, Other `color` equals `mutedColor`; when `filterIcon` is true `filterTitle` equals `filterAria` equals the full Filter text; when false `filterClipped` false.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-13.06 | Mac, Linux | Tab numbers: digits, baseline, colour, one row (W13.12; AC-13.12.16, .17). Stub with 150 unread normal and 120 unread bulk mails in the Inbox of one mailbox (both tabs show 99+); window 960 x 480 and 1280 x 800 (logical, confirm with `/windows`); drag the list Splitter to its minimum (focus it, Left arrow until the width stops); Filter = Unread; languages de, ru, ja, zh-Hans, vi, then fr, es, en; light and dark; screenshot each (name per section 0.6). Linux: also KDE scale 1.5 | P-TABN | `problems` empty in every case; `listW` 300 to 330; record which of the three Filter states shows: text, icon, own line (the Linux and Mac fonts are wider than Segoe, expect icon and own line more often; both are PASS); screenshot: no clipped or overlapping text, the number's baseline matches the label by eye | OPEN |
| WK-13.06b | Mac, Linux | The Filter states move with the width: language en, list wider than 420 px: the text "Filter" shows (`filterIcon` false). Drag the list narrower: the icon alone; in ru at 300 px with 99+ the icon is on its own line. The menu still opens from the icon (Enter, Space, Down arrow) and reads its full name | P-TABN at each stop; VoiceOver / Orca read "Filter: Unread" for the icon button | no flicker (the state changes at most once per width change); the menu opens in every state | OPEN |
| WK-13.06c | Mac, Linux | Live numbers: with the stub, mark a conversation read with the hover button, with the key U, and with the context menu; the number changes at once; Check mail now with a new bulk mail: Other +1 together with the side menu number | read `.pivots [role=tab]` text before and after (`return JSON.stringify([...document.querySelectorAll('.pivots [role=tab]')].map(t => [t.textContent.trim(), t.getAttribute('aria-label'), t.title]))`) | within 300 ms of the click for read / unread; the name is "Focused, N unread", the tooltip "N unread", no name and no tooltip at 0 | OPEN |
| WK-13.07 | Mac, Linux | Count Other default and hint (W13.11; AC-13.11.1, .2, .7). New data folder: Settings > Notifications & tray, the switch is on; Mac Dock badge = all unread conversations including bulk; Linux tray tooltip "Hey Look! - N unread conversations" with the same N. An upgrade folder made by 1.0.6 with `"countOtherMail":false` in `prefs`: after the first start the switch is on and the Dock number (Mac) includes bulk before any sync. The hint under the switch in de, ru, ja, zh-Hans, vi, fr, es, en at 960 x 560 wraps without clipping | P-TXT on the Settings page (section 3); the stored value: `GET /eval` `return (await window.__TAURI_INTERNALS__.invoke('get_setting', { key: 'prefs' }))` (the page can call the command; no store hook in a build) | numbers as in the ACs; P-TXT `count` 0 for the hint; stored `prefs` has `"countOtherMail":true` and `"prefsRev":1` | OPEN |
| WK-13.08 | Mac, Linux | Digits of the tab numbers in the fallback font (font facts section 2; W13.12): P-ENV once per language, then P-TABN; record the resolved family of the number (`tabs[0].family`) | P-ENV, P-TABN | `tabular` true; digits render (no tofu) in every language checked; `family` recorded | OPEN |

Side-menu Inbox number (owner decision, 1.0.7): it leaves out snoozed conversations and mail from blocked senders, like the tray, so Focused + Other equals the Inbox number when Count Other is on and no conversation has unread mail of both kinds. Not engine-bound (a Rust query); QA checks it in AC-13.12.22-style steps on the stub: snooze one unread conversation, the side menu, the tray tooltip and the tab number each drop by 1.


## 16. WP10f Support page without the bank QR (coder, `feature/v107-wp10f`)

Site only (no app UI change in the WebView; the app change is a link address). Rows are for Safari on a Mac and for Epiphany / WebKitGTK on Linux, opened on the static site (`python -m http.server 8710 --directory docs`, then `http://localhost:8710/support.html`, `/de/support.html`, `/ru/support.html`, `/ja/support.html`, `/zh/support.html`), at 375, 960 and 1280 px wide (the responsive design mode of Safari, or a window of that width), light and dark (System Settings / the header theme button).

Probe (any browser): `node scripts/lib/site-support-probe.mjs` prints one JavaScript expression; paste it into the web inspector's console on the Support page. It returns JSON: `bad` (the broken rules, empty = pass), and the numbers `topCols`, `moreCols`, `scrollWidth`, `width`, `linkTopSpread`, `cut`, `outside`, `cardHeights`, `h3Lines`, `buttons`, `minContrast`, `contrast`. Chrome on Windows gave (48 renders: 8 languages x 375 / 960 / 1280 x light / dark): `bad` empty everywhere; `scrollWidth - width` = 0; `cut` 0; `outside` 0; `topCols` 1 / 1 / 2 and `moreCols` 1 / 2 / 4 at 375 / 960 / 1280; `linkTopSpread` 0 at 1280; `minContrast` 6.15 (light) and 7.8 (dark); card height 169 to 266 px; only Russian at 1280 wraps one card heading to 2 lines (`h3Lines` 1,2,1,1).

| ID | Where | What to look at | Probe | Pass criteria (numbers) | Status |
|---|---|---|---|---|---|
| WK-10f.1 | Mac Safari, Linux Epiphany | The Support page in en, de, ru, ja, zh at 375, 960, 1280, light and dark: the letter and the coffee card side by side from 1021 px, stacked below; four cards in 4 / 2 / 1 columns; no text cut; the CJK headings (ja, zh) not clipped; German and Russian card headings may wrap to 2 lines, never overflow | `SUPPORT_PROBE` of `scripts/lib/site-support-probe.mjs` | `bad` is `[]`; `topCols` 2 at 1280 and 1 at 960 / 375; `moreCols` 4 / 2 / 1; `scrollWidth <= width`; `cut` 0; `outside` 0; `linkBottomSpread <= 1` at 1280 (the bottom edges of the four card links; fix batch 6: a link may need two lines under a wider font, then its top is higher, `linkLines` each <= 2); `minContrast >= 4.5`; `h3Lines` each <= 2 | OPEN |
| WK-10f.2 | Mac Safari, Linux Epiphany | Tab from the top: the Ko-fi button, the widget button, the four card links, the two links of the help line each show the focus outline (3 px, `--focus`); the order is the order of the page | `[...document.querySelectorAll('a,button')].map(e => e.textContent.trim())` in Tab order by hand; or `document.activeElement` after each Tab | 7 stops inside `<main>` in the page's order (Ko-fi, widget button when JS is on, GitHub, How to report it, Suggest a better word, heylook.namthai.site, Help and FAQ, what it means); outline visible on each | OPEN |
| WK-10f.3 | Mac Safari (macOS 11 and later), Linux WebKitGTK 2.40+ | The card headings of de and ru hyphenate or wrap instead of overflowing (`hyphens: auto` with `-webkit-hyphens`; the Safari before 17 needs the prefix, the rule has both); `grid-template-columns: minmax(0, 1fr)` columns keep long words inside the card | `[...document.querySelectorAll('.more-ways h3')].map(e => [e.scrollWidth, e.clientWidth])` | `scrollWidth <= clientWidth + 1` for all four, in de and ru at 375 and 1280 | OPEN |
| WK-10f.4 | Mac, Linux | The coffee button row at 960 px: two buttons side by side (a 58 px and a 44 px high one, centred); at 375 px stacked, each full width | `[...document.querySelectorAll('.kofi .btn-row .btn')].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), Math.round(r.top)]; })` | 960 px: the second button's top is above the first one's bottom (same row); 375 px: each button width >= card width - 60 | OPEN |

Engine features relied on: CSS grid with `minmax(0, 1fr)` (Safari 10.1+), flexbox with `margin-top: auto` (Safari 9+), `color-mix()` in the existing dark theme colours (Safari 16.2+; older Safari shows the plain colour of the line before, the page already worked that way), `hyphens: auto` with the `-webkit-` prefix, `clamp()` (existing, Safari 13.1+), `gap` for grid and flex (Safari 14.1+ for flex gap, used by the existing `.btn-row`). Nothing new that macOS 11 (Safari 14 and later) or WebKitGTK 2.40 lacks. No `:has()`, `inert`, `dvh` or container queries are used.

## 17. WP2 fix batch 5 (coder, `feature/v107-wp2-fix5`, head 1b74a83)

Visible changes and what to look at on a Mac (WKWebView) and on Linux (WebKitGTK). Probes are bridge `eval` bodies or scripts under `scripts/lib` that print JSON (`node scripts/lib/<name>.mjs <data folder> main ...`; DOM calls only). **Nothing here was run on a Mac or Linux**; every row is OPEN until a Mac and a Linux session ran it. Windows (WebView2, Chromium 14x) was measured by the coder: numbers in `coder-v107-wp2-fix5.md`.

Engine features relied on: `position: sticky; bottom: 0` with a negative margin for an overlay inside an `overflow-y: auto` box (Safari 13+, WebKitGTK 2.40: fine; where it fails the shade of D-018 simply does not show and nothing else changes), `Element.toggleAttribute` (Safari 13.1+, macOS 10.15.4+; the app needs macOS 11), `querySelector(":scope > .x")`, `ResizeObserver` (already used), React `onFocus` (focusin: fires after the engine scrolled the field into view: the probe says whether it does on WebKit), CSS custom property override (`--cp-body-min`), `aria-busy`, `MutationObserver`, `prefers-reduced-motion` (already used), `crypto.randomUUID` (already used), `String.prototype.replace` with a function on 25 MB strings. No `:has()`, `inert` (new), `dvh`, `clamp()`, `scroll-padding` %, `color-mix` in the new CSS (the shade is `rgba(128, 128, 128, .34)` so that it shows on the light and the dark surface alike; no fallback needed). **No IPC speed was assumed**: the WKWebView / WebKitGTK custom-protocol path may move 25 MB faster or slower than WebView2; the numbers below are limits to record, not predictions.

| ID | Platform | Look at | Probe | PASS (numbers) |
|---|---|---|---|---|
| WK-F5.01 (D-012, D-003) | Mac, Linux | Meeting on (More actions, Meeting) in a new message in the main window at 960x560 (the least window), light and dark; then in a compose window (Ctrl+Shift+O) at 960x480 and 1280x800; focus Where (click), then Shift+Tab to To one press at a time | `node scripts/lib/header-rows-probe.mjs <data folder> main` after each press | main window 960x560: `band` 209 (+-6 for fonts), `focus` whole (`focus.t >= top - 1`, `focus.b <= bottom + 1`, `focus.hit` true), `cut` is `[]` (no row cut by the top of the part that shows), with Where focused `toInSight` true (`band` >= `toNeeded` 182); 960x480 in the main window (CDP/bridge window size only: the least real window is 960x560): `band` 137, `toInSight` false and `to.b <= top` (To wholly above, never half), `cut` `[]`; 1280x800: `scrollH <= clientH + 1` (no scroll), `toInSight` true. The body (`bodyH`) is >= 119 px with Meeting on and >= 179 px without. Record `ua` and the font (`getComputedStyle(document.querySelector('.cf-field input')).fontFamily`) |
| WK-F5.02 (D-018) | Mac, Linux | the same window, Meeting on, header scrolled to the top (a draft or a reply that has the strip; or toggle Meeting off and on): is the lower edge of the header shaded when more is below? at the end of the scroll the shade is gone | the probe: `cueOpacity` and `more`; and look: a 14 px soft grey over the last rows of the box (screenshot of the box edge) | `cueOpacity` "1" and `more` true exactly when `scrollH > clientH + scroll + 1`; "0" and false otherwise; the shade is visible on the light and on the dark surface (the pixel at the box's lower edge differs by >= 4 luminance steps from the one 22 px above, in the left margin). If `position: sticky; bottom: 0` does not show it: record, no other effect |
| WK-F5.03 (D-012 focus scroll) | Mac, Linux | Tab / Shift+Tab through the header at 960x560 with Meeting on (To, Cc, Subject, When date, times, All day, Where) and back; also a click into the When date field while it is half under the Send row | the probe after each stop | after every stop: `focus` whole, `cut` `[]` after 120 ms (the page rests the scroll on a whole row in the same task as the focus and once more in the next frame: if WebKit scrolls after both, `cut` is not empty: record the stop and the delay at which it clears) |
| WK-F5.04 (D-044) | Mac, Linux | a draft of 14 pictures of about 1.4 MB each (the D-025 recipe: Settings > Composing > Resize large pictures automatically off), saved with Encrypt drafts on (Settings > Mailboxes > Security), Drafts folder, then a click on its row | `node scripts/lib/draft-open-probe.mjs <data folder> main "<subject>" 14` | `busyMs` <= 150 (the row is `aria-busy` with a ring in place of its date), `statusMs` <= 150 ("Opening draft…" in the pane, role status) when the open takes longer, `doneMs` <= 2000 on a release build (Windows: about 1000), `gapMax` < 500, `rowAfter.busy` false with the date back. Record `doneMs` and `gapMax` per platform; > 2000 is a finding with the stage times (the Rust side logs nothing: the probe is the measure) |
| WK-F5.05 (D-044, no flash) | Mac, Linux | the same on a small encrypted draft (1 KB) and on a plain one | the probe | `statusMs` null (the status never shows for an open under 100 ms), `busyMs` may be null or small, `doneMs` < 500 |
| WK-F5.06 (D-044 text) | Mac, Linux | the status text in de and ru (the longest: "Entwurf wird geöffnet…", "Открытие черновика…") and ja, in the pane at 960x560 and in a compose window at 560x440; the ring and the dots | `const s = document.querySelector('[role=status][aria-busy=true]'); const p = s.querySelector('p'); const r = document.createRange(); r.selectNodeContents(p); return JSON.stringify({ lines: new Set([...r.getClientRects()].map(x => Math.round(x.top))).size, clipped: p.scrollWidth > p.clientWidth + 1, ring: getComputedStyle(s.querySelector('.busy-ring')).display, dots: getComputedStyle(s.querySelector('.busy-dots')).display, text: p.textContent });` (run while the draft opens; with a delayed open) | `lines` 1, `clipped` false, `ring` not `none` and `dots` `none` (and the other way round with System Settings > Accessibility > Reduce motion on), `text` equals the language's `compose.draft.opening` |
| WK-F5.07 (D-045) | Mac, Linux | Save draft (More actions, Save draft) of the 14-picture draft opened from Drafts | from a second script: `POST /eval {"js":"1+1"}` without pause for the duration of the save, record the largest wait (the script of WK-D025-2 in the kit of the freeze fix) | largest wait < 400 ms (before: 530 ms on Windows; one request of 25 MB held the app's main thread). The Windows coder measured 212 ms at most with the save in 15 requests; on WebKit the uploads (`draft_upload`, 1.8 MB each) are 14 `invoke` calls: if the largest wait is > 400 ms, record the wait per call |

Fonts: the status text is a new string in all 8 languages (agreed with the language specialists: spec-107-wp13.md section 3, row 6; no wording of the coder); it is one short line, centred, `max-width: 34em`, so the check is WK-F5.06. The shade and the 120 px body change no text.

## 18. Fix batch 6 (coder, `feature/v107-fix6`, head 88b09bb): fonts of the Focused / Other tabs, Undo-window numbers, Support card links

Nothing here was run on a Mac or Linux. Windows (Chromium) was measured with the font-stress mode: `node scripts/test-focus-tabs.mjs --require-browser [--full] --font=Verdana [--spacing=0.06] --log` (Verdana is about as wide as DejaVu Sans, the fallback of the GitHub Ubuntu runner and of many Linux desktops; before the fix it reproduced the three CI failures exactly) and `node scripts/test-site-appearance.mjs --only=support --require-browser --font=Verdana --spacing=0.1`. Every number on a Mac or Linux is measured on that machine.

Visible changes:
1. Tabs (`.pivots`): when the two tabs alone are wider than the header row, `MessageList.tsx` sets `--tab-scale` (0.7 to 1) on `.ml-title` and the tab text becomes `calc(1.1em * var(--tab-scale, 1))`; the badge stays 0.86 of the tab text. The gap (18 px), the space before the number (6 px) and the Filter do not scale. `.pivots` has `min-width: 0; max-width: 100%; flex-wrap: wrap`: below the 0.7 floor the second tab would drop to a second line instead of leaving the list. The measurement runs in the layout effect, in a `ResizeObserver` (header, tabs, Filter copies), on `document.fonts` `loadingdone` and `ready`, and on a change of language, Filter text or numbers.
2. Side-menu Inbox number, tab numbers and other folders' unread number drop at the moment a row leaves the list for a delete, archive, move, junk or snooze, and stay down through any refresh in the Undo window; Undo (and the refresh after it) brings them back. The tray and Dock number still change when the move is done.
3. Support page: no visible change; the card links' BOTTOM edges line up (a German or Russian link may need two lines under a wider font and then starts one line higher).

Engine features relied on: `calc()` with a unitless custom property (`1.1em * var(--tab-scale, 1)`: Safari 9.1+), `flex-wrap`, `max-width: 100%`, `document.fonts` with `loadingdone` and `ready` (Safari 10+; the code guards a missing one), `getBoundingClientRect`, `getComputedStyle().columnGap` (Safari 14.1 for gap in flex; read as a number, a missing value counts as 0, so the tabs may scale one step more than needed; the probe shows `headOk`). NOT used: container queries, `clamp()`, `:has()`, `inert`, `lh` units, subgrid. SQL `json_each` is the bundled SQLite (no engine involved).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-F6.01 | Mac, Linux | Tabs with 99+ on both (stub with 150 unread normal and 120 unread bulk mails) at 960 x 480, list dragged to its minimum (300 px), Filter = Unread, languages ru, de, vi, fr, es, ja, zh-Hans, en, light and dark; also KDE scale 1.5 on Linux and a larger system font on Mac | `node scripts/lib/tab-number-probe.mjs <data folder> main`; fields `nums` and `problems` | `problems` `[]`; `nums.rowScroll <= nums.rowClient` (272 at 300 px); `nums.pivotsScroll <= nums.pivotsClient`; both `nums.tabRight` <= `nums.listRight` - 14 + 0.5; `tabsOk` true (one row); every tab `clipped` false, `labelLines` 1, `inside` true; `ratio` 0.86 +-0.01. Record `nums.tabFont` (15.4 px = not scaled; 10.8 to 15.3 px = scaled; never below 10.8) and the Filter state (`filterIcon`, `rowOk`, `filterBelow`). Windows reference: ru 15.4 px, tabs 268 of 272; Verdana ru 13.41 px, tabs 269.1 of 272 | OPEN |
| WK-F6.02 | Mac, Linux | Font loading: switch the language to ru while the list is open, or start with a cold font cache; the tabs fit after the font arrived | the same probe 1 s after the language change, and again after a window resize by 1 px | the same pass criteria both times; `nums.tabFont` the same in both runs | OPEN |
| WK-F6.03 | Mac, Linux | Undo window: Focused tab, delete (key Delete) an unread conversation; the three numbers (side-menu Inbox, Focused, Other) and the row | `JSON.stringify([...document.querySelectorAll('.pivots .fp-badge')].map(b => b.textContent))` before, 300 ms after, 3 s after the key, and after Undo; the side-menu Inbox number by eye | within 300 ms: Focused (Other for a newsletter) and the Inbox number each 1 lower, the other tab unchanged; still 1 lower at 3 s (a Check mail now in between keeps it); after Undo within 1 s numbers and row are back; a read conversation changes nothing | OPEN |
| WK-F6.04 | Mac, Linux | Support page card links (de and ru at 1280 px, light and dark; the other 6 languages too): the four links end on one line, one of them may be two lines high; nothing cut | `node scripts/lib/site-support-probe.mjs` prints the expression to paste into the console | `bad` `[]`; `linkBottomSpread <= 1`; `linkLines` each <= 2 (record the numbers; `linkTopSpread` may be 0 or about one line); `cut` 0; `minContrast >= 4.5` | OPEN |

Fonts: no new text. The tab text may be up to 30 % smaller than normal (10.8 px) in the worst case; report `nums.tabFont` where it is not 15.4 px.

## 19. Fix batch 7 (coder, `feature/v107-fix7`): dark mail shown at once (D-052), notification click opens the mail (D-051), Discard changes after an expunge (D-043)

Nothing here was run on a Mac or Linux. Windows (Chromium) was measured: `node scripts/test-reader-dark.mjs --require-browser`, `node scripts/test-notify-open.mjs --require-browser`, `node scripts/test-discard-expunged.mjs --require-browser`.

Visible changes:
1. **Dark mail, first open (D-052).** The reading pane (and the reader window) now takes the mail document in hand (recolours it, removes the hiding class `hm-pend`, measures it, hooks its clicks) as soon as the frame's document is PARSED (`readyState` "interactive", found by a 15 ms poll in `ReadingPane.tsx`), not at the frame's `load` event. `load` waits for every picture the mail asks for; with "load remote content" on, a slow or dead image host kept the mail hidden (blank) until the picture came or timed out. `load` still runs and measures again. Plus a way out in CSS (`mailCanvas.ts`): `html.hm-pend body` has `animation: hm-show 0s linear 1.5s forwards` (`@keyframes hm-show { to { visibility: visible } }`), so a dark mail whose recolouring never runs shows (in the dark base colours) after 1.5 s instead of staying blank. Screen only; printing is untouched.
2. **Notification click (D-051).** No visible markup change. After a click the list switches to the view that has the mail (mailbox, folder, Focused / Other tab), the row is scrolled into view (`VirtualList` `reveal`, existing), selected, and the reading pane shows it. A mail that is gone shows the existing notice "This message was moved or deleted." as a toast. On Mac and Linux a native notification does not call the app back (shell.rs: only the Windows toast has `on_activated`), so the event is sent from the page for the check (below).
3. **Discard changes before any save (D-043).** No visible change; the backend question is `discard_draft_changes("m:<id>")`; Compose waits at most 6 s for it.

Engine features relied on: `iframe srcdoc` with `contentDocument` readable (`allow-same-origin`; on WebKit the sandbox also has `allow-scripts`, the CSP `script-src 'none'` still forbids scripts), `document.readyState` of a srcdoc document being "interactive" before `load` when a picture is pending (Safari 3+), `window.setTimeout` polling (no timer throttling in a visible window), CSS `animation` of `visibility` with `forwards` fill and a delay of a duration-0 animation (Safari 9+: `visibility` is animatable; the delay with a 0 s duration applies the end value after the delay), `@keyframes` inside `@media screen` (all engines), `@layer` and `color-scheme` (already used, Safari 15.4+ / WebKitGTK 2.38+: not new), `getBoundingClientRect`, `getComputedStyle`. No `:has()`, `inert`, `clamp()`, `dvh` or `color-mix()` is used by the change. If `@layer` is missing (macOS 11 Safari < 15.4) the dark sheet was already inert before this change; the hiding is then released by the failsafe after 1.5 s.

Probes (both print a JSON string; paste into the Web Inspector console, or run through the test bridge `/eval`, scripts/test-bridge.md):
- `node scripts/lib/dark-frame-probe.mjs` prints the expression `darkFrameProbe([27,28,32])` (`... original` for the white background): `{ cls, bodyVis, bodyBg, bodyColor, rs, text, sheets, hmAttr, n, min, rows }`.
- `node scripts/lib/notify-open-probe.mjs <thread id>` prints `notifyEmitJs` (sends the `open-thread` event from the page: `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', ...)`) and `notifyLookJs` (`{ tabs, tab, rowThere, rowSelected, rowInView, rowTop, rowBottom, listTop, listBottom, pane, paneBody, toast }`).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-F7.01 | Mac, Linux | Dark mail first open with a picture that never arrives. Stub IMAP mail (HTML, one paragraph of at least 300 characters and `<img src="http://127.0.0.1:8099/logo.png" width="120" height="40">`), "Load content" ON (Settings > Privacy) or the "Load content" link pressed, mail background button on dark. On the machine run `node -e "require('http').createServer(()=>{}).listen(8099)"` (accepts the request and never answers). Open the mail from the list (first open, not a reload); also in the reader window (double-click the row) | `darkFrameProbe([27,28,32])` at 1 s, 3 s and 10 s after the open; screenshot at 3 s | at 3 s: `cls` has `hm-dark` and no `hm-pend`; `bodyVis` is `visible`; `rs` is `interactive` (the picture is still pending, so the test is meaningful; if it is `complete` the picture failed fast: use a host that does not answer); `text >= 300`; `min >= 4.5`; screenshot shows light text on the dark surface (RGB about 27,28,32), not a blank frame. Same at 10 s. Then press the moon / sun button twice: the third look has the same `rows` as the first (colours, backgrounds) | OPEN |
| WK-F7.02 | Mac, Linux | The failsafe: in the same mail, `d=document.querySelector('.msg-frame').contentDocument; d.documentElement.classList.add('hm-pend'); getComputedStyle(d.body).visibility` | console, then 1.7 s later `getComputedStyle(d.body).visibility`; finally `d.documentElement.classList.remove('hm-pend')` | right after adding: `hidden`; 1.7 s later: `visible` (the animation ended); `getComputedStyle(d.body).animationName` is `hm-show` while the class is on. In print preview (Cmd+P / Ctrl+P): the mail has its original colours and is not hidden | OPEN |
| WK-F7.03 | Mac, Linux | Notification of a bulk mail (stub: a mail with a `List-Unsubscribe` header, so it is in the Other tab), Focused tab open. The event is sent with `notifyEmitJs` (a native notification does not call back on these systems, see above) | `notifyLookJs(id)` 1.5 s after the event | `tab` is `Other`; `rowThere`, `rowSelected`, `rowInView` all true; `pane` is the mail's subject; `paneBody` starts with its text; `toast` empty. The list header shows the Other tab selected and the number of the tab is unchanged except for the unread mail that the open marked read (after the mark-read delay) | OPEN |
| WK-F7.04 | Mac, Linux | The row far down the list: Settings > Appearance > oldest first (or a mailbox with 300+ mails and the notification mail the newest in an oldest-first list), the mail is the last row | `notifyLookJs(id)` | `rowInView` true; `rowBottom <= listBottom + 1` and `rowTop >= listTop - 1` (px); the list has scrolled (read `document.querySelector('.ml-body').scrollTop` before and after: it changed by more than the height of one row) | OPEN |
| WK-F7.05 | Mac, Linux | Other cases through `notifyEmitJs`: a mail of the other mailbox (open mailbox A's Inbox, event for a mail of mailbox B: the side menu shows B's Inbox selected), Focused Inbox off (no tabs: `tabs` is 0), a search typed (the search is cleared, the row is there), the calendar open (the mail comes back), a mail that was deleted on another device and synced (the notice "This message was moved or deleted." appears, nothing opens) | `notifyLookJs(id)` | the same four true values (not for the deleted mail: `toast` contains `moved or deleted`, `pane` is null); `tabs` 0 with Focused Inbox off | OPEN |
| WK-F7.06 | Mac (also Linux) | D-043: Drafts has the draft "D1" (3 drafts). Open it, type a word and press Discard BEFORE the first autosave (the draft must not show "Saved" yet; do it within a couple of seconds, or watch that the stub saw no APPEND), expunge the original on the stub (EXPUNGE) before pressing Discard, then Discard > Discard changes | the Drafts folder list and the log: `grep "Discard changes put the opened version back" <data dir>/startup.log` | Drafts holds 3 drafts again (the original is back, one copy, text without the typed word); no toast; the log has the line `the opened draft was gone from the server, Discard changes put the opened version back`. With the server copy NOT expunged: Drafts still 3 and the log has no such line. The stub's command log has no `APPEND` in that case | OPEN |

Fonts: no new text (the notice is `reading.popout.gone`, already in all 8 languages). The dark mail uses the mail's own fonts; nothing about fonts changed.

## WP10g. Concise website (coder, `feature/v107-wp10g`, head 765b456)

Text-only change of docs/ (website, not the app): the four pages index, features, help and download in 8 languages are much shorter; no CSS, no site script, no new component. Nothing here was run on a Mac or Linux; Windows (Chromium 155) was measured with the numbers in coder-v107-wp10g.md.

Visible changes, what to look at (Mac Safari / WKWebView responsive mode, Linux Epiphany / WebKitGTK; en, ja, de, ru first, then the rest):
1. Home: tour steps with one sentence, a 10-row comparison table without detail lines (cells are now short; table sits in the existing scrolling wrapper), shorter ledger lists (2 + 3 items), calendar scene note one sentence.
2. Features: 9 groups of 1 to 3 items plus 7 limit items; no group tagline; 2-column grid with a grey filler cell where a group has an odd number of items.
3. Help: 17 questions; answers are one paragraph; `#add` open at load.
4. Download: 2 "After you install" cards in a grid that was made for 3; no "All files" table.

Probe (paste into the Web Inspector console of each page; prints JSON; no bridge needed, these are web pages):
```js
(()=>{const o={sw:document.documentElement.scrollWidth,iw:innerWidth,clip:[]};for(const e of document.querySelectorAll('h1,h2,h3,summary,th,td,.btn,li,p,figcaption,caption')){if(getComputedStyle(e).display==='inline'||e.closest('.ticker,.stage,.mk-view,.lang,.sprite'))continue;if(e.clientWidth>0&&e.scrollWidth>e.clientWidth+1)o.clip.push(e.tagName+' '+(e.textContent||'').trim().slice(0,30)+' '+e.scrollWidth+'/'+e.clientWidth);}return JSON.stringify(o)})()
```
On help.html open all questions first: `document.querySelectorAll('details.hq').forEach(d=>d.open=true)`; on download.html `document.querySelectorAll('details').forEach(d=>d.open=true)`.
PASS (numbers), for 375, 960 and 1280 px wide, light and dark (Safari: Develop > Enter Responsive Design Mode; Epiphany: Web Inspector device mode, or resize the window): `sw <= iw` (Windows: sw - iw = 0 on all 96 renders), `clip.length === 0`; no heading, summary, table cell or button text cut at its edge by eye; the comparison table cells of de (right edge 439 px) and ru (400 px) at 375 px scroll sideways inside their wrapper, the page itself does not.
Rows: WK-10g.1 Mac Safari (en, ja, de, index/features/help/download at 1280 and 375); WK-10g.2 Linux WebKitGTK/Epiphany (same pages; fonts there are DejaVu/Noto, wider than the Windows ones: the ceilings of test-site-length leave 2 to 40 % headroom).
Engine features relied on: none new (existing CSS of the site: grid, flex, details/summary, clamp for headings; HTML comments as demo markers). No fallback needed for this change.

## WP10h (feature/v107-wp10h, f7e7dd9): feature-list cells, section number, notifications text

Visible changes, what to look at (Mac Safari / WKWebView responsive mode; Linux Epiphany / WebKitGTK; en, de, ru, ja first, then vi fr zh es), features.html at 375, 600, 700, 960, 1280 px, light and dark, also on a Retina screen (dpr 2) and with browser zoom 110% / 125% (fractional pixels):
1. `.fg-list` cells: no grey box where a group has an odd number of items (9 groups, Limits has 7; 2 columns from 700 px); separators between cells are 1 css px, solid; outer border solid (dashed for Limits); rounded corners 14px; the last short row stays the plain white/dark surface. Done with a per-cell top and left border, `margin: -1px 0 0 -1px` on each li and `overflow: hidden` on the grid; no gap.
2. `.fg-n` (the "01".."09" and the "!" of Limits): its top edge is on the cap line of the first line of the h2 (not centred on heading + lead), also when the h2 wraps to two lines. Done with `align-items: start` plus a top margin from `calc()` of custom properties holding two `clamp()` sizes.
3. Text: Limits, Features tray item, Help list, home ledger and snooze demo no longer say macOS has no notifications (8 languages); check that nothing wraps badly (the lines are shorter, not longer).

Probe (paste in the Web Inspector console of features.html; prints JSON; the one-line expression is `E:\hey-mail\reports\v1-0-1\wp10h-probes\fg-probe-console.js`, it ends with `(false)`; pass `(true)` for the stress run). Output: `{vw, overflowX, grids:[{id,items,cols,rows,emptyCells,ulBg,liBg,ulBorder,gap,liBorderTL,radius}], heads:[{id,h2Lines,h2InkTop,numInkTop,delta,hasLead}]}`.
PASS grid (numbers): for every grid `liBg` = `rgba(0, 0, 0, 0)`, `gap` = `normal/normal`, `liBorderTL` = `1px/1px`, `ulBorder` = `1px solid` (`1px dashed` for id `limits`), `radius` = `14px`, `overflowX` = 0. Lists with `emptyCells > 0` (4 to 5 of them at >= 700 px): the empty area has the same colour as the cells (no grey block). By eye at 400% zoom on a vertical separator: exactly 1 css px (2 device px at dpr 2), no doubled or missing line at the outer edge, no 2px line next to the border.
PASS heads: `abs(delta) <= 2` px for en, de, fr, es, ru, vi at 375, 960, 1280, light and dark (delta = number ink top minus h2 cap top; canvas measureText on the computed font plus a zero-size baseline probe); for zh and ja the first ideograph changes the glyph top: `abs(delta) <= 3` px, and by eye the top of the "01" stroke is level with the top of the heading text; `h2Lines` may be 1 or 2, delta must not change with it. Windows Chrome numbers for comparison: en/de/fr/es/ru/vi -1..+1, zh -2..+2, ja -2..+3 (pixel scan).
Stress (forces wrapping; run once, then reload): `[...document.styleSheets].find(s=>s.href&&/style\.css/.test(s.href)).insertRule('.fgroup h2{max-width:7ch}')` then rerun the probe: `h2Lines` 2 to 4, `delta` unchanged.
Engine features relied on: CSS grid with `repeat(auto-fill, minmax(min(100%, 300px), 1fr))` (already used; `min()` Safari 11.1+), negative margins on grid items, per-side `border-width`, `overflow: hidden` + `border-radius` clip, `calc()` with `clamp()` inside custom properties (Safari 13.1+; macOS 11 Safari 14 and WebKitGTK 2.40 ok), `-webkit-text-stroke`. Nothing newer (no :has, no color-mix, no subgrid, no flex gap, no text-box-trim). Fallback: if an engine rejects the calc(), `.fg-n` gets margin 0 (top-aligned box, ink about 3 px lower on Latin): no overlap.
Known tolerance: the number offset uses a font-metric constant (.33em, tuned on Segoe UI Variable, Arial, Verdana, Tahoma within 1 px). San Francisco (Mac), Helvetica Neue and Noto Sans / DejaVu (Linux) are not measured here: if delta is above 2 px for Latin there, report font, size and delta and the constant is re-tuned. The CJK lift `--fg-lift` (.13, tuned on Microsoft YaHei UI / Yu Gothic UI) must be checked with PingFang SC, Hiragino Sans and Noto Sans CJK.
Rows: WK-10h.1 Mac Safari (en, ja, de, ru; 375, 960, 1280, light and dark, dpr 2); WK-10h.2 Linux WebKitGTK/Epiphany (same; Noto/DejaVu fonts). Status: OPEN until run on the real engines.

## WP10i (feature/v107-wp10i): feature lists always in full rows (2 columns, even counts)

Visible changes, what to look at (Mac Safari / WKWebView responsive mode; Linux Epiphany / WebKitGTK; en, de, ru, ja first), features.html at 375, 600, 639/640 (list width), 700, 960, 1280 px, light and dark, dpr 2:
1. `.fg-list` has exactly 1 column when the list is narrower than 640 px (border box) and exactly 2 from 640 px up; never 3. Every group now has an even count by content (9 groups of 2 cells, Limits 6), so every row is two full cells. Safety net: an odd last item spans both columns (`li:last-child:nth-child(odd) { grid-column: 1 / -1 }`), not used by the shipped content. Separators (1 px per cell top/left line), the grey-free surface, dashed Limits border and 14 px radius are unchanged from WP10h.
2. Text: 6 merged cells, 1 new cell (AI: "Long mail, with Cancel"), Limits "Writing" merged into "Mail, search and writing": check that the longer merged cells do not look cramped and that nothing clips in ja/ru/de (cells grow in height, rows stay level).

Probe (Web Inspector console of features.html; prints JSON array, one entry per list; width = list border-box):
`[...document.querySelectorAll('.fg-list')].map(ul=>{const q=ul.getBoundingClientRect();const rows={};[...ul.children].forEach(e=>{const z=e.getBoundingClientRect();(rows[Math.round(z.top)]??=[]).push(Math.round(z.width))});return {id:ul.closest('section').id,w:Math.round(q.width),items:ul.children.length,perRow:Object.values(rows).map(r=>r.length),widths:Object.values(rows).map(r=>r.join('+')),overflow:ul.scrollWidth-ul.clientWidth,tracks:getComputedStyle(ul).gridTemplateColumns.split(' ').length}})`
PASS (numbers): `items` is even for all 10 lists (2 each, Limits 6); `perRow` is `[1,1,...]` when `w` < 640 and `[2,2,...]` when `w` >= 640 (every row 2, no row 1, never 3); `tracks` = 1 or 2; `overflow` = 0; the two widths of a row differ by at most 1 px. Windows Chrome: 160 list checks per viewport (8 languages x 10 lists x 2 themes), 0 failures at 320, 375, 600, 639, 640, 700, 960, 1280, 1920.
Switch point stress (run once; forces a lone odd cell and a width): `const s=[...document.styleSheets].find(x=>x.href&&/style\.css/.test(x.href));s.insertRule('#limits .fg-list{width:640px;box-sizing:border-box}',s.cssRules.length);document.querySelector('#limits .fg-list').lastElementChild.remove()` then rerun the probe on `limits`: `w` 640, `perRow` `[2,2,1]` and the last width equals `w` (one full-width cell); set the width to 639 and it must be `[1,1,1,1,1]`.
Engine features relied on: CSS grid, `repeat(auto-fill, minmax(min(100%, max(319px, calc(50% - 1px))), 1fr))` (`min()`/`max()` nested with a percentage inside `minmax()`: Safari 11.1+ / macOS 11 Safari 14 ok, WebKitGTK 2.40 ok), `:last-child:nth-child(odd)`, `grid-column: 1 / -1` (the `auto-fill` tracks are explicit, so -1 is the last of them). No container queries, no :has, no subgrid. The width switch is by the grid's own percentage, not by a container query, so there is no fallback to write. Risk to look at: if an engine resolved the percentage inside `minmax()` against 0 the list would show 1 column at all widths (or overflow); the probe shows it as `tracks` = 1 at w >= 640.
Rows: WK-10i.1 Mac Safari (en, ja, de, ru; 375, 640-list, 960, 1280, light and dark, dpr 2); WK-10i.2 Linux WebKitGTK/Epiphany (same). Status: OPEN until run on the real engines.

## 20. Fix batch 8 (coder, `feature/v107-fix8`): Undo scroll in the inline pane (D-053), tab number steady under Reduce motion (D-054), website demo window height

Nothing here was run on a Mac or Linux. Windows (Chromium) was measured: `node scripts/test-compose-restore.mjs --require-browser` (new D-053 cases, fail before / pass after), `node scripts/test-focus-tabs.mjs` in six variants (default, `--full`, `--font=Verdana`, `--font=Verdana --full`, `--spacing=0.04`, `--spacing=0.06`, `--spacing=0.06 --full`) and `node scripts/test-site-appearance.mjs --quick --require-browser` (also `--font=Verdana --lang=de --width=960`).

Visible changes:
1. **Undo after Send, inline pane (D-053).** Send closes the pane next to the list for the Undo time; Undo makes a new pane. The header, body and tail scroll positions at Send are now passed with the message (`ComposeInit.scrolls`) and put back by a layout effect of the new pane (`holdScrolls` in `Compose.tsx`: at once, on every scroll event and on every animation frame for 45 frames, until the person wheels, clicks, touches or presses a key). The window (pop-out) path is unchanged (the same editor stays; D-030 / D-041, 20 frames).
2. **Focused / Other tab numbers (D-054).** One CSS line: `.pivots .fp-badge, .ap-pivots .fp-badge { transition: none }`. Cause: the header fit (`MessageList.tsx`) removes `--tab-scale`, measures the tabs, sets a smaller scale. The badge (`.fp-badge`) had the default `transition-property: all`; under `prefers-reduced-motion` the app sets `transition-duration: .01ms !important`, so the badge kept its old font size for one frame after the scale changed, the measurement differed from run to run and the scale flip-flopped between two steps (0.926 and 0.902 in the Russian 960x480 case) on EVERY frame for ever (a flicker and a constant relayout). The badge size was then 0.84 or 0.88 of the label depending on the frame. It is `.86em` of the tab by construction; the test was right.
3. **Website, "Make it yours" demo (docs/assets/style.css).** At screen widths 820 to 1020 px the demo window is at least `calc(var(--fs) * 13 + 165px)` tall (347 px at 14 px text, 399 px at 18 px) so the folder column (8 rows and the mailbox line, which wraps to two lines in a wide font) is never cut. The phone layout keeps its 250 px (the column is hidden there).

Engine features relied on: `transition: none` (all engines), `@media (prefers-reduced-motion: reduce)` (Safari 10.1+; WebKitGTK follows the GTK setting `gtk-enable-animations`), ResizeObserver (Safari 13.1+), `requestAnimationFrame`, `scrollTop` assignment on an `overflow:auto` element and `scroll` events captured on `document` (all), `calc(var(--fs, 14px) * 13 + 165px)` (a custom property inside `calc()` with a unit multiplied by a number: Safari 9.1+, WebKitGTK 2.40 ok), media query `(min-width: 820px) and (max-width: 1020px)`. No `clamp()`, `:has()`, `inert`, `color-mix` or `dvh` added.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-F8.01 | Mac, Linux (WebKitGTK is where D-030 / D-041 were seen) | D-053: inline pane, Settings > Composing > Undo send time 5 s. New message in the pane (not a window), paste 60 lines (`line 1` ... each its own paragraph), scroll the body to about 150 px with the wheel, press Send, then Undo on the toast | first paste in the Web Inspector console (before Send): `window.__s=[];(function t(){const e=document.querySelector('.cp-editor');window.__s.push(e?Math.round(e.scrollTop):null);window.__r=requestAnimationFrame(t)})(); document.querySelector('.cp-editor').scrollTop` (prints V). After Undo and 2 s: `cancelAnimationFrame(window.__r); JSON.stringify({V, gap: window.__s.indexOf(null), after: window.__s.slice(window.__s.indexOf(null)).filter(x=>x!==null)})` | `gap` > 0 (the pane closed for the Undo time); `after` has more than 20 samples and EVERY sample is within 1 px of V (V about 150); no sample 0 and none far below V (WebKitGTK moved the caret into view in D-030: 544); the caret is in the body, typing works | OPEN |
| WK-F8.02 | Mac, Linux | D-053 with a Cc/Bcc row and a long reply quote: reply to a long mail, scroll the header (`.cp-head`, small window 960x560) and the body, Send, Undo | `JSON.stringify([...document.querySelectorAll('.cp-head,.cp-editor,.cp-tail')].map(e=>[e.className.split(' ')[0],Math.round(e.scrollTop)]))` before Send and 1 s after Undo | the three numbers are equal before and after (2 px tolerance for a body whose quote has pictures that load late) | OPEN |
| WK-F8.03 | Mac, Linux | D-054: Reduce motion ON (macOS: System Settings > Accessibility > Display > Reduce motion; Linux: GNOME Settings > Accessibility > Reduce animation, or `gsettings set org.gnome.desktop.interface enable-animations false`), language Russian, theme any, window 960x560, list width at its minimum (about 300 px), Filter = Unread, Inbox with Focused 150+ and Other 1234 unread (99+ on both tabs) | `JSON.stringify(await new Promise(r=>{const o=[];let n=0;const t=()=>{o.push(document.querySelector('.ml-title').style.getPropertyValue('--tab-scale')+'/'+getComputedStyle(document.querySelector('.pivots button')).fontSize);if(++n<30)requestAnimationFrame(t);else r([...new Set(o)])};t()}))` and through the test bridge `node scripts/lib/tab-number-probe.mjs <data folder>` (prints the measurements and `pass`) | the first prints ONE value (a list of length 1, e.g. `["0.909/13.9986px"]`; before the fix two values alternating); every tab has `ratio` 0.86 +/- 0.01 (badge font size / tab font size), `offset` within 1 px, `sameLine` true, `labelLines` 1, `clipped` false. Repeat with Reduce motion OFF: same | OPEN |
| WK-F8.04 | Mac, Linux | D-054 other languages with extra width: de, fr, es, vi, ja, zh, en at 960x560, list at 300 px, 99+ on both tabs | the same two expressions | length 1 in each language; ratio 0.86 +/- 0.01; no tab on two lines (`labelLines` 1) | OPEN |
| WK-F8.05 | Mac, Linux | Website demo (docs home, section "Make it yours"), browser window 840, 960 and 1020 px wide (Safari: Develop > Enter Responsive Design Mode), languages de, ru, fr, ja, each text size button (12, 14, 16, 18), each density | `(()=>{const a=document.querySelector('.mk-view .app'),f=a.querySelector('.a-folders');return JSON.stringify({vw:innerWidth,app:Math.round(a.getBoundingClientRect().height),fs:getComputedStyle(a).fontSize,sh:f.scrollHeight,ch:f.clientHeight,minH:getComputedStyle(a).minHeight})})()` | `sh` <= `ch` + 1 in every case; at 840 to 1020 px `minH` = 13 x fs + 165 (14 px text: 347 px; 18 px: 399 px); at 375 and 768 px the window is 250 px or more (folder column hidden there, `getComputedStyle(f).display` is `none`); at 1280 px 420 px or more | OPEN |


## 21. Fix batch 9 (coder, `feature/v107-fix9`): macOS Dock badge (D-056), website coffee buttons (D-055), dark mail frame failsafe (WK-F7.02 note)

Nothing here was run on a Mac or Linux. Windows (Chromium) was measured for the site CSS (sweep below); the Dock badge code cannot run on Windows (its Rust logic is unit-tested, the AppKit read-back `macdock.rs` was type-checked for aarch64-apple-darwin in a scratch crate only).

Visible changes:
1. **Dock badge (Mac only).** `shell::update_badge` now hands the `set_badge_label` call to the main thread (`run_on_main_thread`), logs the Result and reads the label back from `NSApp.dockTile.badgeLabel`; it also runs when the page reports ready and when the `prefs` setting is saved. Debug builds with the bridge: `GET /badge`.
2. **Website Support page, coffee card, 481 to 1020 px (docs/assets/style.css).** `.kofi .btn-row` has `margin-right: -8px` (reset to 0 at 480 px and below, where the buttons are stacked): the two buttons stay on one row when their sum (+ 10 px gap) fits within the card's content box + 8 px, else they wrap one per line. The row may reach up to 8 px into the card's 22 px padding.
3. **Dark mail frame (`ReadingPane.tsx`).** A 1.5 s timer in the parent page takes `hm-pend` off the frame if nothing recoloured the mail (the CSS animation `hm-show` stays as a second net). No visible change when the page works.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-F9.01 | Mac (real hardware, the .app via `open -n` with the bridge, debug build with `HEYLOOK_TEST_BRIDGE`) | D-056: Inbox with unread mail, Settings > Notifications & tray > Dock badge = Number. Look at the Dock tile; then mark all read (tile must clear), new mail (number back), Dock badge = None (clear), Number (back). Also read System Settings > Notifications > Hey Look! (is the app listed? is "Badge app icon" on?) | `node scripts/test-bridge-client.mjs <data folder> badge` (or `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/badge`) and `grep '\[badge' startup.log` | JSON `{attempts >= 1, requested: "<unread>", outcome: "set", tile: "<unread>", mainThread: true, platform: "macos"}`; `requested === tile`; at 0 or None `requested: null, tile: null`; log line `dock: label "N" set (on the main thread), tile reads back "N"` (no `DIFFERENT`). Outcomes: `failed: ...` = the call itself failed (the text says why); `set` with `tile === requested` but NO number on the Dock = macOS is hiding the badge (notification setting / permission): report the Notifications panel state, that is the next fix (UNUserNotificationCenter authorisation, needs a signed bundle); `set` with `tile` null/different = AppKit did not keep the label | OPEN |
| WK-F9.02 | Mac Safari (Responsive Design Mode), Linux Epiphany / WebKitGTK | D-055: support page, all 8 languages, widths 481, 560, 600, 640, 700, 760, 960, 1020, light and dark; ja at 700 first (291 + 299 px buttons) | `node scripts/lib/site-support-probe.mjs` prints the expression: paste it in the Web Inspector console of the support page. Result `bad` must be `[]`; `coffeeRow` shows `{inner, sum, wrapped}` | `bad: []`; for every width 481 to 1020: `wrapped === false` whenever `sum <= inner + 7`; when `wrapped === false` the right edge of the second button is >= 12 px from the card's right edge; `scrollWidth <= clientWidth` (no sideways scroll); at <= 480 px the two buttons are stacked full width | OPEN |
| WK-F9.03 | Mac, Linux | WK-F7.02 note: open a mail on the dark background, put the window in the background (Cmd+H / minimise / another app in front) for 2 s and bring it back: the mail is visible, not blank | `(()=>{const d=document.querySelector('.rp-body iframe')?.contentDocument?.documentElement;return JSON.stringify({cls:d&&d.className,vis:d&&getComputedStyle(d.ownerDocument.body).visibility})})()` | `cls` has `hm-dark` and no `hm-pend`; `vis` = `visible`. (The forced path, a mail that nothing recolours, cannot be made without changing the code; this proves the normal path still ends the same way and that the timer does not hide anything.) | OPEN |

Engine features relied on: `NSDockTile.badgeLabel` (all macOS), `run_on_main_thread`; flex-wrap and a negative `margin-right` on a flex container (all engines, no fallback needed); `setTimeout` (all). Nothing newer than Safari 14 / WebKitGTK 2.40.

## 22. WP7a small calendar items and WP7f1 double-click + popover buttons (coder, `feature/v107-wp7f`, head d1a0b6b)

Nothing here was run on a Mac or Linux. Windows (Chromium, WebView2) was measured with real mouse and key events (`node scripts/test-calendar-consent.mjs`, `test-calendar-dblclick.mjs`, `test-event-popover-actions.mjs`, all `--require-browser`, 8 languages, light and dark) and the QA debug build below.
The dev preview (`npm run dev`, mock backend `src/devMock.ts`) is the quickest way to see these on WebKit: open it in Safari (Mac) or Epiphany / a WebKitGTK browser (Linux) at the window sizes of each row, with the hashes named in the row. The probes below are one-line expressions for the Web Inspector console or the test bridge `/eval` (they use DOM calls only). The real app on a Mac or Linux can use the same fakes as the Windows kit (`E:\hey-mail\e2e-v107-wp7\fakes`, Python 3 standard library only; start them with `python3 fake_gcal.py 5191` ...) and the environment variables of `kit.mjs app`.

Visible changes, what to look at:
1. **Question before the browser opens (W7.7).** Settings > a Google or Microsoft mailbox > Calendar: the switch (and Allow access again) opens the app's own question (`.ask`: title, one paragraph, Cancel and Open browser). Dev preview: `#lang=<code>&light` (or `&dark` through Settings > Appearance), Settings > Mailboxes > Nam (Google) > Calendar. Text length is the risk: the body is 140 to 230 characters (de, fr, ru, vi the longest); the two buttons must stay on one row, inside the box, the box inside the window at 960 x 560.
2. **A build without the OAuth client (W7.8).** Dev preview `#calkinds=none`: Settings > mailbox > Calendar shows the switch disabled and one muted sentence under it (`.set-status`); nothing to click.
3. **Failed sender check on the invitation card (W7.3).** RECIPE (one line, fix 11): open `http://127.0.0.1:1420/#lang=en&light&unverified` as a NEW page load (reload after changing the hash: the hash is read once, when the page starts) and click rows 2 to 5 of the Inbox, the four mails whose subject ends "(sender check failed)" (row 1 is an ordinary mail; if they are not on top, type `sender check` into the search box: the same four are the result). Why the Mac QA saw nothing: the mails were there, but before fix 11 they were rows 42 to 48 of the list, below the default invitation mails. Dev preview `#unverified`: the Inbox has four mails ("... (sender check failed)"): a red notice (`.notice.bad`, role alert) with the warning, and for the first three the sentence "Your calendar wasn't changed." and an Apply anyway link button. Risk: 3 to 4 lines of text in a 300 to 400 px card, the link wrapping onto its own line (ja, zh: no spaces).
4. **Custom (W7.2).** Dev preview `#rdate`: Calendar, Agenda, the row "Reading group" tomorrow 16:00: the popover says "Custom" (the repeat line) under the time.
5. **Double-click on an event (W7.10).** Calendar month, week (timed block and all-day chip) and agenda: a double-click opens the edit dialog (title "Edit event"); an invitation or a read-only event shows the popover; empty space makes a new event. Ctrl+Enter (Linux) / Cmd+Enter (Mac) on a focused event does the same. WebKit does not focus a button on a click and a double-click selects a word: the code puts the focus back on the event itself and the agenda rows have `user-select: none`.
6. **Event popover actions (W7.12).** Calendar, click an event: Edit, Duplicate, Save .ics, Delete are buttons with an icon and a label (no More menu); Delete red and last; a second row for the actions (the answer buttons and Join are the first row of an invitation). Fonts: fr "Enregistrer le fichier .ics", de, ru are the wide ones: the actions may wrap to two lines (three is a failure). The popover never reaches past the window: at a low window its details scroll between the title and the footer.
7. **Settings > Shortcuts** has the row "Calendar: edit the event (or double-click it)" with `Ctrl+Enter` (shown as `Cmd+Enter` on a Mac) after the calendar keys row.

Probes (each prints JSON; run while the thing is on screen):
- P-ask (item 1): `JSON.stringify((()=>{const a=document.querySelector('.ask');if(!a)return null;const r=e=>{const b=e.getBoundingClientRect();return [Math.round(b.left),Math.round(b.top),Math.round(b.right),Math.round(b.bottom)]};const bs=[...a.querySelectorAll('.ask-actions button')];return {title:a.querySelector('h3').textContent,body:a.querySelector('p').textContent,btn:bs.map(b=>b.textContent),box:r(a),rects:bs.map(r),overflowX:a.scrollWidth-a.clientWidth,vw:innerWidth,vh:innerHeight}})())`
- P-note (item 2): `JSON.stringify({disabled:document.querySelector('#set-calendar .switch input')?.disabled,note:document.querySelector('.set-status')?.textContent.trim(),over:(n=>n&&n.scrollWidth-n.clientWidth)(document.querySelector('.set-status'))})`
- P-card (item 3): `JSON.stringify((()=>{const n=document.querySelector('article.invite .notice.bad[role=alert]');if(!n)return null;const q=e=>{const b=e.getBoundingClientRect();return [Math.round(b.left),Math.round(b.right),Math.round(b.top),Math.round(b.bottom)]};return {text:n.textContent,box:q(n),btn:[...n.querySelectorAll('button')].map(b=>[b.textContent,...q(b)]),over:n.scrollWidth-n.clientWidth,vw:innerWidth}})())`
- P-pop (items 4 and 6, popover open): `JSON.stringify((()=>{const p=document.querySelector('.ev-pop');if(!p)return null;const r=e=>{const b=e.getBoundingClientRect();return [Math.round(b.left),Math.round(b.top),Math.round(b.right),Math.round(b.bottom)]};const rows=[...p.querySelectorAll('.ev-foot .ev-acts')].map(row=>[...row.querySelectorAll('button')].map(b=>({n:(b.getAttribute('aria-label')||b.textContent).trim(),r:r(b),clip:b.scrollWidth-b.clientWidth>1||b.scrollHeight-b.clientHeight>1})));const d=p.querySelector('.ev-details');const last=rows.length?rows[rows.length-1]:[];return {vw:innerWidth,vh:innerHeight,box:r(p),foot:p.querySelector('.ev-foot')?r(p.querySelector('.ev-foot')):null,names:rows.flat().map(b=>b.n),clipped:rows.flat().filter(b=>b.clip).map(b=>b.n),details:d?{scroll:d.scrollHeight,client:d.clientHeight}:null,lines:last.map(b=>(b.r[1]+b.r[3])/2).sort((a,b)=>a-b).reduce((n,x,i,c)=>i&&x-c[i-1]<=12?n:n+1,0),lastRight:(last[last.length-1]||{r:[0,0,0]}).r[2],maxRight:Math.max(0,...last.map(b=>b.r[2])),repeat:p.querySelector('.inv-row .sub')?.textContent.trim()||null}})())`
- P-edit (item 5, after a double-click / Ctrl+Enter / Cmd+Enter on an event): `JSON.stringify({dialog:document.querySelector('.modal-head b')?.textContent||null,title:document.querySelector('#ev-title')?.value||null,popover:!!document.querySelector('.ev-pop'),selection:getSelection().toString(),focus:document.activeElement?.className||document.activeElement?.tagName})` (run it again after Esc: `dialog` null and `focus` contains `ev-chip`, `wk-ev` or `ag-row`).

Test bridge steps for item 5 (debug test build, no dev mock): `/click {"selector":".ev-chip","index":N,"double":true}` (the n-th chip), or focus a chip (`document.querySelectorAll('.ev-chip')[N].focus()` through `/eval`) and `/key {"key":"Enter","meta":true}` on a Mac, `{"key":"Enter","ctrl":true}` on Linux. Bridge key events are synthetic: they reach the page's key handler, which is what Ctrl/Cmd+Enter uses.

PASS (numbers):
- P-ask: `overflowX` <= 1; `rects[0][1]` and `rects[1][1]` differ by <= 2 px (one row), `rects[0][2] <= rects[1][0]`, every button rect inside `box`; `box[3] <= vh` and `box[1] >= 0`; title, paragraph and both labels are the dictionary's text of the language (no `{provider}`, no key); the paragraph names the provider ("Google" / "Microsoft") and the mailbox address.
- P-note: `disabled` true, `note` is "This build of Hey Look! can’t sync calendars with Google." (translated), `over` <= 1; clicking the switch does nothing.
- P-card: `over` <= 1; `box[1]` (right) <= `vw` and every button's left >= `box[0]`, right <= `box[1]`; the text starts with the warning, then (held cases) the held sentence and the button label; the fourth mail has no button; after Apply anyway the button is gone, the warning stays, a toast "Your calendar was updated" shows, the focus is on the notice (not on the page).
- P-pop: `box` inside `[0,vw] x [0,vh]`; `foot[3] <= box[3]`; `clipped` is `[]`; `lines` <= 2 (3 = FAIL); `names` for a My events event is `["Edit","Duplicate","Save .ics","Delete"]` (translated, in this order); for an invitation with answers `["Accept","Tentative","Decline","Join","Open invitation email","Duplicate","Save .ics","Delete"]`; the Delete button is the last name and `lastRight` equals `maxRight` (Delete is the right-most button of the actions row); every button is at least 24 px high; `repeat` is "Custom" (translated) for the RDATE row. A tall popover (low window): `details.scroll > details.client`, `box[3] <= vh`, the footer still visible.
- P-edit: after the double-click `dialog` is "Edit event" (translated), `title` is the event's, `popover` false, `selection` is "" (no word selected); for an invitation or a read-only event `dialog` is null and the popover is open; after Esc the `focus` class contains `ev-chip`, `wk-ev` or `ag-row` (WebKit does not focus a button on a click: this is the check that the code does it).
- Settings > Shortcuts: the row follows "Calendar: new event, today, ..." and reads `Cmd+Enter` on a Mac, `Ctrl+Enter` on Linux; not clipped in ja, de, ru at 960 x 560.
Windows numbers for comparison (Chromium, 946 x 480): popover 392 px wide, Edit / Duplicate / Save .ics / Delete one line in en and de, two lines for the invitation in fr and ru; buttons 28 px high; details scroll only below about 260 px of window height.

Engine features relied on: `ResizeObserver` (Safari 13.1+, WebKitGTK 2.30+; the narrow rule, under 300 px inside the popover, is not reachable in the app: the main window is 960 px wide at least; check it only in the dev preview in a 320 px window), `max-height: calc(100vh - 16px)` with a flex column and `min-height: 0` on the scrolling child, `overflow-y: auto`, `overscroll-behavior: contain` (Safari 16+; older engines ignore it, nothing breaks), `margin-left: auto` on the last item of a wrapping flex row, `-webkit-user-select: none`, the `dblclick` event on a `<button>` (WebKit sends it; the first click has already opened the popover and the double-click closes it), Ctrl/Cmd+Enter through `keydown` (`metaKey`), `getComputedStyle` paddings. Already in use before and unchanged: `color-mix()` in `.btn.danger` (Safari 16.2+; on macOS 11 to 13 Safari the border of Delete falls back to the normal button border, the red text stays), lucide SVG icons. Not used: `:has()`, container queries, `inert`, `dvh`, `clamp()`, scroll-padding.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-7a.01 | Mac, Linux | the question before the browser opens (item 1), 8 languages, 960 x 560, light and dark, Google (`Nam`) and Microsoft (`Nam Outlook`) mailboxes, also Allow access again (`#calsync=auth`). URL: `http://127.0.0.1:1420/#lang=en&light&calsync=ok` (`#lang=de&dark&calsync=auth` for Allow access again), Settings > Mailboxes > Nam > Calendar | P-ask | as P-ask; Cancel and Esc put the focus back on the switch (`document.activeElement` is `#set-calendar .switch input`), no browser starts, switch stays off | OPEN |
| WK-7a.02 | Mac, Linux | the disabled switch and note (item 2): URL `http://127.0.0.1:1420/#lang=en&light&calkinds=none`, 8 languages, 960 x 560 | P-note | as P-note | OPEN |
| WK-7a.03 | Mac, Linux | the failed-sender-check card (item 3): URL `http://127.0.0.1:1420/#lang=en&light&unverified` (rows 2 to 5 of the Inbox, or search `sender check`), the four mails, 8 languages, 960 x 560, light and dark; press Apply anyway on the first | P-card | as P-card | OPEN |
| WK-7a.04 | Mac, Linux | "Custom" in the popover (item 4): `#rdate`, Agenda view, en and ja | P-pop | `repeat` is "Custom" / its translation | OPEN |
| WK-7f1.01 | Mac (Cmd+Enter), Linux (Ctrl+Enter) | double-click and the key on an event in month, week (timed block, all-day chip) and agenda, an invitation, a read-only event, empty space (item 5) | P-edit | as P-edit; empty space: a new event (title "New event") at 09:00 in the month, at the clicked half hour in the week | OPEN |
| WK-7f1.02 | Mac, Linux | popover buttons (item 6): My events event, an invitation with answers, a read-only event, in en, de, fr, ru at 960 x 480, 960 x 560 (viewport 946 x ...), light and dark | P-pop | as P-pop | OPEN |
| WK-7f1.03 | Mac, Linux | a popover near the bottom edge (an agenda row scrolled to the window's bottom): it opens above the row; a low window with a long description: details scroll | P-pop | popover `box[3] <= vh`, `box[1] >= 0`; above the row: `box[3] <= row top + 2`; scroll case `details.scroll > details.client` | OPEN |
| WK-7f1.04 | Mac, Linux | Settings > Shortcuts row (item 7), 8 languages, 960 x 560 | `JSON.stringify([...document.querySelectorAll('.set-row')].filter(r=>/Ctrl\+Enter|Cmd\+Enter/.test(r.querySelector('kbd')?.textContent)).map(r=>[r.querySelector('kbd').textContent,r.textContent.slice(0,90),r.scrollWidth-r.clientWidth]))` | one row is the calendar one, `kbd` reads `Cmd+Enter` (Mac) / `Ctrl+Enter`, overflow <= 1 | OPEN |

## 23. Fix batch 10 (coder, `feature/v107-fix10`): a window shown from the tray must not be white (D-057)

Nothing here was run on a Mac or Linux. The fix itself (`startup.rs` `screen_probe`, the ladder, `webview_health::nudge`) is Windows only: `verify_painting` returns at once on other systems and `capture_samples` answers "Windows only". No CSS, layout, font, text or UI string changed, so there is nothing to measure in WebKit for the change; what follows is the check of the RISK on Mac and Linux, which the owner asked for.

Do Mac and Linux have the same risk? The stage logic is shared: the window is created hidden, a `--minimized` start with a tray keeps it hidden, and every show goes through `shell::show_main` (tray click, tray menu, second start, notification, Dock reopen). What differs is the failure: on Windows the web view's composition surface (WebView2 with DirectComposition) was not presented again after the show. WKWebView (macOS) is composited with its window by Core Animation and WebKitGTK is a GTK widget; neither has that layer. What they have today: macOS `page_state` after a show (page says `hidden` or gets no animation frames -> hide + show, at most twice); Linux `linuxview.rs` (queue_draw after a show, a page ping, `web-process-terminated`). Both are page-level: a window that is white while the page reports `visible` and gets frames is invisible to them, exactly as on Windows. Linux has had white pages after the tray before (that is why `linuxview.rs` exists), so its risk class is the same; macOS is judged lower, but not measured. The rows below measure it once on real hardware; a FAIL becomes a new defect (a pixel read for that system), not a closed note.

Engine features relied on by the probe (page side only): `requestAnimationFrame`, `document.visibilityState`, `document.hasFocus()`, `getComputedStyle`: all engines. Nothing from the lists of newer features (`:has()`, `inert`, `color-mix()`, `dvh`, `clamp()`). The probe script decodes a PNG itself (node `zlib`), no dependency.

Probe (all rows): `node scripts/lib/paint-probe.mjs <data folder of the debug build run with HEYLOOK_TEST_BRIDGE=0 and HEYLOOK_DATA_DIR> --snapshot=<file.png>` prints one JSON line: `page` = `{visibility, frames500ms, hasFocus, root:[w,h], bodyBg, ready}`, `snapshot` = `{bytes, points, colours, topShare, topRgb}` of the bridge's picture of the web content (WKWebView `takeSnapshot` on macOS; Linux has none: `snapshot.unavailable`), `verdict`. For the WINDOW (what is on the screen) take a screenshot of the window with the QA session's own tool, crop it to the part no other window covers (the taskbar / Dock / another window inside the picture counts as extra colours) and run `node scripts/lib/paint-probe.mjs --image=<w.png>` (8-bit RGB / RGBA PNG): `{points, colours, topShare, topRgb, verdict}`. Windows numbers measured with the same grid (64 x 40 points over the client area): the real app, dark theme `colours` 201 to 207, `topShare` 0.37 to 0.47 (colour 27,28,32); light theme `colours` 209, `topShare` 0.395 (255,255,255); a white window `colours` 2, `topShare` 0.974 (255,255,255) with the taskbar over a strip of it, 1.0 without.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-F10.01 | Mac (real hardware, debug build with the bridge, run from Terminal: `HEYLOOK_TEST_BRIDGE=0 HEYLOOK_DATA_DIR=<dir> "<.app>/Contents/MacOS/hey-look" --minimized`) | tray start: the window stays hidden (`/windows` `visible:false`, log `window stays hidden (tray start)`); after 60 s open it from the menu bar icon (Open), then from the Dock icon (Reopen) after hiding it again with Cmd+W | paint-probe at 0.3 s, 1 s, 3 s after the show, and a screenshot of the window each time | `page.visibility` = `visible`, `page.frames500ms` >= 10 (a Mac at 60 Hz gives about 30), `page.root` equals the window size in points +- 2; `snapshot.colours` >= 20 and `snapshot.topShare` < 0.95; screenshot `colours` >= 20 and `topShare` < 0.95 (the dark and the light theme); `startup.log` has `page state after show: visibility=visible, animation frames=true` and NO `hide + show` line | OPEN |
| WK-F10.02 | Mac | the same after the display slept and woke while the window was hidden (`pmset displaysleepnow`, wake with a key, 10 s later open the window); and after the Mac slept (lid closed 30 s) | as WK-F10.01 | as WK-F10.01 | OPEN |
| WK-F10.03 | Linux (WebKitGTK 2.40+, the AppImage or the .deb with a tray; GNOME needs the AppIndicator extension, else the app starts visible) | `--minimized` start, wait 60 s, open from the tray menu (Open Hey Look!), hide with the X, open again; also a second start (`hey-look` again) | paint-probe + screenshot of the window (`gnome-screenshot -w -f w.png` or `grim`), at 0.3 s, 1 s, 3 s | as WK-F10.01 for the page and the screenshot (no snapshot on Linux); the log has the lines of `linuxview.rs` and no `web process` failure | OPEN |
| WK-F10.04 | Mac, Linux | a second start and a notification click while the window is hidden show a painted window (they use the same `show_main`) | as WK-F10.01 | as WK-F10.01 | OPEN |
| WK-F10.05 | Mac, Linux | the page's own claim versus the pixels: if a screenshot reads `topShare` >= 0.95 while the page says `visible` + frames, that is the D-057 failure on that system: report it with the numbers, the log and the screenshot | as WK-F10.01 | no such window | OPEN |

Windows checks run by the coder (WebView2, the Windows QA can repeat them): `node scripts/test-blank-after-show.mjs --exe=<debug exe> --variant=plain,gpu-off,gpu-kill,busy,display-off,start-minimized,start-hidden,inject1,inject2,inject3,inject4`; see `coder-v107-fix10.md`.

## 24. Fix batch 11 (coder, `feature/v107-fix11`): small buttons 24 px by construction, held answer card text (D-059), website demo height in Japanese (D-058), unverified mock order, not-set-up calendar source retried (D-061)

Nothing here was run on a Mac or Linux. Windows (headless Chrome and the dev preview) was measured with the tests named at the end, with the font stress options (`--font=Arial`, `--font=Verdana --spacing=0.04`, `--font=Tahoma`, `--font=Georgia`) that stand in for the other fonts of Linux and macOS.

Visible changes, what to look at:
1. **Small buttons are 24 px high by construction (CI).** `src/App.css` `.btn.small { min-height: 24px }`. Before, a 12 px label with a line height of 1.15 (Arial, DejaVu Sans on the GitHub runner) gave 14 + 6 padding + 2 border = 22 px; Segoe UI (Windows) gives 24 by luck. Look at the event preview (click an event in the Calendar: Edit, Duplicate, Save .ics, Delete, and the answer buttons of an invitation) and any other `.btn.small`. Engine feature: `min-height` on a flex item, nothing else.
2. **Held answer card (D-059).** Dev preview `http://127.0.0.1:1420/#lang=<code>&light&unverified`, the third of the four mails ("Accepted: 1:1 with Bao (sender check failed)"): the summary line under the title reads only "1 of 2 accepted" (translated), without "Attendee status updated in your calendar". The ordinary answer mail (`#lang=<code>&light`, "Accepted: 1:1 with Bao", no "(sender check failed)") still says "... accepted · Attendee status updated in your calendar". The line is shorter or equal, no layout risk.
3. **Website demo window, Japanese (D-058).** `docs/assets/style.css`: the window of "Make it yours" between 820 and 1020 px of screen has `min-height: calc(var(--fs, 14px) * var(--lh, 1.35) * 9.44 + 181px)`, and `--lh` is 1.35 (Japanese 1.55); it replaces `fs * 13 + 165px`, which assumed 1.35. Look at `/ja/index.html` (serve the `docs` folder: `python3 -m http.server -d docs 8080`, open `http://127.0.0.1:8080/ja/index.html`), section "Make it yours", with a browser window of 840, 960 and 1020 px inner width, all text sizes (12 to 18) and the three densities; also the other seven languages. Engine features: `calc()` with a length times a unitless custom property (`var(--fs) * var(--lh)`), `var()` fallbacks, `@container` (already used), `:lang(ja)`.
4. **Dev preview order (WP7a recipe).** The `#unverified` mails are now the newest rows (see section 22, item 3). Dev preview only.
5. **D-061 (Rust only).** A calendar source whose last round said "not set up" (no sign-in client in that build, the Calendar API off) gets one new round at every app start (`calsync/store.rs` `retry_not_set_up`). Platform independent, no UI string, no layout.

Probes (each prints JSON; run while the thing is on screen):
- P-btn (item 1, event preview open): `JSON.stringify([...document.querySelectorAll('.ev-pop .btn.small, .ev-pop .ev-acts button')].map(b=>Math.round(b.getBoundingClientRect().height*10)/10))`
- P-sum (item 2, a REPLY card open): `JSON.stringify(document.querySelector('article.invite .inv-row.sub')?.textContent||null)`
- P-demo (item 3, the website page open at 840, 960 or 1020 px; it sets the controls itself and leaves them at the last combination): `JSON.stringify((()=>{const f=document.getElementById('mk-form'),app=document.querySelector('.mk-view .app'),fo=app.querySelector('.a-folders'),set=(n,v)=>{[...f.elements[n]].find(e=>e.value===String(v)).checked=true};const cut=[];let least=1e9;for(const d of ['full','medium','compact'])for(const p of ['right','bottom'])for(const s of [12,13,14,15,16,18]){set('density',d);set('pane',p);set('fs',s);f.dispatchEvent(new Event('change',{bubbles:true}));const need=fo.lastElementChild.getBoundingClientRect().bottom-fo.getBoundingClientRect().top+parseFloat(getComputedStyle(fo).paddingBottom);least=Math.min(least,fo.clientHeight-need);if(fo.scrollHeight>fo.clientHeight+0.5)cut.push([d,p,s,fo.scrollHeight,fo.clientHeight])}return{vw:innerWidth,shown:fo.getBoundingClientRect().width>0,lh:getComputedStyle(app).lineHeight,fs:getComputedStyle(app).fontSize,cut,least:Math.round(least*10)/10}})())`

PASS (numbers):
- P-btn: every number >= 24 (Windows with Segoe UI: 24; with Arial before the fix: 22).
- P-sum: for the held card the text is "1 of 2 accepted" in the language of the page and does not contain the translation of "Attendee status updated in your calendar"; for the ordinary card the text ends with that sentence.
- P-demo: `shown` true, `cut` is `[]`, `least` >= 0 (Windows Chrome: 1.6; Safari and WebKitGTK needed less than Chrome in the D-058 numbers, 7 to 38 px short against the old formula, which the new one exceeds by 18 to 47 px at line height 1.55); `lh` is 1.55 x `fs` on /ja/ (27.9px at 18 px) and 1.35 x `fs` elsewhere. Run it at 840, 960 and 1020 px in all 8 languages (one page each: /, /vi/, /fr/, /zh/, /es/, /ja/, /de/, /ru/).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-F11.01 | Mac, Linux | small buttons (item 1): event preview of My events, an invitation, a read-only event, en / de / fr / ru, 946 x 480, light and dark | P-btn | as P-btn | OPEN |
| WK-F11.02 | Mac, Linux | held answer card (item 2), 8 languages, 960 x 560 | P-sum | as P-sum | OPEN |
| WK-F11.03 | Mac, Linux | the website demo, Japanese (item 3), 840 / 960 / 1020 px, light and dark | P-demo | as P-demo, `cut` [] in all 36 combinations | OPEN |
| WK-F11.04 | Mac, Linux | the website demo in the other 7 languages (item 3), 840 / 960 / 1020 px | P-demo | as P-demo | OPEN |

Windows checks run by the coder: `node --experimental-strip-types scripts/test-event-popover-actions.mjs --require-browser [--quick] [--font=Arial | --font=Verdana --spacing=0.04 | --font=Tahoma]`, `node --experimental-strip-types scripts/test-calendar-consent.mjs --require-browser`, `node scripts/test-site-appearance.mjs --require-browser [--quick] [--font=Verdana --spacing=0.04 | --font=Georgia]` (the new folder-column pass: 8 languages x 840/960/1020 px x 3 densities x 2 panes x 6 sizes = 864 cases); see `coder-v107-fix11.md`.

## 25. Fix batch 12 (coder, `feature/v107-fix12`): the window shows the app's own colours and a small logo while it starts instead of a white window (owner request, D-057)

Nothing here was run on a Mac or Linux. Windows (headless Chrome for the page, the real debug build with WebView2 for the window) was measured; see `coder-v107-fix12.md`. The engine features are listed with the fallbacks.

Visible changes, what to look at:
1. **The start screen** (`index.html`, `public/boot.css`, `public/theme-boot.js`). Until React has mounted, `#root` holds a centred logo (72 x 72, the logo of the website) inside a thin spinner ring (112 px, the accent colour on a faint track) on the app's own ground: light `#ffffff`, dark `#1b1c20` (the `--bg` tokens of `src/App.css`). No text (the accessible name is the app's name, "Hey Look!", `role="status"`, `aria-busy="true"`). With "Reduce motion" (macOS: System Settings > Accessibility > Display; GNOME: Settings > Accessibility > Reduce animation; either gives `prefers-reduced-motion: reduce`) the logo is still and there is no ring. The theme comes from the stored setting (`localStorage["heylook.boot"]`, written by `applyPrefs`, read by `theme-boot.js` before the first paint) or, with System / on the very first start, from the OS (`prefers-color-scheme`; the backend pins the window's theme to the setting too, so the page also sees the setting there). The splash is out of the flow (`position: fixed`), so nothing moves when the app mounts.
2. **The colour of the window and the web view before the page paints** (`src-tauri/src/bgcolor.rs`; the same two colours). macOS: `NSWindow.backgroundColor` (tao) and, through wry, `drawsBackground = NO` on the web view and `underPageBackgroundColor` (macOS 12+; on macOS 11 the window colour shows through the transparent web view). Linux: `webkit_web_view_set_background_color` and the GTK window. Set at the start of `setup`, for every window when it is created (compose and reader too) and again whenever the theme setting or the OS theme changes (`wintheme::apply_all`). Look at the window while it is resized and at the first frame after a show.
3. The probe of fix batch 10 (`paint-probe.mjs`) now answers `START SCREEN` instead of `BLANK` while `page.splash` is true: a window that shows only the start screen is one colour on more than 95 % of the points by design (the logo is 3 % of the points at 1280 x 800, 1 % at 2560 x 1300). A window that is `visible` and `page.ready` and still one colour is the D-057 failure, as before (WK-F10.05).

How to get a slow start to look at (debug build with the test bridge; also Windows): `HEYLOOK_TEST_BRIDGE=0 HEYLOOK_DATA_DIR=<dir> HEYLOOK_TEST_BOOT_DELAY_MS=9000 "<exe>"` holds the first two loads of the window back 9 s each (`HEYLOOK_TEST_BOOT_DELAY_LOADS=<n>` changes the count). The window is created hidden (0 to 6 s), shown WITHOUT a ready signal at 6 s with the start screen on it, the page is loaded again (still held) and the app mounts at about 12.5 s. To choose the theme: Settings > Appearance > Theme, then restart; or a stored System with the OS in the other theme. Reduced motion: switch it on in the OS before the start.

Engine features relied on, and the fallback when one is missing: `:where()` (Safari 14 = macOS 11.0, WebKitGTK 2.30; without it the ground rule is dropped and the native colour of item 2 shows), `prefers-color-scheme` (Safari 12.1), `prefers-reduced-motion` (Safari 10.1), CSS custom properties with a fallback (`var(--accent-base, #0f6cbd)`), `@keyframes` + `animation`, `position: fixed` with `top/right/bottom/left` (NOT `inset`, which Safari 14.0 lacks: a test forbids it in `boot.css`), flexbox centring, inline SVG, `localStorage` in try / catch. `color-mix()` only inside `@supports (color: color-mix(in srgb, red, blue))` for the dark accent, after a plain hex (`#6fa7d7`). `getAnimations()` is used by the probe only (Safari 13.1). Not used: `:has()`, `inert`, `dvh`, `clamp()`, `aspect-ratio`. (The built `index-*.css` of the app itself already needs more of them, e.g. `inset`, `color-mix()`; the start screen was written not to depend on those.)

Probes (each prints JSON; run through the test bridge while the start screen is up, i.e. between 6 s and 12 s of the slow start; `eval main "return <expression>"`; a script with a semicolon needs the `return`; both probes were run on the Windows debug build and gave the numbers below):
- P-splash: `JSON.stringify((()=>{const h=document.documentElement,sp=document.querySelector('.boot-splash'),lg=sp&&sp.querySelector('.boot-logo'),rg=sp&&sp.querySelector('.boot-ring'),r=lg&&lg.getBoundingClientRect(),cs=getComputedStyle;return {splash:!!sp,theme:h.getAttribute('data-theme'),htmlBg:cs(h).backgroundColor,osDark:matchMedia('(prefers-color-scheme: dark)').matches,reduce:matchMedia('(prefers-reduced-motion: reduce)').matches,logo:r&&[Math.round(r.width),Math.round(r.height),Math.round(r.left+r.width/2-innerWidth/2),Math.round(r.top+r.height/2-innerHeight/2)],ring:rg&&[rg.offsetWidth,cs(rg).display],logoAnim:lg&&cs(lg).animationName,animations:sp?sp.getAnimations({subtree:true}).map(a=>a.animationName+':'+a.playState):null,text:document.getElementById('root').innerText.length,overflow:[h.scrollWidth-innerWidth,h.scrollHeight-innerHeight],aria:sp&&[sp.getAttribute('role'),sp.getAttribute('aria-busy'),sp.getAttribute('aria-label')]}})())`
- P-gone (after the app has mounted): `JSON.stringify({splash:document.querySelectorAll('.boot-splash,.boot-logo,.boot-ring').length,status:document.querySelectorAll('#root > [role=status][aria-label]').length,bg:getComputedStyle(document.body).backgroundColor})`
- P-shot (the window, a screenshot with the QA session's own tool, cropped to the window): `node scripts/lib/paint-probe.mjs --image=<w.png>` gives `topRgb`, `topShare`, `colours`; for the centre of the window count the pixels off the ground in the middle 64 x 64 (the logo).

PASS (numbers):
- P-splash: `splash` true; `htmlBg` `rgb(27, 28, 32)` when the setting is Dark (or System with the OS dark: `osDark` true), `rgb(255, 255, 255)` when Light (or System with the OS light); `theme` "dark" / "light" for a stored setting, null for System (or before the first save); `logo` `[72,72,0,0]` (the two offsets +- 1); `ring` `[112,"block"]` and `animations` containing `boot-spin:running` and `boot-pulse:running` without reduced motion; with it `ring[1]` "none", `logoAnim` "none" and `animations` `[]`; `text` 0; `overflow` `[0,0]`; `aria` `["status","true","Hey Look!"]`.
- P-shot: the window's `topRgb` is `27,28,32` (dark) or `255,255,255` (light) with `topShare` between 0.95 and 0.995 and `colours` >= 3 (the logo), and more than 40 % of the middle 64 x 64 pixels differ from the ground; in the dark theme no white pixel at the edges (Windows measured: 0 % white, 96.8 % `27,28,32`, 6 colours, centre 99 % off the ground).
- The first frame after the show of the slow start (6.5 s) is the ground colour at every edge of the window: the pixels at (4,4), (w-5,4), (4,h-5), (w-5,h-5) equal the ground exactly. Resize the window larger while the start screen is up: the new strip is the ground colour too (no white strip).
- P-gone: `{"splash":0,"status":0,"bg":"rgb(27, 28, 32)"}` in the dark theme (white in the light theme).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-F12.01 | Mac (WKWebView, macOS 11, 12 and 14 if available) | slow start, theme Dark and theme Light with the OS in the OTHER theme, then System with the OS dark and light; 960 x 560 and the saved size | P-splash, P-shot at 7 s | as P-splash and P-shot, all four combinations | OPEN |
| WK-F12.02 | Mac | the first frame after the show (6.5 s) and a window resize during the start screen: no white edge or strip; the title bar strip on top is the ground colour | P-shot at 6.5 s and during the resize (screenshot while dragging) | edges equal the ground exactly; no pixel with all channels >= 250 in the dark theme | OPEN |
| WK-F12.03 | Mac | Reduce motion on (System Settings > Accessibility > Display): the logo is still, no ring; off again: the ring turns | P-splash, two screenshots 1 s apart | `ring[1]` "none", `animations` `[]`, the two pictures equal (reduced); `boot-spin:running` (normal) | OPEN |
| WK-F12.04 | Linux (WebKitGTK 2.40+, X11 and Wayland) | slow start, Dark and Light with the desktop in the other theme, and System; the first frame after the show; a window resize | P-splash, P-shot (`gnome-screenshot -w -f w.png` / `grim`) | as WK-F12.01 / .02; if `osDark` does not follow the desktop with the setting System, say which desktop and what `prefers-color-scheme` answered | OPEN |
| WK-F12.05 | Linux | reduced motion (`gsettings set org.gnome.desktop.interface enable-animations false`, restart) | P-splash | as WK-F12.03 | OPEN |
| WK-F12.06 | Mac, Linux | a normal start (no delay switch) never shows the start screen on a visible window; after the mount P-gone; a compose window and a reader window open with the theme's ground (no white flash at their creation) | P-gone in main, compose and reader | `{"splash":0,"status":0,...}`; the windows' first screenshot equals the ground | OPEN |
| WK-F12.07 | Mac, Linux | a window that is only the start screen is not reported as blank by the D-057 probes | `paint-probe.mjs <data folder>` at 7 s | `page.splash` true and `verdict` "START SCREEN ..." (not "BLANK") | OPEN |

Windows checks run by the coder: `node scripts/test-boot-splash.mjs --require-browser` (the HTML alone in headless Chrome: 17 combinations of OS theme, stored theme, accent, reduced motion and size, also with the built stylesheet, pixels read from screenshots; after the mount no splash and no empty #root in between), `node scripts/test-start-splash.mjs --exe=<debug exe> --theme=dark,light --seed=both|db` (the real window, pixels read from the screen), `cargo test --lib bgcolor startup`; see `coder-v107-fix12.md`.

## 26. Fix batch 16 (coder, `feature/v107-fix16`): the start gate for a Windows autostart (owner question, D-057); apt hardening of the Linux CI jobs

No visible UI, CSS, layout, font, text or focus change on any system. The start gate is Windows only (`--minimized` start, `src-tauri/src/startgate.rs`); on macOS and Linux `startgate::defer` returns false (`wanted(args, windows)` is `windows && ...`), the window of the config is made by tauri before `setup` exactly as before, and nothing is delayed. The reason there is no gate: the race is a Windows desktop one (a web view made before the shell, the display composition, the (remote desktop) session and the WebView2 runtime were up); the launch agent (macOS) and the autostart `.desktop` file (Linux) start inside a finished desktop session, and WKWebView / WebKitGTK have no separate runtime to wait for. Nothing was run on a Mac or Linux; the rows below say what to look at so the claim "unchanged" is checked there.

| ID | System | What to look at | Probe | Pass | Status |
|---|---|---|---|---|---|
| WK-F16.01 | Mac (launch agent `--minimized` or `open -a ... --args --minimized`) | a start with `--minimized` has no gate: the window is created at once, `startup.log` has no `[gate` line, the tray / menu bar item is there, a click on it shows the window painted | `grep -c "\[gate " "<data folder>/startup.log"`; then `window created hidden (show at start: false)` is within 2 s of the process start (`[window +N ms]`); after a click: P-gone of section 25 | gate lines: 0; N < 2000; `{"splash":0,"status":0,...}` after the show | OPEN |
| WK-F16.02 | Linux (WebKitGTK 2.40+, X11 and Wayland; `~/.config/autostart/Hey Look!.desktop` with `--minimized`, or `hey-look --minimized`) | same as WK-F16.01 | same | same | OPEN |
| WK-F16.03 | Mac, Linux | a normal start is unchanged | `grep -c "\[gate " startup.log` | 0 | OPEN |
| WK-F16.04 | Mac, Linux | the `HEYLOOK_TEST_GATE_FAIL` switch (debug builds, Windows behaviour only) does nothing there | start a debug build with `HEYLOOK_TEST_GATE_FAIL=session HEYLOOK_TEST_GATE_FAIL_SECS=30 ... --minimized` | no `[gate` line, window made at once | OPEN |

Engine features relied on: none (no page, CSS or script is touched). Rust side only: `tauri::WebviewWindowBuilder::from_config` after a config window with `create: false` (tauri 2.12), `windows` 0.62 `Win32_System_RemoteDesktop` (Windows only).

Windows checks run by the coder (debug build, QA identifier `thnonl.heylook.qa.fix16`, own data folders): `--minimized` with `HEYLOOK_TEST_GATE_FAIL=session,taskbar HEYLOOK_TEST_GATE_FAIL_SECS=8`: the log shows both gates `WAIT`, 8.0 s later all `ok`, `window made after the start gate`, page ready 250 ms after; a second start during the wait makes the window at once and shows it (4.4 s after the process start, painted: 193 colours); a gate forced for 100 s ends at 60.3 s with `timed out ... still closed: dwm, monitor: making the window anyway`; a normal start has no `[gate` line, window shown 748 ms after the process start. See `coder-v107-fix16.md`.

## 26. WP7f3 calendar sync offered at Google / Microsoft sign-in (coder, `feature/v107-wp7f3`)

Nothing here was run on a Mac or Linux. Windows (Chromium, WebView2): `node scripts/test-calendar-at-signin.mjs --require-browser` (dev preview, mock backend, real mouse and key events, 8 languages, light and dark, 960 x 560 and 1280 x 800, 645 checks, about 4 minutes) and the QA debug build in `E:\hey-mail\test-builds\v107-wp7f3\`.
Dev preview on WebKit: open `http://127.0.0.1:1420/#lang=en&light` in Safari (Mac) or Epiphany / a WebKitGTK browser (Linux) at the window size of the row. The real app on a Mac / Linux cannot run the add flow without a real Google / Microsoft sign-in (owner smoke); the dev preview is the WebKit check, and the Settings switch and the sidebar offer also work in the debug test build with the Windows kit's fakes over the LAN. The mock is told how the consent ends through the console: `__mockCalSync.connectResult = "hang"` (waits for Skip), `"DENIED"` (also TIMEOUT, WRONG_ACCOUNT, PARTIAL, BLOCKED, ERROR), `"ok"`, and `__mockCalSync.connectDelay = 60000`. A sign-in in the dev preview takes 1.2 s; the mock has no OAuth client of its own, so fill the client ids first: `import('/src/api.ts').then(m => m.api.setSetting('google_client_id','id'))` (and `microsoft_client_id`) before Add account opens.

Visible changes, what to look at:
1. **Add account > Google / Microsoft: the box "Also sync my calendar"** (ticked, a native checkbox with `accent-color`, the label and the hint under it, between the display name field and the Sign in button). Settings > Add account (dialog 960 x 560 and 1280 x 800). Text length: de "Auch meinen Kalender synchronisieren" and ru "Также синхронизировать мой календарь" are the long labels; the hint is one or two lines.
2. **Step 2 on the same card**: after Sign in (1.2 s) the Sign in button reads "Waiting for Google…" (disabled), "Skip calendar" has the focus, the slot under the card says "Account <address> added. Now allow calendar access in your browser…" (Google adds the unverified-app hint and its link); after a refusal the buttons are Retry (blue, focus) and "Continue without calendar", and the slot shows the Settings sentence. In a low window the slot is below the fold: the code scrolls it into view (`scrollIntoView({block:"nearest"})`).
3. **Calendar sidebar offer** (a notice with two link buttons under the calendar list, for mailboxes that existed before). Below about 1100 px the side menu is the icon column in the Calendar too, so at 960 x 560 the offer shows in the full menu opened over the page (the toggle button at the top of the column pins it); at 1280 x 800 it is in place. A 48-character address wraps inside the notice (`overflow-wrap: anywhere`).

Probes (each prints JSON; run while the thing is on screen):
- P-also (items 1 and 2, Add account open): `JSON.stringify((()=>{const c=document.querySelector('.settings-body .set-card');const cb=c.querySelector('.also-cal input');const h=c.querySelector('.also-cal .muted');const r=e=>{const b=e.getBoundingClientRect();return [Math.round(b.left),Math.round(b.top),Math.round(b.right),Math.round(b.bottom)]};const s=document.querySelector('.signin-slot');const bd=document.querySelector('.settings-body');return {box:cb?{checked:cb.checked,disabled:cb.disabled,label:cb.closest('label').textContent.trim(),hint:h.textContent.trim(),described:cb.getAttribute('aria-describedby')===h.id,rect:r(cb),cardOver:c.scrollWidth-c.clientWidth}:null,card:r(c),buttons:[...c.querySelectorAll('.row-inline button')].map(b=>[b.textContent.trim(),b===document.activeElement,...r(b)]),slot:s.textContent.trim(),slotOver:s.scrollWidth-s.clientWidth,slotRect:r(s),body:r(bd)}})())`
- P-offer (item 3, Calendar open, side menu in full): `JSON.stringify((()=>{const n=document.querySelector('.cal-offer');if(!n)return null;const b=n.getBoundingClientRect(),p=n.parentElement.getBoundingClientRect(),cs=getComputedStyle(n),lh=parseFloat(cs.lineHeight)||parseFloat(cs.fontSize)*1.3;return {text:n.textContent.replace(/\s+/g,' ').trim(),role:n.getAttribute('role'),links:[...n.querySelectorAll('button.link')].map(x=>x.textContent.trim()),over:n.scrollWidth-n.clientWidth,left:Math.round(b.left),right:Math.round(b.right),parentLeft:Math.round(p.left),parentRight:Math.round(p.right),lines:Math.round((b.height-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom))/lh)}})())`

PASS (numbers):
- P-also, idle: `box.checked` true, `box.disabled` false, `box.label` and `box.hint` are the dictionary's text of the language (the hint names Google or Microsoft), `described` true, `cardOver` <= 1; the checkbox is 15 x 15 px, its top is below the display name field and above the top of `buttons[0]` (Sign in); every button rect is inside `card`.
- P-also, step 2 waiting: `buttons` = Sign in (disabled, "Waiting for Google…" translated), then "Skip calendar" with `true` (focus); `slot` starts with "Account <address> added. Now allow calendar access in your browser…" (translated); `slotOver` <= 1; `slotRect[1]` >= `body[1] - 1` and `slotRect[1] + 24` <= `body[3] + 1` (the line is in view); `box.disabled` true.
- P-also, failed: `buttons` = Sign in (disabled), Retry (`true`, focus), "Continue without calendar"; `slot` starts with the translated "Calendar access wasn’t allowed. You can try again when you’re ready."; no button wider than the card; two rows of buttons are fine, a clipped button is a failure.
- P-offer: `text` = the agreed sentence + "Turn on…" + "Not now" (translated, single spaces); `role` "note"; `links` has two entries; `over` <= 1; `left` >= `parentLeft` - 1 and `right` <= `parentRight` + 1 (nothing sticks out, also with a 48-character address); `lines` <= 4 with a normal address in every language at the default sidebar width, <= 6 with the 48-character address.

Engine features relied on: `accent-color` on a checkbox (Safari 15.4+, WebKitGTK 2.38+; an older engine draws the system's checkbox, nothing breaks), `overflow-wrap: anywhere` (Safari 15.4+; before that a very long unbroken address could stick out of the notice by a few pixels), `Element.scrollIntoView({block:"nearest"})` (Safari 14+; an engine without the option ignores it and the slot stays below the fold in a very low window), `aria-describedby`, `autoFocus` (React calls `.focus()` itself). No `:has()`, `dvh`, `inert` or `color-mix` is new (the notice uses the existing `notice info` classes).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-7f3.01 | Mac, Linux | Add account > Google and Microsoft: the box, hint, tab order (Tab from the display name reaches the box, Space toggles, Tab reaches Sign in), 8 languages, 960 x 560 and 1280 x 800, light and dark. `http://127.0.0.1:1420/#lang=en&light` | P-also | as P-also idle; the focus ring of the checkbox is visible | OPEN |
| WK-7f3.02 | Mac, Linux | step 2 waiting and failed (set `__mockCalSync.connectResult` and `connectDelay` first), Skip has the focus, Enter on Skip / Retry works, Esc ends it as Skip, en, de, ja, ru at 960 x 560 | P-also | as P-also step 2 | OPEN |
| WK-7f3.03 | Mac, Linux | the sidebar offer at 1280 x 800 (in place) and 960 x 560 (pinned overlay), with the 48-character address, en, de, ja, ru, light and dark; dev preview default state (a2 and a4 have no calendar) | P-offer | as P-offer | OPEN |

## 27. WP7f2 Invitations folded into the main calendar (coder, `feature/v107-wp7f3`, second commit group)

Nothing here was run on a Mac or Linux. Windows (Chromium): `node scripts/test-calendar-fold.mjs --require-browser` (dev preview, mock backend with `#caltwins&calsync=ok&calsyncms=ok`, 8 languages for the popover line and the empty agenda) and the QA debug build in `E:\hey-mail\test-builds\v107-wp7f3\`. The folding rules themselves are backend logic (`cargo test --lib`: `invitations_fold_into_the_primary_calendar`, `a_microsoft_invitation_matches_its_twin_by_title_and_start`, `exchange_goid_with_vcal_uid_is_decoded`, `no_provider_write_happens_when_an_invitation_without_twin_is_answered`); on a Mac / Linux only what the page draws can differ.
Dev preview on WebKit: `http://127.0.0.1:1420/#lang=en&light&caltwins&calsync=ok&calsyncms=ok`, Calendar module, side menu in full (1280 x 800; at 960 x 560 the menu is the icon column: pin it with the toggle button at the top).

Visible changes, what to look at:
1. **Sidebar and icon column** list no "Invitations · nam@gmail.com" and no "Invitations · nam@outlook.com"; "Invitations · nam@example.com" (IMAP) and "Invitations · nam.work@gmail.com" (Gmail without sync) stay.
2. **Colour**: an invitation without a twin ("Only by mail (Google)", agenda Day +7) is drawn in the colour of "Nam" (`#039be5`), "Only by mail (Outlook)" in the colour of "Calendar" (`#0078d4`), and both go with those calendars' checkboxes.
3. **Shown once**: "Planning twin", "Budget twin" and "Offsite title twin" appear once in month, week and agenda.
4. **Popover line** of an invitation that only came by mail: a muted small line "This invitation came by mail and isn’t in Google Calendar. Your answer goes to the organizer by email." under the details (Outlook: "... isn’t in Outlook ..."), with Accept / Tentative / Decline above. 392 px popover: the line is 2 to 3 lines in en, de, fr, ru, vi (the longest are vi and ru); the popover grows, it never reaches past the window (its details scroll).

Probes:
- P-fold (item 1): `JSON.stringify({side:[...document.querySelectorAll('.folder-pane .cal-list label')].map(l=>l.textContent.trim()),rail:[...document.querySelectorAll('.folder-pane .fp-cal')].map(b=>b.getAttribute('aria-label'))})`
- P-colour (items 2 and 3, agenda view): `JSON.stringify([...document.querySelectorAll('.ag-row')].filter(e=>/Only by mail|twin/.test(e.getAttribute('aria-label')||e.textContent)).map(e=>[(e.getAttribute('aria-label')||e.textContent).slice(0,40),getComputedStyle(e).getPropertyValue('--ev').trim()]))`
- P-popline (item 4, popover open): `JSON.stringify((()=>{const p=document.querySelector('.ev-pop');if(!p)return null;const r=p.getBoundingClientRect(),cs=getComputedStyle(p),n=[...p.querySelectorAll('.muted.small')].map(x=>{const b=x.getBoundingClientRect();return {text:x.textContent.trim(),over:x.scrollWidth-x.clientWidth,h:Math.round(b.height),right:Math.round(b.right)}});return {box:[Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)],vh:innerHeight,notes:n,buttons:[...p.querySelectorAll('button')].map(b=>(b.getAttribute('aria-label')||b.textContent).trim())}})())`

PASS (numbers):
- P-fold: `side` has no entry that starts "Invitations ·" with a synced mailbox's address (Google and Outlook), has "My events", "Nam · nam@gmail.com" (and the other synced calendars) and the two kept Invitations entries; `rail` the same names as tooltips / labels.
- P-colour: "Only by mail (Google)" `#039be5`, "Only by mail (Outlook)" `#0078d4`, "Planning twin" `#039be5` (the synced copy), each of the three twins exactly once (so three rows, not six), "Design review" (IMAP mailbox) not one of the two calendar colours.
- P-popline: `notes` contains the translated line with "Google Calendar" / "Outlook" for the two invitations without a twin, no note for "Planning twin" (the synced copy) and for "Design review"; each note `over` <= 1 and `right` <= `box[2]` - 8; `box[3]` <= `vh`; `buttons` include the three answers.
Engine features relied on: nothing new (the notice line uses the existing `muted small` classes; the colour is the existing `--ev` custom property).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-7f.3 | Mac, Linux | the folded sidebar and rail, the colour, the twin rows and the popover line (items 1 to 4), en, de, ja, ru at 1280 x 800, light and dark; the popover line also at 960 x 560 | P-fold, P-colour, P-popline | as above | OPEN |

## WP9c Language on demand (coder, `feature/v107-wp9c`)

Nothing here was run on a Mac or Linux. Windows (Chromium, dev preview): `node scripts/test-lang-switch-ui.mjs --require-browser` and `node scripts/test-lang-load.mjs`.

No CSS, layout, font or text-length change. What changes for the engine: the dictionary of every language but English and its date-fns locale are now JavaScript modules fetched by `import()` at run time (`/assets/lang-<code>-<hash>.js`, same origin, same `script-src 'self'`, the way `kitExtensions` and the emoji names are fetched already), the saved language is fetched before the first render, and a language switch waits for its chunk (a few ms from memory, one file fetch the first time) and then changes the whole window in one step. The page language (`html[lang]`, which the `:lang()` CJK font stacks read) changes in the same step as the texts.

Visible changes, what to look at (Mac WKWebView and Linux WebKitGTK):
1. **Start in a saved non-English language** (Mac: ja, Linux: de; restart the app): the first frame the window shows is already in that language; no English word in the ribbon, folder pane, list header; the start screen (index.html) covers the window until then.
2. **Switch** English -> 日本語 (Mac) / Deutsch (Linux) in the header menu and in Settings > General > Language: the whole window changes at once, nothing in two languages, no raw key, the CJK font of `:lang(ja)` is applied in the same frame (the computed font family is recorded below).
3. **Chunks**: only the saved language's chunk is fetched at start (no other `lang-*` resource); a second switch back and forth fetches nothing again.
4. **Failure** (debug build only, dev preview `#langfail=fr`): not testable in a release build.

Probes (test bridge `eval`, window `main`; a release or debug kit):
- P-chunks (items 1 and 3): `JSON.stringify(performance.getEntriesByType("resource").map(r=>r.name).filter(n=>/lang-[\w-]+-/.test(n)).map(n=>/lang-([\w-]+)-[\w-]+\.js/.exec(n)?.[1]))`
- P-lang (items 1 and 2): `JSON.stringify({lang:document.documentElement.lang,font:getComputedStyle(document.body).fontFamily,ribbon:[...document.querySelectorAll(".ribbon button")].slice(0,8).map(b=>b.textContent.trim())})`
- P-arm then P-read (item 2, time of a switch): P-arm `(()=>{window.__lp={t0:0,last:0};document.addEventListener("click",()=>{window.__lp.t0=performance.now()},true);new MutationObserver(()=>{window.__lp.last=performance.now()}).observe(document.body,{subtree:true,childList:true,characterData:true});return "armed"})()`; then click the header language button (`.lang-btn`) and the language in the list with the bridge `click` (two clicks; the second is the one measured); then P-read `JSON.stringify({lang:document.documentElement.lang,ms:Math.round(window.__lp.last-window.__lp.t0),font:getComputedStyle(document.body).fontFamily})`.

PASS (numbers):
- P-chunks right after a start with a saved language X: exactly one entry, `X`; after switching to Y and back, `X` and `Y` once each, none twice.
- P-lang: `lang` equals the saved language (`ja`, `de`) on the first read after the window is shown; `ribbon` has no English word (compare with the English ribbon: Mail, Calendar, ...); `font` for `ja` starts with the Japanese stack of `App.css :lang(ja)` (record the first family on each platform).
- P-read: `ms` <= 300 for a language whose chunk is already loaded, <= 600 for the first switch to a language (AC-9.1.3 counts the loaded case on the debug kit; the first fetch from the app bundle is a local file); `lang` is the new language; no text of the old language left (a screenshot after 1 s).

Engine features relied on: dynamic `import()` of a module chunk under the `tauri://` custom scheme (Safari 11.1+, WebKitGTK 2.20+; the app already does this for `kitExtensions`, `insertUi`, `pasteClean` and the emoji names), `Promise.prototype.finally` (Safari 11.1+), `Intl.PluralRules` (Safari 13+, unchanged), `document.documentElement.lang` for `:lang()`. A failed dynamic import is not cached by current WebKit (the spec changed in 2023; WKWebView on macOS 11 may keep a failed module request in its module map until the page reloads: then a second try after a failure shows the same error; a restart fixes it; it needs a deleted or unreadable chunk file, which a signed app does not have).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-9c.01 | Mac (ja), Linux (de) | start with the saved language, restart, first frame, 960 x 560 and 1280 x 800 | P-chunks, P-lang | as above | OPEN |
| WK-9c.02 | Mac (ja), Linux (de) | switch from English in the header menu and in Settings, the whole window at once; record the computed font family | P-arm, P-read, P-lang | as above | OPEN |
| WK-9c.03 | Mac, Linux | switch through all 8 languages one after the other: no raw key, no half-switched window (screenshot 1 s after each) | P-lang, screenshot | no text left in the previous language | OPEN |


## WP15 APT repository: the About text of an apt-managed copy and the "Install with APT" block of the download page (coder, `feature/v107-wp15`, head 530d13e)

Two visible changes. Nothing was run on a Mac or on Linux by the coder (Windows Chrome only: `scripts/test-about-managed.mjs`, 372 checks, and `scripts/test-site-appearance.mjs --only=apt`, 48 pages, also with 6 % extra letter spacing). The rows below are for the Mac + Linux QA session; PASS only from a real run.

### WK-15.1 Settings > About of a copy updated by apt (the app, Mac and Linux)

What changes: on a `.deb` with the Hey Look! APT source, Settings > About shows the version, `updates.managed.apt` (muted small text with `sudo apt update && sudo apt upgrade` in an inline `<code>`), then the privacy sentence; no "Check for updates" button, no automatic-check switch. On Mac and on the Linux ARM VM there is no apt copy: use a DEBUG build started from a terminal with `HEYLOOK_TEST_MANAGED=apt` (release builds ignore the variable; `HEYLOOK_TEST_MANAGED=none` or unset = the normal block). Open Settings > About in each of the 8 languages (Settings > General > Language), at 960 x 560 and 1280 x 800 (bridge `GET /windows` logical size), light and dark.

Probe (P-about-apt, a bridge function body, DOM calls only, window = the main window with Settings open on About):

```
const body=document.querySelector('.settings-body');const p=[...document.querySelectorAll('.settings p.muted.small')].find(x=>x.querySelector('code')&&/apt/.test(x.querySelector('code').textContent));if(!p)return JSON.stringify({found:false});const c=p.querySelector('code');const R=e=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom].map(n=>Math.round(n*10)/10)};const tn=[...p.childNodes].find(n=>n.nodeType===3&&n.textContent.trim());const rg=document.createRange();rg.setStart(tn,0);rg.setEnd(tn,1);return JSON.stringify({found:true,text:p.textContent,code:c.textContent,para:R(p),codeBox:R(c),body:R(body),scrollsX:body.scrollWidth>body.clientWidth+1,line:Math.round(rg.getBoundingClientRect().height*10)/10,buttons:document.querySelectorAll('.settings .update-status button').length,switches:document.querySelectorAll('.settings [role=switch],.settings input[type=checkbox]').length,font:getComputedStyle(p).fontFamily,codeFont:getComputedStyle(c).fontFamily})
```

PASS (numbers):
- `found` true; `code` is exactly `sudo apt update && sudo apt upgrade`; `text` has no `{command}`, no `updates.managed`, no `&amp;`; the sentence equals the dictionary text of the language with the command in place (src/i18n, key `updates.managed.apt`).
- `buttons` 0 and `switches` 0.
- `scrollsX` false; `codeBox` left >= `body` left - 0.5 and right <= `body` right + 0.5; `codeBox` width <= `para` width + 0.5.
- `codeBox` height <= 2 x `line` + 6 (the command is one line, or two when the paragraph is narrow and it wraps at a space; Chrome on Windows: 14.8 px in en/vi/fr/es/de, 13.8 px in ru, 29.5 px (two lines) in zh-Hans and ja at 960 x 560 and 1280 x 800).
- Record `font` and `codeFont` (computed family) on each system; the inline `code` uses the app's `code { font-size: .92em; padding: 1px 5px }` and the system monospace.
Engine features relied on: none new (`code`, `p.muted.small`, flow layout; no clamp(), :has(), dvh, container queries).
Fallback: none needed.

### WK-15.2 "Install with APT" block of the download page (website, WebKit: Safari on the Mac, Epiphany/WebKitGTK or Firefox on Linux)

What changes: `<details id="apt">` in the Linux card (`#card-linux`) between the .rpm row and "Notes for Linux", closed by default: a summary, a lead, 3 numbered steps each with a copy box, the fingerprint (10 groups of 4 in `<code>`), a "gpg --show-keys" box, an "already installed" line, the remove box. Five `.copy` boxes (the existing component: a single-line `code` that scrolls inside itself, `white-space: nowrap; overflow-x: auto`, and the page's Copy button). Look at it in the 8 languages at 375 x 812 (a phone-width window), 960 x 560 and 1280 x 800, light and dark, with the block open; Copy of box 1 and box 3, pasted into a text field.

Probe (P-apt-block): the whole expression `APT_PROBE` of `scripts/lib/site-apt-probe.mjs` pasted into the console of the page (Safari: Develop > Show JavaScript Console; or `osascript` `do JavaScript`), after the page loaded. It opens the block and returns `{bad:[...], info:{...}}`.

PASS (numbers):
- `bad` is an empty array. That means: `document.documentElement.scrollWidth <= innerWidth` (no sideways page scroll); exactly 5 `.copy` boxes; each command box and each Copy button lie inside the Linux card (`left >= card.left - 0.5`, `right <= card.right + 0.5`); each box has `overflow-x: auto`; each Copy button >= 24 x 24 px; the summary <= 3 lines; no paragraph wider than its box; the fingerprint is `([0-9A-F]{4} ){9}[0-9A-F]{4}` and inside the card.
- `info.commandScroll` shows how many px each command overflows its box (Chrome 1280 px: 784, 632, 142, 286, 792 in en: the box scrolls, the page does not); the same box shows the end of the command when scrolled.
- Copy puts the exact command (decoded text of the `code`, e.g. `sudo apt update && sudo apt install hey-look`) on the clipboard and the button says the page's "Copied" for 1.6 s (clipboard needs the user gesture; Safari asks nothing for a click).
- Record `info.bodyFont` and `info.codeFont` (computed families) and the screenshot `webkit-107-<mac|linux>-WK-15.2-<lang>-<WxH>-<light|dark>.png`; the French page has U+00A0 before ":" and "?" (no line starting with a lone colon: look at fr at 375 px).
Engine features relied on: `<details>`/`<summary>` (WebKit supports it since Safari 6; macOS 11 and WebKitGTK 2.40 fine), `display:flex; flex-wrap`, `overflow-x:auto` on an inline-block `code`, `overflow-wrap:anywhere` (Safari 15.4+; the fingerprint paragraph has spaces, so older WebKit still wraps at the groups), `:focus-visible` (existing), `navigator.clipboard.writeText` (secure context; the site is https). No clamp(), no :has(), no dvh, no color-mix.
Fallback: on a WebKit without `overflow-wrap:anywhere` a very long unbroken token could widen a paragraph: the only such token is a path/URL inside a `code`, which scrolls in its box (`white-space: nowrap`), so nothing depends on it.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-15.1 | Mac, Linux (debug build with `HEYLOOK_TEST_MANAGED=apt`) | Settings > About in 8 languages, 960 x 560 and 1280 x 800, light and dark | P-about-apt | as above | OPEN |
| WK-15.2 | Mac (Safari), Linux (Epiphany/WebKitGTK and Firefox) | the open APT block of the download page, 8 languages, 375 / 960 / 1280 px, light and dark; Copy of box 1 and 3 | P-apt-block | `bad` empty, no sideways page scroll, Copy puts the exact command | OPEN |

## 29. Fix batch 18 (coder, `feature/v107-fix18`): the calendar offer in the side menu keeps the address on one line (D-066); Unsubscribe shows a working state and ends in a toast (D-065)

Nothing here was run on a Mac or on Linux by the coder. Windows (headless Chrome, Segoe UI Variable Text) was measured with the probes below; a stand-in for wider WebKit fonts (+6 % and +10 % letter spacing on the notice) was measured too, the numbers are in the PASS lines. The engine features are listed with their fallbacks. Source: `coder-v107-fix18.md`.

Visible changes, what to look at:
1. **The calendar offer** (`Calendar.tsx`, `.cal-offer`, `App.css`): the e-mail address is its own element `span.cal-email` (`display:inline-block; max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; vertical-align:bottom`, `title` = the whole address). The rest of the sentence wraps as before. The Japanese sentence is now `{email}の{service}のカレンダーも表示しますか？` (the other 7 languages are unchanged). Look at it in Calendar with the side menu open in full (window at least about 1100 px wide, or open the menu with the toggle / Ctrl+B / Cmd+B) for a mailbox that qualifies (the Gmail app-password mailbox of the Linux round 7, or a Google / Microsoft mailbox without calendar sync), default menu width 248 px, in 8 languages.
2. **Unsubscribe working state** (`ReadingPane.tsx`, `.unsub-link`): the "Unsubscribe" link of the newsletter notice ("This looks like a newsletter. Unsubscribe") gets `aria-busy="true"`, the cursor `progress` and a small ring (11 px, `position:absolute`, right after the word) from the press until the outcome; the entry "Unsubscribe" of the More menu is disabled meanwhile. The ring takes no room: the notice does not change its height or wrap again. With "Reduce motion" the ring is replaced by three dots (the shared `.busy-ring` / `.busy-dots` rule).
3. **The two info toasts** `reading.msg.unsubscribeOpened` (two sentences, the longest texts: fr 120, de 118, es 117 characters; ja 51) and `reading.msg.unsubscribeMailto` (13 to 61 characters). Both stay 9 s. Look at them at 960 x 560 and 1280 x 800 in 8 languages: whole text, no clipped line, inside the window.

Probes (each prints JSON; both kinds are expressions that evaluate to a JSON string, so they run through the test bridge `eval main` and a CDP `Runtime.evaluate` alike; no store needed):
- **P-offer** = `OFFER_JS` of `scripts/lib/offer-probe.mjs` (print it with `node -e "import('./scripts/lib/offer-probe.mjs').then(m=>console.log(m.OFFER_JS))"` and paste the text into the bridge). Needs `.cal-offer` on screen. It measures copies of the notice inside hidden boxes of 248 px (the default side menu) and 180 px (the narrowest), once with the mailbox's own address and once with a 52 character one (`a.very.long.address.for.testing@example-company.com`), and removes them again: the live page is not changed and no splitter has to be dragged. Result: `found, lang, font` (the computed font family: RECORD IT), `fontSize, lineHeight, text, live{width,lines}` and `rows[]` with `w, email ("real" or "long"), lines, over, inside, buttons, emailLines, emailCut, emailTitleOk, emailNowrap`. In the repo `verdict(p)` of the same module lists what breaks the pass criteria.
- **P-unsub-busy** (needs a newsletter in the stub mailbox, DEC-021 fixtures), two bridge calls. Before the press: `return JSON.stringify((()=>{const l=document.querySelector('.rp-msg-body .notice .unsub-link');if(!l)return {found:false};const r=l.getBoundingClientRect(),n=l.closest('.notice').getBoundingClientRect();window.__u={w:r.width,h:n.height};return {found:true,w:r.width,h:n.height,busy:l.getAttribute('aria-busy')}})())`. Then press Unsubscribe with a real click, and within 1 s (use the never-answering server mode so the state lasts): `return JSON.stringify((()=>{const l=document.querySelector('.rp-msg-body .notice .unsub-link');const ring=l&&l.querySelector('.busy-ring'),r=l&&l.getBoundingClientRect(),n=l&&l.closest('.notice').getBoundingClientRect(),cs=l&&getComputedStyle(l),rr=ring&&ring.getBoundingClientRect();return {busy:l&&l.getAttribute('aria-busy'),cursor:cs&&cs.cursor,w:r&&r.width,h:n&&n.height,same:!!window.__u&&Math.abs(window.__u.w-r.width)<0.5&&Math.abs(window.__u.h-n.height)<0.5,ring:rr?{w:ring.offsetWidth,h:ring.offsetHeight,display:getComputedStyle(ring).display,anim:getComputedStyle(ring).animationName,pastNotice:Math.round(rr.right-n.right)}:null,dots:l&&getComputedStyle(l.querySelector('.busy-dots')).display,reduce:matchMedia('(prefers-reduced-motion: reduce)').matches,menu:[...document.querySelectorAll('button[role=menuitem]')].map(b=>[b.textContent.trim(),b.disabled])}})())`.
- **P-toast** (while the info toast is up): `return JSON.stringify((()=>{const t=document.querySelector('.toasts .toast'),x=t&&t.querySelector('.toast-text');if(!t)return {found:false};const r=t.getBoundingClientRect(),lh=parseFloat(getComputedStyle(x).lineHeight)||parseFloat(getComputedStyle(x).fontSize)*1.4;return {found:true,text:x.textContent.trim(),cls:t.className,over:x.scrollWidth-x.clientWidth,overY:x.scrollHeight-x.clientHeight,lines:Math.round(x.getBoundingClientRect().height/lh),left:Math.round(r.left),right:Math.round(r.right),top:Math.round(r.top),bottom:Math.round(r.bottom),vw:innerWidth,vh:innerHeight,font:getComputedStyle(x).fontFamily}})())`.

PASS (numbers):
- P-offer: `verdict` is `[]`. In numbers, for every `rows[]` entry: `over` <= 1, `inside` true, `buttons` 2, `emailLines` 1, `emailTitleOk` true, `emailNowrap` true; at `w` 248: `lines` <= 4 for BOTH addresses in all 8 languages (AC-D066.1); the long address has `emailCut` true (the ellipsis, AC-D066.2); at `w` 180 no line limit but `over` <= 1 and both buttons `inside` (AC-D066.3). Windows (Segoe UI Variable Text, 1280 x 800) measured, lines at 248 px with the short address / the long one: en 3/4, vi 3/4, fr 3/4, zh-Hans 3/4, es 3/4, ja 3/3, de 3/4, ru 3/4; at 180 px: en 4/4, vi 4/4, fr 5/5, zh-Hans 4/4, es 5/5, ja 4/4, de 5/5, ru 5/5. With a wider stand-in font (+6 % letter spacing) the long address needs 5 lines at 248 px in es and de (4 in the others), the short address 4 in fr, es, de, ru; with +10 % the same two languages are 5 with the long address and the short one is 4 everywhere. **If a WebKit font is that much wider, es and de with the 52 character address can be 5 lines: report the number and the font.** That would be a finding for the BA: the layout cannot make a 60 character sentence, a 224 px address line and two buttons fit in 4 lines in a wider font; the lever would be a shorter es / de sentence (new text, specialist round).
- `live.lines` of the real offer on the Linux round-7 VM at 1280 x 800, default width, with `nam.work@gmail.com`: <= 4 in all 8 languages, ja included (it was 5 before; 3 on Windows).
- ja: `text` equals `nam.work@gmail.comのGoogle Calendarのカレンダーも表示しますか？ オンにする… 今はしない`.
- P-unsub-busy: before the press `busy` null; within 100 ms of the press (a real click) `busy` "true", `cursor` "progress", `same` true (the link and the notice keep their size within 0.5 px), `ring` `{w:11,h:11,anim:"spin"}` (offset sizes: the turning ring's bounding box is bigger) and `pastNotice` <= 6 (the ring lies at most 6 px past the notice's right edge, inside its 12 px padding), or with `reduce` true `ring` null or `display` "none" and `dots` "inline"; with the More menu opened while busy (before the second call) the entry "Unsubscribe" (or its translation) has `disabled` true in `menu`. After the outcome `busy` is null again and the ring is gone.
- P-toast: `cls` contains "info"; `text` equals the dictionary text of the language; `over` <= 1 and `overY` <= 1; `lines` <= 4 (the toast is at most 520 px wide and 92 vw); `left` >= 0, `right` <= `vw`, `bottom` <= `vh`. Windows measured: no clipping in en, de, ja at both sizes (`scripts/test-unsub-outcomes.mjs`).
- Engine features relied on, and the fallback when one is missing: `display:inline-block` with `max-width:100%`, `overflow:hidden`, `text-overflow:ellipsis`, `white-space:nowrap` (every WebKit; `vertical-align:bottom` is needed because an `overflow:hidden` inline-block puts its baseline at the bottom margin edge, which would lift the line); a `position:absolute` ring inside a `position:relative` inline-flex button (every WebKit); the `title` attribute for the full address (a tooltip on hover; a screen reader reads the element's text, which is the whole address, the ellipsis is only drawn); `cursor:progress`; `aria-busy`. Nothing new: no clamp(), :has(), dvh, color-mix, container queries or logical properties. No fallback needed. Note for QA scripts: the address span is now the first element child of the notice, so `button.link:first-child` no longer matches the first button; use `button.link:nth-of-type(1)` or the text.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-F18.01 | Linux (WebKitGTK 2.40+, the round-7 VM, 1280 x 800, Calendar, menu 248 px) | the offer for `nam.work@gmail.com` in 8 languages, light and dark; record the font family | P-offer | `verdict` empty; `live.lines` <= 4 in all 8 (ja was 5) | OPEN |
| WK-F18.02 | Mac (WKWebView, macOS 11, 12 and 14 if available), Linux | the offer with the long address (the probe's copy) at 248 px and 180 px in 8 languages; hover on a long address shows the full address | P-offer | as above; `emailCut` true for the long address; `lines` <= 4 at 248 px (es and de: report the number, see the note) | OPEN |
| WK-F18.03 | Mac, Linux | the Japanese text is the new one; the other 7 unchanged | P-offer (`text`) | ja `text` ends `カレンダーも表示しますか？ オンにする… 今はしない`; en `Also show the Google Calendar calendars of nam.work@gmail.com here? Turn on… Not now` | OPEN |
| WK-F18.04 | Mac, Linux | Unsubscribe pressed on the DEC-021 fixtures (trusted, self-signed, closed port, never-answering, mailto, body link): the ring and the toast of each | P-unsub-busy, P-toast | busy within 100 ms; no size change; toast text = dictionary text; one `[unsub +ms]` line of `startup.log` per outcome (`post <host>: ok 200` or `failed tls|timeout|connect|dns|http 500`, `open <host>: ok` or `failed ...`, `mailto`, `body-link <host>`, `no target`) | OPEN |
| WK-F18.05 | Mac, Linux | the two info toasts in 8 languages at 960 x 560 and 1280 x 800 | P-toast | `over` <= 1, `overY` <= 1, inside the window | OPEN |

Windows checks run by the coder: `node scripts/test-calendar-at-signin.mjs` (the offer: probe verdict for the languages of the run, the long address at 960 x 560 and 1280 x 800, the 180 px menu), `node scripts/test-unsub-outcomes.mjs` (busy, outcomes, toasts), `node scripts/test-unsub-server.mjs --require-openssl`, `cargo test --lib unsub`; see `coder-v107-fix18.md`.

## 28. WP13f-1 Reply / Reply all / Forward open at once (coder, `feature/v107-wp13f1`, W13.13, D-064)

Nothing here was run on a Mac or Linux. Windows (Chromium, dev preview with the mock backend): `node scripts/test-reply-feedback.mjs --require-browser` (shell, fill, Discard / Esc, failing server, Forward with attachments, a window of its own, the two texts in 8 languages at 960 x 560 and 1280 x 800 in light and dark, reduced motion) and `node scripts/measure-reply-open.mjs --require-browser` (the timing table in `coder-v107-wp13f1.md`); the pure logic (order of the steps, repeat press, Discard while it prepares, safety end, hand-over to a window) is `node --experimental-strip-types scripts/test-answer-shell.mjs`; the Rust side (stored headers, header-only fetch) is `cargo test --lib reply_header` and `an_older_mail_file_gets_the_reply_hdr_column`. On a Mac / Linux only what the page draws and how fast it draws it can differ.
The kit's stub mailbox needs one long message (about 2 MB HTML with pictures, or the 19 MB draft's sibling the kit already has) in the Inbox, opened in the reading pane; the stub IMAP server with a delay per command (`HEYLOOK_TEST_IMAP_DELAY_MS`, 300) makes the old path visible: a message synced by this build answers `startup.log` `[reply] headers: stored` and the stub log shows no FETCH for that Reply; a message stored by an older build shows `headers: header-fetch` and `BODY.PEEK[HEADER]` (never `BODY.PEEK[]`) once, then `stored`.

Visible changes, what to look at:
1. **The shell** (Reply / Reply all / Forward in the reading pane, also R / Shift+R / F): the compose pane is there within one frame of the press, with the header rows in place (From, To, Cc / Bcc links, Subject filled with `Re: ...` / `Fwd: ...`), the From / To / Cc / Subject fields and the formatting row dimmed and not clickable, Send and its caret disabled, the action row dimmed except Discard, and in the body (the white / dark preview surface) a centred ring with "Preparing reply…" (Forward: "Preparing forward…", with attachments "Getting the attachments…"). The status appears about 140 ms after the press when the work is not done (a quick open never shows it) and stays at least 300 ms. The focus is on the body box (no ring drawn); Esc or Discard ends it.
2. **The fill**: the message replaces the shell in one step (no fade, no second animation); the To field's box (x, y, width, height) is the same +- 1 px; the caret goes to the top of the body when there are recipients.
3. **A window of its own** (Settings > Composing "Open in a separate window", or Shift+Reply): the window appears (<= 600 ms) with the same shell and the status (no white window), then fills; the Reply button in the reading pane shows a ring in place of its icon from the press until the window is asked for (at least 300 ms), same size.
4. **Texts**: the two new strings in the 8 languages, not clipped, in the font of the language (de, ja, ru, vi: long words).
5. **Reduced motion**: the dots instead of the ring.

Probes (the script prints JSON; the function bodies are for the bridge):
- P-reply (items 1 and 2, the timing): `node scripts/lib/reply-open-probe.mjs <data folder | test-bridge.json | port:token> main Reply` with a message open in the reading pane (`Reply all`, `Forward` for the other buttons). It installs a recorder, presses the button with `.click()` and prints `{ shellMs, statusMs, statusGoneMs, filledMs, pressMs, gapMax, longTaskMax, toMovedPx, shellState, statusText, pass }`.
- P-shell (item 1, what the shell looks like; run while it prepares, e.g. with the stub delay): `const p=document.querySelector('.compose-pane');if(!p)return JSON.stringify(null);const s=p.querySelector('.cp-prep [role=status]');const to=p.querySelectorAll('.cp-fields .cf-field')[1];const r=to.getBoundingClientRect();return JSON.stringify({preparing:p.classList.contains('preparing'),fieldsInert:p.querySelector('.cp-fields').hasAttribute('inert'),fmtInert:p.querySelector('.cp-fmt').hasAttribute('inert'),sendDisabled:p.querySelector('.split-btn .btn.primary').disabled,barOff:[...p.querySelectorAll('.cp-bar > :not(.cp-keep)')].every(e=>e.hasAttribute('inert')),pointer:getComputedStyle(p.querySelector('.cp-fields')).pointerEvents,status:s?{text:s.querySelector('p').textContent.trim(),busy:s.getAttribute('aria-busy'),ring:getComputedStyle(s.querySelector('.busy-ring')).display,dots:getComputedStyle(s.querySelector('.busy-dots')).display}:null,focusOnBody:document.activeElement.classList.contains('cp-prep'),to:[r.left,r.top,r.width,r.height].map(Math.round),subject:p.querySelector('.cf-subject input').value})`
- P-fit (item 4, status text at the window size in use): `const e=document.querySelector('.cp-prep [role=status] p');if(!e)return JSON.stringify(null);const r=e.getBoundingClientRect(),b=document.querySelector('.cp-editor').getBoundingClientRect();return JSON.stringify({text:e.textContent.trim(),clipped:e.scrollWidth>e.clientWidth+1,inside:r.left>=b.left&&r.right<=b.right&&r.top>=b.top&&r.bottom<=b.bottom,lines:Math.round(r.height/parseFloat(getComputedStyle(e).lineHeight)),font:getComputedStyle(e).fontFamily,size:getComputedStyle(e).fontSize,color:getComputedStyle(e).color,w:innerWidth,h:innerHeight})`
- P-busybtn (item 3, in the main window while the window is being made): `const bs=[...document.querySelectorAll('.rp-msg.open .rp-msg-actions .icon-btn')].slice(0,3).map(b=>{const r=b.getBoundingClientRect();return {label:b.getAttribute('aria-label'),busy:b.getAttribute('aria-busy'),ring:!!b.querySelector('.spin'),box:[r.left,r.top,r.width,r.height].map(x=>Math.round(x*10)/10),cursor:getComputedStyle(b).cursor}});return JSON.stringify(bs)` (run it once idle and once within 300 ms of the press: the boxes are the same +- 1 px)

PASS (numbers):
- P-reply: `shellMs` <= 200 (pane), `pressMs` <= 200, `statusMs` <= 200 or null (null only when `filledMs` < 150), `filledMs` not null, `statusGoneMs - statusMs` >= 300 when the status was shown, `toMovedPx` <= 1, `gapMax` < 500; `longTaskMax` is null on WebKit (no Long Task API) so `gapMax` is the number there; on a release build of the 2 MB mail the quote and the editor come ~2.5 s after the press with stored headers (AC-13.13.1), a mail with nothing slow (20 KB) is complete <= 300 ms with `statusMs` null.
- P-shell: `preparing` true, `fieldsInert`, `fmtInert`, `sendDisabled`, `barOff` all true, `pointer` "none" (the fallback where `inert` is not supported), `status.text` the string of the language, `status.busy` "true", `ring` "none" and `dots` not "none" only under reduced motion, `focusOnBody` true, `subject` starts with `Re: ` / `Fwd: `. After the fill the same call returns `preparing` false and `to` the same four numbers +- 1.
- P-fit: `clipped` false, `inside` true, `lines` <= 2 in en / fr / es / ja / zh-Hans and <= 3 in de, ru, vi at 960 x 560 and 1280 x 800, `color` readable on the preview surface (light preview: dark grey; dark preview: light grey), the font of the language (de: the UI font; ja: a CJK family, not the Latin fallback box height).
- P-busybtn: `busy` "true" and `ring` true on the pressed button within 100 ms of the press, `box` identical +- 1 px to the idle call, `cursor` "progress".
Engine features relied on: the `inert` attribute (Safari 15.5, macOS 12.3+; WebKitGTK 2.36+; the pane is already inert while it sends), with the fallback `pointer-events: none` and a focus catch for an engine without it (macOS 11 with an older Safari engine); `requestAnimationFrame` (not delivered to a hidden window: the paint wait ends after 100 ms by itself); `useSyncExternalStore`; `crypto.randomUUID()` (already used by Compose); CSS custom properties `--pv-muted` / `--pv-rule` (existing); no `clamp()`, `:has()`, `dvh`, `color-mix` and no scroll-padding in the new rules.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-28.01 | Mac, Linux | Reply on a long mail in the pane: the shell at once, the status, the fill, the To box (item 1, 2), 1280 x 800, light and dark | P-reply, P-shell | as above | OPEN |
| WK-28.02 | Mac, Linux | Reply all and Forward (the stub message with 3 attachments: "Getting the attachments…", no toast) | P-reply, P-shell | as above, `statusText` "Getting the attachments…" for the Forward with files | OPEN |
| WK-28.03 | Mac, Linux | the two texts in en, de, ja, ru, vi at 960 x 560 and 1280 x 800, light and dark, with the computed font family | P-fit | as above | OPEN |
| WK-28.04 | Mac, Linux | a window of its own (Shift+Reply): the window <= 600 ms with the status, no white window, then the fill; the Reply button ring (item 3) | P-shell in the compose window, P-busybtn in the main window | as above | OPEN |
| WK-28.05 | Mac, Linux | Discard and Esc while it prepares: no draft in Drafts, no toast, the late result does not open it again; a second press in window mode only brings the window forward | Drafts list, `startup.log` `[reply]` lines | no draft, no toast, one window | OPEN |
| WK-28.06 | Mac, Linux | reduced motion (macOS: Accessibility > Display > Reduce motion; Linux GNOME: Settings > Accessibility > Reduce animation): dots instead of the ring | P-shell | `ring` "none", `dots` not "none" | OPEN |
| WK-28.07 | Mac (macOS 11 / 12.0 if one exists) | an engine without `inert`: the fields and the action row cannot be clicked or tabbed into while it prepares | P-shell (`pointer`), Tab key | `pointer` "none", Tab reaches only Discard and the body box | OPEN |

## 30. WP9d Lazy UI: the editor, Settings, the Calendar, the PGP dialogs and the pop-out views load on demand (coder, `feature/v107-wp9d`, W9.2, REQ-9.2.1 - 9.2.7)

Nothing here was run on a Mac or on Linux by the coder. Windows (headless Chrome, dev preview with the mock backend and the DevTools network conditions as a slow disk) was measured with the probe below and `node scripts/test-lazy-views.mjs --require-browser` (83 checks); the numbers are in the PASS lines. Source: `coder-v107-wp9d.md`. The engine features are listed with their fallbacks.

Visible changes, what to look at (all of them are about the FIRST open of a part in a run; the second open is the same as before):
1. **Settings** (gear in the top bar, or any "open Settings" entry): the dialog box with the title "Settings" appears at once; "Loading…" with a ring appears in its body only if the contents take more than 150 ms; then the contents replace it. A dialog that was loaded on demand opens WITHOUT the pop animation (the frame and the dialog are one picture: no second fade). Focus is inside the dialog (the box), Esc closes it.
2. **Calendar** (the Calendar button of the side menu, Ctrl/Cmd+2): the empty pane is there at once, "Loading…" after 150 ms, then the Week view; the side menu content of the Calendar (mini month, calendars) arrives with it.
3. **The PGP dialogs** (Settings > a mailbox > Security > Generate key / Import key / Key details, the "Import key" of a message): the dialog frame with its title at once, the contents after the load.
4. **New mail / Reply / Reply all / Forward** as the first message after the start: the editor is fetched when the browser is idle after the first paint (WebKit has no `requestIdleCallback`: a timer of 1 s) and when the pointer or the keyboard focus reaches New mail / Reply / Reply all / Forward, so the pane normally opens with the editor in the same frame. If it is not there yet, the pane shows its frame: the action row with Send off and Discard on, the fields (From / To / Subject) dimmed, and for a Reply the status "Preparing reply…" (140 ms after the press), or "Loading…" in the body after 150 ms for any other message. The To field gets the caret when the editor is there.
5. **Pop-out windows**: the compose window loads its view and the editor before it draws and shows its body; the reader window never loads the editor.
6. **A part that cannot be loaded**: one retry after 500 ms, then the toast "Failed: ..." (the existing text, 8 languages), nothing half open (the dialog closes, Calendar goes back to Mail, the compose pane closes), and the next try loads again. In a window with no other place to be (a pop-out) a Retry button is shown instead.
7. **Layout**: the new CSS is `.lazy-load` (a flex box centred in the place of the part, `min-height: 96px`, 13 px text with the ring) and `:root[data-lazy-handoff] .modal-back, .modal { animation: none }`. Nothing else changed in the layout; the compose frame reuses the classes of the real pane (`compose-pane`, `cp-head`, `cp-bar`, `cp-fields`, `cp-fmt`, `cp-editor`, `cp-prep`).

Probes:
- **P-lazy** = `scripts/lib/lazy-open-probe.mjs`: `node scripts/lib/lazy-open-probe.mjs <data folder | test-bridge.json | port:token> main settings` (kinds `settings`, `calendar`, `compose`, `reply`; a message must be open for `reply`; the window must be fresh, i.e. the app was started and the part not opened yet). It installs a recorder in the page, presses the button of the kind with `.click()` and prints `{ kind, frameMs, lookMs, partMs, focusMs, anims, handoff, gapMax, longTaskMax, chunks: [{ name, start, ms, bytes }], ua, problems, pass }`. For the bridge expression forms: `PROBE_INSTALL`, `PROBE_PRESS`, `PROBE_READ` of the same module, with `__KIND__` replaced by the kind (`fill()`).
- **P-chunks** (item 5, what a window loaded): `return JSON.stringify(performance.getEntriesByType('resource').map(r=>r.name.split('/').pop().split('?')[0]).filter(n=>/\.(js|mjs)$/.test(n)))` in the reader window and in the compose window (`eval <label>`). The names are the hashed chunk names of the build (`ComposeView-*.js`, `Compose-*.js`, `dist-*.js` = the editor engine, `LinkPopover-*.js` = the editor framework, `ReaderView-*.js`).
- **P-startup** (B8): `the page reported itself ready` in `startup.log`, median of 5 starts (section 6.2 of the spec), on the WP9c head and on this head.

PASS (numbers):
- P-lazy `settings`, `calendar`: `frameMs` <= 100; `lookMs` null or between 140 and 300 (never below 140); `partMs` <= 300 on a warm disk (the first open of a run, AC-9.2.4 / 9.2.5); `focusMs` not null; `anims` 0; `handoff` true for Settings and false for the Calendar; `chunks` lists the files of the part (Settings: `SettingsDialog-*.js` + the shared ones it needs).
- P-lazy `compose` (New mail pressed 3 s after the start, the editor prefetched): `frameMs` and `partMs` both <= 100 (the editor is drawn in the same frame, `lookMs` null) and `focusMs` <= 300 (AC-9.2.2). Pressed within 300 ms of the start (the editor not there): `frameMs` <= 100, `partMs` <= 600, `lookMs` null or >= 140.
- P-lazy `reply` (the first Reply after the start, a 2 MB mail with the stub delay of WP13f-1): `frameMs` <= 200 (REQ-13.13.1; the shell does not wait for the editor), the status in the shell by 200 ms, the editor in after the headers (P-reply of section 28 gives `shellMs`, `statusMs`, `filledMs`, `toMovedPx` <= 1).
- P-chunks: the reader window's list has NO name matching `Compose`, `RichEditor`, `SettingsDialog`, `PgpDialogs`, `Calendar` and none of the editor engine chunks; the compose window's list has `ComposeView-*`, `Compose-*` and the editor engine chunks, and its body (`.compose-pane .ProseMirror`) is drawn <= 100 ms later than on the WP9c head (median of 5, AC-9.2.6).
- Windows dev preview (Chrome, a 450 ms network latency to make the load slow; `test-lazy-views.mjs`): Settings frame at 20 ms, loading look at 160 to 190 ms, dialog when the module arrived, no animation after it; Calendar pane at 20 ms, look at about 170 ms; New mail x3: one frame, one message, nothing typed into To. These are dev-server numbers, not release numbers.
- Engine features relied on, and the fallback: dynamic `import()` and `<link rel="modulepreload">` (Vite adds the preload helper; engines without `modulepreload`, i.e. Safari before 17, get `rel="preload" as="script"` from the same helper); `requestIdleCallback` (absent in WebKit: `setTimeout(…, 1000)` is used); `document.getAnimations()` (the probe only; Safari 13.1+); the `inert` attribute (existing: the frame's fields; the fallback `pointer-events: none` of the shell rule applies); `pointerover` / `focusin` with `closest()`; CSS attribute selectors on `:root`, `display:flex`, `animation:none`. Nothing new: no `clamp()`, `:has()`, `dvh`, `color-mix`, container queries or logical properties. The CSP (`script-src 'self'`) already allows the chunks (the language chunks and `kitExtensions` load the same way; paths are the page's own `/assets/...`).
- Known engine difference to look at: a failed dynamic `import()` is cached for the life of the document in Chromium (WebView2) but retried in WebKit. The code retries once after 500 ms and does not remember the failure; on WebView2 the second try of the same file in the same page can fail again until the page is reloaded (the person sees the toast again; a restart fixes it). This is a property of the engine and cannot be tested on a kit, because the kits embed the files (see WK-30.06).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-30.01 | Mac (WKWebView, macOS 11 / 12 / 14), Linux (WebKitGTK 2.40+) | the first open of Settings in a fresh start, light and dark, en / de / ja: frame, no second pop animation, the tabs, the signature editor (type, bold, a picture), Save | P-lazy `settings` | as above; the dialog does not blink when the contents arrive (look at it, no number) | OPEN |
| WK-30.02 | Mac, Linux | the first switch to Calendar (Week view), then Month; the side menu; the event dialog (c in the Calendar) and an invitation's "Add to calendar" | P-lazy `calendar` | as above | OPEN |
| WK-30.03 | Mac, Linux | the first New mail 3 s after the start (editor prefetched) and the first New mail within 300 ms after the start (cold); key `c` pressed 3 times at once: ONE message | P-lazy `compose` | as above; exactly one `.compose-pane`, To empty | OPEN |
| WK-30.04 | Mac, Linux | the first Reply after the start on the long mail of WP13f-1: the shell at once, the status, the fill | P-lazy `reply`, P-reply | as above | OPEN |
| WK-30.05 | Mac, Linux | a compose window (New mail with Shift, or the Pop out button) and a reader window (double click on a message): drawn, no white window; what each loaded | P-chunks, P-startup | as above | OPEN |
| WK-30.06 | Mac (Safari), Linux (Epiphany / GNOME Web) with the dev preview (`npm run dev`, `http://localhost:1420/#lazyfail=settings`) | the failure: open Settings, Calendar, a PGP dialog, New mail with the seam (`lazyfail=settings,calendar,pgp,compose`); the toast "Failed: ..." in en and de, nothing half open; remove the seam from the address, the next try opens it | `return JSON.stringify({dialog:window.__store.getState().dialog,module:window.__store.getState().module,toasts:window.__store.getState().toasts.map(t=>t.textFn?t.textFn():t.text)})` | `dialog` null, `module` "mail", the toasts start with "Failed:" / "Fehlgeschlagen:" | OPEN |
| WK-30.07 | Mac, Linux | the start: B8 (`startup.log`, median of 5) and B9 (60 s idle, memory) on the WP9c head and on this head | P-startup | not slower than the WP9c head (B8); memory not higher (B9); the initial JavaScript is 280,882 B gzip (was 486,351 B) | OPEN |

## 31. WP13a + WP13f-2: new-mail marker, no accidental text selection, "Opening message…", pending states (coder, `feature/v107-wp13a`, W13.2, W13.3, W13.6, W13.14)

Nothing here was run on a Mac or Linux. Windows (Chromium, dev preview with the mock backend): `node scripts/test-new-mail-ui.mjs`, `test-user-select-ui.mjs`, `test-open-loading.mjs`, `test-busy-actions.mjs` (each with `--require-browser`); the pure rules are `test-new-mail.mjs`, `test-user-select.mjs` and `test-pending-core.mjs` (`node --experimental-strip-types`); the Rust side is `cargo test --lib newmail`. On a Mac / Linux what can differ is the engine: `-webkit-user-select`, the sticky and absolute layers, the timing of the first paint and the fonts of the new words.
The kit's stub mailboxes need: two mailboxes A and B (B's Inbox selected), the stub able to deliver one unseen mail to A's Inbox on demand (and to a folder "Projects" of A), and one long message (about 2 MB HTML with pictures) in A's Inbox for item 3.

Visible changes, what to look at:
1. **New-mail marker** (W13.2). Open side menu: after a mail arrives in A's Inbox (F5 or the IDLE push) A's heading shows a dot right after the name and the name is darker; A's Inbox row (and the Favorites row of the Inbox) has the label at weight 650 and an 8 px dot right after the label, before the count; the tooltip of the Inbox row reads "Inbox", "N unread", "New mail" on three lines. The dot is round, in the accent text colour, never blinks; opening the folder removes it. In the icon column (window narrower than 1100 px or the menu folded) the avatar of A has a ring (2 px gap, 2 px line in the accent text colour) and a folder icon gets a 6 px dot at its top left corner; the avatar tooltip has "New mail" as the last line. Mail A sent to itself, a mail moved between folders (by Hey Look! or by another client) and mail in Sent / Drafts / Archive / Junk / Deleted Items never marks anything and shows no notification.
2. **No accidental selection** (W13.3). A double- or triple-click on a message row, a side-menu folder, the list's "Today" header, a Settings label, a toolbar button, a normal toast highlights nothing. The subject, the sender line, the To / Cc line, the date, the AI summary / translation box, the fingerprints in Settings > OpenPGP, the version line in Settings > About and the text of an error toast select (double-click a word, triple-click a line). Text fields (search box, To, Subject, Settings fields) and the compose body type, select and copy as before: this is the case most at risk on WKWebView, where an input under `-webkit-user-select: none` cannot be typed into unless it says `text` itself. A drag over the sender name does not fold the message; a double-click on it selects the word and leaves the message as it was.
3. **"Opening message…"** (W13.6). Click a conversation whose open is slow (the long message): the area under the subject is covered by a centred ring with "Opening message…" within about 150 ms, the subject and the toolbar stay where they are, the list still scrolls, and the block goes when the mail is drawn (never before, at least 300 ms after it showed). A quick mail (20 KB) shows no block at all. A big mail (500 KB or more) shows the block before the page goes busy. Double-click (reader window): the window shows the block from the first frame until the mail is drawn, with no blank body.
4. **Pending states** (W13.14). Ctrl+A in the list (30 or more conversations) then E: "Working on N conversations…" with a spinner toast after 100 ms when the move is not done, going with the result ("Archived" with Undo). Send with a big attachment in the main window: the Send button shows a ring (same width), then a "Sending…" toast with a ring, then the toast with Undo. More > Print (Windows / Linux): "Preparing to print…" over the reading pane while the dialog is prepared. A search, the Focused / Other tab or the filter with rows on screen: a small "Loading…" pill over the top of the list, no row moves. F5 / the sync button is marked busy while it syncs. New words: `app.busy.many`, `reading.print.preparing` in the 8 languages.

Probes (DOM only; the script prints JSON; the bodies are for the bridge):
- P-mark (item 1, run once idle and once right after an arrival): `const q=(s)=>[...document.querySelectorAll(s)];const box=(e)=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.width,r.height].map(Math.round)};return JSON.stringify({dots:q('.fp-tree .fp-new').map(d=>{const row=d.closest('.fp-row,.fp-head');const cs=getComputedStyle(d);return {in:row.className,text:row.textContent.replace(/\s+/g,' ').trim().slice(0,40),box:box(d),radius:cs.borderRadius,bg:cs.backgroundColor,anim:cs.animationIterationCount,weight:getComputedStyle(row.querySelector('.fp-lbl,.fp-acct')||row).fontWeight,title:row.getAttribute('title'),label:row.getAttribute('aria-label'),sr:[...row.querySelectorAll('.sr-only')].map(e=>e.textContent)}}),rings:q('.fp-avatar.fresh .dot').map(d=>({shadow:getComputedStyle(d).boxShadow,title:d.parentElement.getAttribute('title')})),rail:!!document.querySelector('.folder-pane.is-rail'),w:innerWidth,h:innerHeight})`
- P-select (item 2): `const u=(s)=>{const e=document.querySelector(s);return e?[getComputedStyle(e).userSelect,getComputedStyle(e).webkitUserSelect]:null};const i=document.querySelector('.topbar input');i.focus();const before=i.value;const typed=document.execCommand('insertText',false,'x');const after=i.value;i.value=before;i.dispatchEvent(new Event('input',{bubbles:true}));return JSON.stringify({body:u('body'),row:u('.ml-row'),side:u('.fp-lbl'),toolbar:u('.rp-tools button'),subject:u('.rp-head h2'),from:u('.rp-from'),to:u('.rp-to'),date:u('.rp-date'),search:u('.topbar input'),typed,changed:after!==before})` (a real double-click on a row and on the subject, then `getSelection().toString()`, is done by the QA person: empty on the row, the word on the subject)
- P-open (item 3, the timing): `node scripts/lib/open-mail-probe.mjs <data folder | test-bridge.json | port:token> main "<text of the long message's row>"` (the row must be in the list; the script clicks it and prints `{ statusMs, statusGoneMs, frameMs, gapMax, longTaskMax, marks: { threadMs, cleanMs, picsMs, darkMs, shownAt, cleanAt }, statusText, statusBusy, statusLeft, headBox, headAfter, bodyOpening, pass }`)
- P-covered (item 3, what the block looks like while it is up; run during a slow open): `const s=document.querySelector('.rp-body .rp-opening');const b=document.querySelector('.rp-body');if(!s)return JSON.stringify(null);const r=s.getBoundingClientRect(),br=b.getBoundingClientRect(),h=document.querySelector('.rp-head').getBoundingClientRect();return JSON.stringify({text:s.querySelector('p').textContent.trim(),role:s.getAttribute('role'),busy:s.getAttribute('aria-busy'),ring:getComputedStyle(s.querySelector('.busy-ring')).display,dots:getComputedStyle(s.querySelector('.busy-dots')).display,covers:[r.left-br.left,r.top-br.top,br.right-r.right,br.bottom-r.bottom].map(Math.round),overflow:getComputedStyle(b).overflowY,head:[h.top,h.height].map(Math.round),bg:getComputedStyle(s).backgroundColor,font:getComputedStyle(s.querySelector('p')).fontFamily})`
- P-toasts (item 4, run before the action; read after 3 s): `window.__tt=[];const t0=performance.now();window.__ti=setInterval(()=>{window.__tt.push([Math.round(performance.now()-t0),[...document.querySelectorAll('.toasts .toast')].map(t=>(t.querySelector('.busy-ring')?'*':'')+t.textContent.replace(/[·\s]+/g,' ').trim())])},40);setTimeout(()=>clearInterval(window.__ti),3000);return 1` then `return JSON.stringify(window.__tt.filter((x,i,a)=>i===0||JSON.stringify(x[1])!==JSON.stringify(a[i-1][1])))` (a `*` marks a toast with a ring)
- P-send (item 4, Send): `const b=document.querySelector('.compose-pane .split-btn .btn.primary');const r=b.getBoundingClientRect();return JSON.stringify({busy:b.getAttribute('aria-busy'),ring:!!b.querySelector('.spin'),box:[r.left,r.top,r.width,r.height].map(Math.round),cursor:getComputedStyle(b).cursor,label:b.textContent.trim()})` (once idle, once within 100 ms of the press)
- P-pill (item 4, list): `const p=document.querySelector('.ml-loadpill');const r0=document.querySelector('.ml-row');return JSON.stringify({pill:p?{text:p.textContent.trim(),role:p.getAttribute('role'),ring:!!p.querySelector('.spin'),box:(({left,top,width,height})=>[left,top,width,height].map(Math.round))(p.getBoundingClientRect())}:null,firstRowTop:r0?Math.round(r0.getBoundingClientRect().top):null})` (the first row's top is the same with and without the pill +- 1 px)
- P-fit (new words, the font of the language): `const t=document.querySelector('.toasts .toast .toast-text,.rp-opening p');if(!t)return JSON.stringify(null);const r=t.getBoundingClientRect(),b=(t.closest('.toast')||t.closest('.rp-opening')).getBoundingClientRect();return JSON.stringify({text:t.textContent.trim(),clipped:t.scrollWidth>t.clientWidth+1,inside:b.left>=0&&b.right<=innerWidth,lines:Math.round(r.height/parseFloat(getComputedStyle(t).lineHeight)),font:getComputedStyle(t).fontFamily,size:getComputedStyle(t).fontSize,w:innerWidth,h:innerHeight})`

PASS (numbers):
- P-mark: after an arrival in A's Inbox with B on screen: `dots` has 3 entries in the open menu (A's heading, A's Inbox row, the Favorites Inbox row) and 2 in the icon column when the avatar and the Inbox icon show; each `box` is 8 x 8 (open menu) or 6 x 6 (icon column), `radius` "50%" or px >= 3, `anim` "1" (never infinite), `weight` "650" for the rows, `title` has "New mail" as the last line (Mac / Linux: the line is the tooltip text, not a native label), `sr` [", New mail"] in the open menu, `rings[0].shadow` has a `0px 0px 0px 2px` and a `0px 0px 0px 4px` layer. After opening A's Inbox: `dots` is empty. After a mail A sent to itself: unchanged.
- P-select: `body` ["none","none"], `row` ["none","none"], `side` ["none","none"], `toolbar` ["none","none"], `subject` / `from` / `to` / `date` ["text","text"], `search` ["text","text"], `typed` true and `changed` true (the field takes typing under the page's `none`).
- P-open on the long message: `statusMs` between 90 and 150 for a read of 300 ms or more (null when the mail was there before 100 ms), `statusBusy` true, `statusText` ends with "Opening message…", `statusGoneMs - statusMs` >= 290, `statusLeft` false, `frameMs` not null, `headBox` equals `headAfter` +- 1 (the subject did not move), `bodyOpening` true, `gapMax` < 500 (WebKit has no Long Task API: `longTaskMax` is null there; on Windows Chromium it is < 200). For a 500 KB or bigger HTML the status is up before the cleaning starts: `statusMs <= marks.cleanAt`. A 20 KB mail: `statusMs` null.
- P-covered: `text` "Opening message…" (or the language's), `role` "status", `busy` "true", `ring` "none" and `dots` not "none" only under reduced motion, `covers` [0,0,0,0] +- 1 (the block covers the whole body area), `overflow` "hidden", `bg` equal to the pane background (light and dark).
- P-toasts for 30 conversations with a slow server: a `*Working on 30 conversations…` entry within 150 ms of the key press (when the move is not done by 100 ms), absent for 19 conversations, gone with the result entry ("Archived …" with Undo); the busy entry is on screen for >= 300 ms once shown. Send with a big message: `*Sending…` shows >= 100 ms after the press when the hand-over is slow, then one `Sending… Undo` entry (never both for more than one sample).
- P-send: `busy` "true", `ring` true within 100 ms of the press, `box` width / height within 1 px of the idle call, `cursor` "progress", `label` the same word as idle ("Send").
- P-pill: `pill` not null within 150 ms of the search on a slow server, `role` "status", `ring` true, `firstRowTop` equal +- 1 px with and without the pill.
- P-fit: `clipped` false, `inside` true, `lines` <= 2 in en / fr / es / ja / zh-Hans and <= 3 in de, ru, vi at 960 x 560 and 1280 x 800, the font of the language (ja: a CJK family).
Engine features relied on: `-webkit-user-select` (written next to every `user-select`; WebKit before Safari 17 needs the prefix), `position: sticky` (the zero-height wrapper of the pill; Safari 13+, WebKitGTK 2.26+), `position: absolute` with `top/right/bottom/left` (no `inset` shorthand: WebKit before 14.1 lacks it), `margin-inline-end` (Safari 12.1+), `CustomEvent`, `requestAnimationFrame` (not delivered to a hidden window: the paint wait ends after 120 ms by itself), `PerformanceObserver` "longtask" (Chromium only, optional), `document.hasFocus()` and `visibilityState` ("in front" for the marker; WKWebView gives them for a focused window), `forced-colors` (Windows only, `CanvasText`). No `clamp()`, `:has()`, `dvh`, `color-mix`, `inert` or scroll-padding in the new rules.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-31.01 | Mac, Linux | the marker: A's heading and Inbox row after an arrival, the tooltip, opening clears it; own mail / moved mail / Sent never mark (item 1), light and dark | P-mark | as above | OPEN |
| WK-31.02 | Mac, Linux | the icon column (960 x 560): avatar ring, folder dot, tooltip line; VoiceOver reads "New mail" on the avatar (Mac) | P-mark | rings and 6 x 6 dot as above | OPEN |
| WK-31.03 | Mac, Linux | no selection: double- / triple-click a row, a folder, "Today", a Settings label, a toolbar button, a normal toast; selection works on the subject, sender, date, an error toast, the About version (item 2) | P-select + a real double-click | as above | OPEN |
| WK-31.04 | Mac (WKWebView) | typing, selecting and copying in the search box, To, Subject, a Settings field and the compose body (an input under `-webkit-user-select: none` must still take typing) | P-select (`typed`, `changed`) + typing | `typed` true, `changed` true | OPEN |
| WK-31.05 | Mac, Linux | the long message in the pane: the block within ~150 ms, covers the body area, the list scrolls, the subject does not move, the block goes when the mail is drawn (item 3) | P-open, P-covered | as above | OPEN |
| WK-31.06 | Mac, Linux | a 20 KB message shows no block; a 500 KB / 2 MB one shows it before the page goes busy | P-open | `statusMs` null / `statusMs <= marks.cleanAt` | OPEN |
| WK-31.07 | Mac, Linux | the reader window of the long message: the block from the first frame, no blank body | P-covered in the reader window (poll every 50 ms) | no sample without the block or the mail | OPEN |
| WK-31.08 | Mac, Linux | a batch of 30: "Working on 30 conversations…", then the result with Undo; 19: nothing (item 4) | P-toasts | as above | OPEN |
| WK-31.09 | Mac, Linux | Send with a big attachment in the main window: the button ring, "Sending…" with a ring, the Undo toast; no second send on a second press | P-send, P-toasts | as above | OPEN |
| WK-31.10 | Linux (Mac has no Print entry) | More > Print: "Preparing to print…" before the dialog; a second press does nothing | P-covered | `text` "Preparing to print…" | OPEN |
| WK-31.11 | Mac, Linux | a search / tab / filter on a slow server: the pill, no row moves | P-pill | as above | OPEN |
| WK-31.12 | Mac, Linux | the two new words in de, ja, ru, vi, fr at 960 x 560 and 1280 x 800, light and dark, with the computed font family | P-fit | as above | OPEN |
| WK-31.13 | Mac, Linux | reduced motion: the dots instead of the ring in the "Opening message…" block | P-covered | `ring` "none", `dots` not "none" | OPEN |

## 32. WP13b, WP13c, WP13d: search panel, notification sound, create folders (coder, `feature/v107-wp13bcd`, W13.4, W13.8, W13.10)

Nothing here was run on a Mac or Linux. Windows (Chromium, dev preview with the mock backend) runs the CDP tests listed under each part; they measure the same numbers as the probes below. The three parts are in the order they were built: 32.1 (W13.4), 32.2 (W13.8), 32.3 (W13.10).

### 32.1 W13.4 Search panel (WP13b)

Visible changes, what to look at (Mac WKWebView, Linux WebKitGTK):
1. **Simple panel.** Click the search box (or press `/`): the panel shows "Search in" with a segmented group (Current folder, All folders, All mailboxes; two choices in an all-mailboxes view), the note line, the recent searches (at most 5, each row a clock icon, the text with an ellipsis, an X on the right) with "Clear all" at the right end of the heading line, and "Advanced search" with a chevron at the bottom. No chips, dates, fields or operators. At 960 x 560 the panel needs no scrolling with 5 recent searches.
2. **Advanced search.** The button opens the filters, dates, fields and the operators line inside the same panel (the panel then scrolls, max 76 % of the window height); the chevron turns 180 degrees; it stays open when the panel is closed and opened again, and starts closed after a restart. The sections are a separate JS chunk: the first press may show the small "Loading..." for a moment on a slow disk.
3. **Keyboard.** Box: Down enters the panel on the checked scope choice; Left / Right change the scope (the focus moves with it, wraps around); Down / Up walk the recent rows (Up on the first control goes back to the box); Enter on a row runs it and closes the panel with the focus in the box; Delete on a row (or on its X) removes it and the focus goes to the row that took its place, or the box when the list is empty; Esc anywhere in the panel closes it and returns the focus to the box with the text kept. The Tab order is scope group (one stop), row, its X, next row, ..., Clear all, Advanced search.
4. **Look.** Panel as wide as the box; X, Clear all and the button in the accent / muted colours of the theme (light and dark); the label of the button and "Clear all" in the language's font, never clipped (de "Erweiterte Suche", ru "Расширенный поиск", vi "Tìm kiếm nâng cao", fr "Recherche avancée", ja "詳細検索").

Probes (DOM only, run through the bridge `eval`; each returns JSON):
- P-sb-panel (open the panel first: click the box): `const p=document.querySelector('.sb-panel');if(!p)return JSON.stringify(null);const pr=p.getBoundingClientRect(),w=document.querySelector('.search-wrap').getBoundingClientRect();const g=p.querySelector('[role=radiogroup]');const adv=p.querySelector('.sb-advanced');const clear=p.querySelector('.sb-clear');const cut=[...p.querySelectorAll('.sb-advanced,.sb-clear,.sb-title,[role=radio],.sb-recent-x')].filter(e=>{const r=e.getBoundingClientRect();return r.left<pr.left-0.5||r.right>pr.right+0.5||e.scrollWidth>e.clientWidth+1}).map(e=>e.className||e.textContent);const t=p.querySelector('.sb-recent .sb-title'),c=clear&&clear.getBoundingClientRect(),tr=t&&t.getBoundingClientRect();return JSON.stringify({panelW:Math.round(pr.width),boxW:Math.round(w.width),scrollOver:p.scrollHeight-p.clientHeight,bottom:Math.round(pr.bottom),winH:innerHeight,radios:[...g.querySelectorAll('[role=radio]')].map(b=>[b.textContent.trim(),b.getAttribute('aria-checked'),b.tabIndex]),group:g.getAttribute('role'),named:document.getElementById(g.getAttribute('aria-labelledby')).textContent,recent:[...p.querySelectorAll('[data-sb-nav=recent]')].map(b=>b.textContent.trim()),xName:(p.querySelector('.sb-recent-x')||{getAttribute:()=>null}).getAttribute('aria-label'),advExpanded:adv.getAttribute('aria-expanded'),advText:adv.textContent.trim(),chips:p.querySelectorAll('.sb-chip').length,clearSameLine:c&&tr?Math.abs((tr.top+tr.bottom)/2-(c.top+c.bottom)/2)<8:null,cut,font:getComputedStyle(adv).fontFamily,w:innerWidth,h:innerHeight})`
- P-sb-tab (the tab stops in DOM order): `return JSON.stringify([...document.querySelectorAll('.sb-panel button,.sb-panel input')].filter(e=>e.tabIndex>=0).map(e=>e.dataset.sbNav||(e.classList.contains('sb-recent-x')?'x':e.tagName)))`
- P-sb-adv (after pressing "Advanced search"; poll up to 3 s for the chunk): `const a=document.querySelector('#sb-adv'),p=document.querySelector('.sb-panel'),pr=p.getBoundingClientRect();return JSON.stringify(a?{titles:[...a.querySelectorAll('.sb-title')].map(e=>e.textContent),foot:!!a.querySelector('.sb-foot'),out:[...a.querySelectorAll('.sb-chip,.sb-title,label')].filter(e=>e.getBoundingClientRect().right>pr.right+0.5).length,chevron:getComputedStyle(document.querySelector('.sb-advanced svg')).transform}:null)`
- P-sb-focus (after each key of the flow, to see where the focus is): `const a=document.activeElement;return JSON.stringify({id:a.id,nav:a.dataset.sbNav||'',role:a.getAttribute('role')||'',text:(a.textContent||'').trim().slice(0,30),panel:!!document.querySelector('.sb-panel')})`

PASS (numbers):
- P-sb-panel on the simple panel with 5 recent searches at 960 x 560 and 1280 x 800: `panelW` equals `boxW` +- 1; `scrollOver` 0; `bottom` <= `winH`; `radios` three entries in a mailbox view (the first `["Current folder","true",0]`, the other two with tabIndex -1) and two in an all-mailboxes view; `group` "radiogroup"; `named` "Search in" (in the language); `recent` up to 5 texts, newest first; `xName` `Remove “<text>” from recent searches` in the language; `advExpanded` "false"; `chips` 0; `clearSameLine` true; `cut` `[]` in en, vi, fr, zh-Hans, es, ja, de, ru.
- P-sb-tab with 5 recent searches: `["scope","recent","x","recent","x","recent","x","recent","x","recent","x","clear","advanced"]`.
- P-sb-adv: `titles` `["Filters","Date","Fields"]` (in the language), `foot` true, `out` 0 in all 8 languages at 960 x 560, `chevron` a rotation matrix (not "none").
- Keyboard flow with P-sb-focus after each key: `/` -> box; Down -> `role` "radio" and the checked text; Right -> the next choice has the focus and the list re-runs when the box holds text; Down -> `nav` "recent" (first row); Enter -> `panel` false and `id` "search-input"; Delete on a row -> the row is gone and the focus is on the row that took its place.
Engine features relied on: `role="radio"` / `aria-checked` on `<button>` (all engines), roving `tabindex`, `.focus()` called from key handlers (WKWebView honours it; Safari / WKWebView do not give a button the focus on a mouse click, so no code relies on `relatedTarget` or on a click moving the focus), CSS grid with explicit `grid-row` / `grid-column` on the recent block (Safari 10.1+, WebKitGTK 2.20+), `grid-template-columns: minmax(0, 1fr) auto`, flex `gap` (already used elsewhere; Safari 14.1+), `transform: rotate()` with a transition on an SVG, dynamic `import()` of the Advanced chunk. Tab on a Mac only reaches buttons when System Settings > Keyboard > "Keyboard navigation" is on; the arrow keys of the panel work without it, so the keyboard flow does not depend on it.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-32.01 | Mac, Linux | the simple panel at 960 x 560 with 5 recent searches, light and dark: no scrolling, width of the box, Clear all on the heading line (item 1) | P-sb-panel | as above | OPEN |
| WK-32.02 | Mac, Linux | Advanced search: opens the old sections, closes, remembered while the app runs, collapsed after a restart; the chevron turns (item 2) | P-sb-adv, P-sb-panel | as above | OPEN |
| WK-32.03 | Mac, Linux | keyboard only: `/`, Down, Right, Down, Enter; `/`, Down, Down, Delete; Esc in the panel; Up from the first control (item 3) | P-sb-focus after each key | as above | OPEN |
| WK-32.04 | Mac (WKWebView) | the Tab order with Keyboard navigation on; the scope group is one stop (item 3) | P-sb-tab + real Tab presses | the sequence above | OPEN |
| WK-32.05 | Mac, Linux | the labels in de, ja, ru, vi, fr at 960 x 560 and 1280 x 800, computed font family (item 4) | P-sb-panel, P-sb-adv | `cut` `[]`, `out` 0, `font` a family of the language | OPEN |
| WK-32.06 | Mac, Linux | VoiceOver / Orca: the scope is read as a group of radio buttons named "Search in", the X as "Remove “...” from recent searches" | accessibility inspector | role radio, name as above | OPEN |

## WP14 part 1 (Microsoft Store package, feature/v107-wp14a) - no WebKit rows

No visible UI, CSS, layout, font, text length, focus or scroll behaviour of the app changed (the MSIX package, the CI jobs, the logo script and the owner documentation only; the Store texts in Settings > About and the two autostart hints are WP14 part 2 and bring their own rows). The images made by scripts/msix-assets.mjs are PNGs drawn from docs/assets/favicon.svg by headless Chrome/Edge on a Windows runner: they contain no text, so no font decides how they look, and they are not shown by WKWebView or WebKitGTK. The 1.0.7 fix of scripts/test-lazy-views.mjs (timing limits relative to the machine) is test code only; the Mac and Linux kit rows of scripts/lib/lazy-open-probe.mjs keep their numbers (verdict() defaults unchanged: frame <= 100 ms).

### 32.2 W13.8 Notification sound (WP13c)

Windows: `node scripts/test-notify-sound.mjs` (static, `--experimental-strip-types`), `node scripts/test-notify-sound-ui.mjs --require-browser`, `cargo test --lib notifysound`. Not run on a Mac or Linux: the macOS (`NSSound`) and Linux (notification hints, `pw-play` / `paplay` / `aplay`) code is compiled by the CI build only. A person has to LISTEN: the coder session has no audio output, so no row below was heard by the coder.

Visible changes, what to look at (Mac WKWebView, Linux WebKitGTK):
1. **Sound row** (Settings > Mailboxes > All accounts, or a mailbox > Notifications). One row "Sound": the label, the hint ("Plays a short sound when new mail arrives. It follows your system volume."), a switch (on by default) and a button with a speaker icon "Play sound". In a mailbox scope the "Same as all accounts" / "Custom" tag follows the switch. The old select (Mail, Default, ...) is gone. At 960 x 560 the label, the hint (two lines in de / es / fr), the switch and the button fit inside the dialog body; in de the button reads "Ton testen", in ru "Прослушать", in ja "音を再生" with no clipping.
2. **Play sound.** Plays the pop once (0.35 s), switch on or off, at the system volume (lower the system volume: quieter). When nothing can play (Linux with none of `pw-play`, `paplay`, `aplay`) the toast "Couldn't play the sound on this computer." shows.
3. **New mail** (listen). Mac: window in the background (or another app in front), the stub delivers one mail to a mailbox's Inbox: the pop plays once, no notification is shown (owner decision); 5 mails at once: one pop; two mailboxes in the same round: one pop; the window in front with the Inbox open: no pop; the switch off for that mailbox: no pop. Linux KDE / GNOME: the notification shows and the pop plays with it (KDE: the server plays `sound-file`; GNOME Shell lists no "sound" capability, so the app plays the file with the first player of `pw-play`, `paplay`, `aplay`); GNOME Do not disturb on: silent (the notification is suppressed, the app's player must NOT play: check `startup.log` for `sound: skipped` or no `sound: played`).
4. `startup.log` has one line per decision (no mail text): `notification: shown for N new message(s)`, then `sound: played`, or `sound: skipped (...)` with the reason (`one played less than 3 s ago`, `no sound player (pw-play, paplay, aplay) was found`, `Windows does not accept notifications now (state N)`).

Probes (DOM only, through the bridge `eval`; the sound itself is heard, not measured):
- P-snd-row (Settings open on the Notifications section): `const r=document.querySelector('.sound-row')?.closest('.set-row');if(!r)return JSON.stringify(null);const sw=r.querySelector('input[type=checkbox]'),b=r.querySelector('.sound-play'),rr=r.getBoundingClientRect(),d=document.querySelector('.settings-body').getBoundingClientRect(),br=b.getBoundingClientRect();return JSON.stringify({label:r.querySelector('.set-lbl > div').textContent.trim(),hint:(r.querySelector('.set-lbl .muted')||{}).textContent,on:sw.checked,swName:sw.getAttribute('aria-label'),btn:b.textContent.trim(),icon:!!b.querySelector('svg'),selects:r.querySelectorAll('select').length,clipped:b.scrollWidth>b.clientWidth+1||r.scrollWidth>r.clientWidth+1,inside:rr.left>=d.left-1&&rr.right<=d.right+1,rowH:Math.round(rr.height),btnBox:[br.left,br.top,br.width,br.height].map(Math.round),font:getComputedStyle(b).fontFamily,w:innerWidth,h:innerHeight})`
- P-snd-prefs: `const s=window.__store?window.__store.getState():null;return JSON.stringify(s?{all:s.prefs.notifySound,boxes:Object.fromEntries(Object.entries(s.prefs.accountPrefs||{}).map(([k,v])=>[k,v.notifySound]))}:null)` (if `__store` is not exposed in the release build, read the setting `prefs` through the bridge: `notifySound` is "pop" or "none")
- P-snd-log (Mac / Linux shell, not DOM): `grep -E "\[notify\]" <data folder>/startup.log | tail -20`

PASS (numbers):
- P-snd-row at 960 x 560 and 1280 x 800, light and dark, in en, vi, fr, zh-Hans, es, ja, de, ru: `label` the language's "Sound", `on` true on a fresh profile, `btn` the agreed text (Play sound / Phát thử / Écouter / 播放声音 / Reproducir / 音を再生 / Ton testen / Прослушать), `icon` true, `selects` 0, `clipped` false, `inside` true, `rowH` <= 190, `font` a family of the language (ja / zh-Hans: a CJK family).
- P-snd-prefs after a 1.0.6 profile with Sound = Silent: `all` "none" (switch off); with Sound = SMS (or any other): `all` "pop".
- Listening: AC-13.8.1 (the pop, volume follows the system), AC-13.8.9 (Mac and Linux as in item 3); P-snd-log has `sound: played` exactly once per batch and no second one within 3 s.
Engine features relied on: flex with `gap` and `flex-wrap` (already used by `.ov`), an inline SVG icon, `<input type=checkbox>` switch (existing `Switch`); no new CSS function. Native: `NSSound initWithData:` and `play` on the main thread (macOS 10.x+), notification hints `sound-file` / `sound-name` (freedesktop notification spec 1.2), `GetCapabilities` "sound".

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-32.07 | Mac, Linux | the sound row at 960 x 560 and 1280 x 800, light and dark, de / ja / ru / vi / fr (item 1) | P-snd-row | as above | OPEN |
| WK-32.08 | Mac, Linux | Play sound, switch on and off; the failure toast on a Linux box without a player (item 2) | listen + P-snd-log | the pop once per press; the toast text | OPEN |
| WK-32.09 | Mac | new mail with the window in the background: one pop, no banner; 5 mails: one pop; two mailboxes: one pop; window in front: none (item 3) | listen + P-snd-log | one `sound: played` per batch | OPEN |
| WK-32.10 | Linux KDE, GNOME | the notification with the pop (KDE: by the server; GNOME: by the app's player); GNOME Do not disturb on: silent (items 3, 4) | listen + P-snd-log | one pop, none under Do not disturb | OPEN |
| WK-32.11 | Mac, Linux | a 1.0.6 profile with Silent: the switch is off after the update; with another sound: on (item 1) | P-snd-prefs | `all` "none" / "pop" | OPEN |


## 33. WP14 part 2 (Microsoft Store, coder, `feature/v107-wp14b`): the Privacy policy link, the AI report link, the Store form of Settings > About, the grey autostart switch, the Store texts on the website

What changed that a person sees (all texts agreed with the 8 language specialists, spec WP14 section 12, copied by script from the spec table):
1. Settings > About: a FOURTH link, "Privacy policy" (every copy, every OS), after Website, Buy me a coffee, Source code (`.about-links` / `.about-link`).
2. Settings > AI Assistant: a link line "Report a problem with AI content" under the intro (`button.link`, inline style `margin: 4px 0 8px`, no new CSS).
3. Settings > About of a Store package (`managed` = "msstore"): the version, "Updates come from the Microsoft Store." and the Store form of the privacy text; no button, no switch. Only in a package on Windows; on Mac / Linux only in a debug build with `HEYLOOK_SIMULATE_PACKAGED=1` (QA look at the layout).
4. Settings > Notifications & tray, "Start Hey Look! when I sign in to Windows": in a package the switch can be locked (`locked` "user" = turned off in Windows, "policy" = the organisation): the switch is disabled and the hint under the label is the new text (2 or 3 lines in a long language). Windows only; on Mac / Linux the row has another label and is never locked, except in a debug build with `HEYLOOK_SIMULATE_PACKAGED=1 HEYLOOK_SIMULATE_AUTOSTART_LOCK=user|policy`.
5. Website (Safari on a Mac is the WebKit that matters): help.html has the section "Content from the AI Assistant" (`details#ai-report`, last question of "Report a problem") and two more paragraphs in the answer "Updates"; download.html has the Store block in the Windows card, HIDDEN until `STORE_PRODUCT_ID` in `docs/assets/site.js` is set (checked hidden here; it becomes visible at publication and is then measured by the owner / QA).
Engine features relied on: flex / grid as the existing Settings, `overflow-wrap` of the existing `.about-link` / `.set-lbl .muted`, `<details>` opened by `location.hash` (site.js `openHash`, used by every help anchor), the `hidden` attribute; no new CSS, no `:has()`, no `clamp()`, no `color-mix()`.

Probes (through the test bridge `eval`, one expression each; open Settings > About / AI Assistant / Notifications & tray first):
- P-wp14-links (About): `(()=>{const b=document.querySelector('.settings-body'),br=b.getBoundingClientRect(),l=[...document.querySelectorAll('.settings .about-link')];return JSON.stringify({n:l.length,texts:l.map(x=>x.textContent.trim()),cut:l.filter(x=>{const r=x.getBoundingClientRect();return r.left<br.left-0.5||r.right>br.right+0.5}).length,heights:l.map(x=>Math.round(x.getBoundingClientRect().height)),scrollX:b.scrollWidth-b.clientWidth,font:getComputedStyle(l[0]).fontFamily,w:innerWidth,h:innerHeight})})()`
- P-wp14-ai (AI Assistant): `(()=>{const b=document.querySelector('.settings-body'),br=b.getBoundingClientRect(),e=[...document.querySelectorAll('.settings button.link')].find(x=>x.closest('.settings-body')&&x.parentElement.previousElementSibling&&x.parentElement.previousElementSibling.classList.contains('muted'));const r=e&&e.getBoundingClientRect();return JSON.stringify({text:e&&e.textContent.trim(),cut:r?(r.left<br.left-0.5||r.right>br.right+0.5):null,h:r&&Math.round(r.height),scrollX:b.scrollWidth-b.clientWidth,font:e&&getComputedStyle(e).fontFamily})})()`
- P-wp14-store-about (About, simulated package): `(()=>{const b=document.querySelector('.settings-body'),br=b.getBoundingClientRect(),ps=[...document.querySelectorAll('.settings p.muted.small')];return JSON.stringify({paras:ps.map(p=>({t:p.textContent.trim().slice(0,60),cut:p.getBoundingClientRect().right>br.right+0.5||p.getBoundingClientRect().left<br.left-0.5,h:Math.round(p.getBoundingClientRect().height)})),buttons:document.querySelectorAll('.settings .update-status .btn, .settings .update-status button').length,switches:document.querySelectorAll('.settings input[type=checkbox]').length,scrollX:b.scrollWidth-b.clientWidth})})()`
- P-wp14-autostart (Notifications & tray, simulated lock): `(()=>{const b=document.querySelector('.settings-body'),br=b.getBoundingClientRect(),rows=[...document.querySelectorAll('.settings .set-row')],row=rows[rows.length-1];const h=row.querySelector('.set-lbl .muted'),sw=row.querySelector('input[type=checkbox]'),hr=h&&h.getBoundingClientRect();return JSON.stringify({label:row.querySelector('.set-lbl > div').textContent.trim(),hint:h&&h.textContent.trim(),hintCut:hr?(hr.left<br.left-0.5||hr.right>br.right+0.5):null,hintH:hr&&Math.round(hr.height),disabled:sw&&sw.disabled,scrollX:b.scrollWidth-b.clientWidth,font:h&&getComputedStyle(h).fontFamily})})()` (the autostart row is the last row of the tab)
- P-wp14-site-help (Safari, docs/help.html#ai-report in each language): `JSON.stringify((()=>{const d=document.getElementById('ai-report');return {open:d&&d.open,paras:d&&d.querySelectorAll('.hq-a p').length,top:d&&Math.round(d.getBoundingClientRect().top),scrollX:document.documentElement.scrollWidth-innerWidth,upd:document.querySelectorAll('#updates .hq-a p').length}})())`
- P-wp14-site-dl (Safari, docs/download.html): `JSON.stringify((()=>{const s=document.getElementById('store-block');const c=document.getElementById('card-windows').getBoundingClientRect();return {hidden:s&&s.hidden,display:s&&getComputedStyle(s).display,card:Math.round(c.height),scrollX:document.documentElement.scrollWidth-innerWidth}})())`

Pass criteria (numbers):
- P-wp14-links at 960 x 560 and 1280 x 800, light and dark, in en, vi, fr, zh-Hans, es, ja, de, ru: `n` 4; `texts[3]` is the language's "Privacy policy" (en "Privacy policy", vi "Chính sách quyền riêng tư", fr "Politique de confidentialité", zh-Hans "隐私政策", es "Política de privacidad", ja "プライバシーポリシー", de "Datenschutzerklärung", ru "Политика конфиденциальности"); `cut` 0; every `heights[i]` < 60 (one or two lines); `scrollX` 0.
- P-wp14-ai: `text` is the language's "Report a problem with AI content"; `cut` false; `h` < 60; `scrollX` 0; the link sits directly under the intro and above the first field (no overlap, the same left edge as the intro).
- P-wp14-store-about (simulated): `paras` two entries (the Store sentence, the Store privacy text), `cut` false for both, `buttons` 0, `switches` 0, `scrollX` 0; none of the GitHub update sentences.
- P-wp14-autostart (simulated lock "user"): `hint` equals the language's autostartOffInWindows ("Turned off in Windows. To use it, turn Hey Look! on again in Windows Settings > Apps > Startup." in English), `disabled` true, `hintCut` false, `scrollX` 0; lock "policy": the policy sentence ("Your organization manages this setting."); no lock: `disabled` false and the old hint.
- P-wp14-site-help: `open` true after loading `...help.html#ai-report`, `paras` 2, `scrollX` 0 at 375 and 1280 px; `upd` 3.
- P-wp14-site-dl: `hidden` true, `display` "none" (the block takes no room), `scrollX` 0 at 375 and 1280 px.
The same numbers are checked in Chrome by `node --experimental-strip-types scripts/test-about-store.mjs --require-browser` (8 languages, 2 sizes, 2 themes, 3 autostart states, AI tab), `scripts/test-store-texts.mjs` and `scripts/test-site-length.mjs`; the rows below are for WKWebView / WebKitGTK / Safari.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-33.01 | Mac, Linux | Settings > About: four links incl. Privacy policy, 8 languages, 960 x 560, light and dark | P-wp14-links | as above | OPEN |
| WK-33.02 | Mac, Linux | Settings > AI Assistant: the report link under the intro, 8 languages, 960 x 560 | P-wp14-ai | as above | OPEN |
| WK-33.03 | Mac, Linux | About of a simulated package (debug build, `HEYLOOK_SIMULATE_PACKAGED=1`): two paragraphs, nothing clipped, de / ru / ja the longest | P-wp14-store-about | as above | OPEN |
| WK-33.04 | Mac, Linux | Notifications & tray with `HEYLOOK_SIMULATE_AUTOSTART_LOCK=user` and `=policy`: grey switch, hint of 2-3 lines (de, ru, ja) | P-wp14-autostart | as above | OPEN |
| WK-33.05 | Mac (Safari) | the website: help.html#ai-report in 8 languages opens the section; the Updates answer has 3 paragraphs | P-wp14-site-help | as above | OPEN |
| WK-33.06 | Mac (Safari) | the website: download.html keeps the Store block hidden, no layout change of the Windows card | P-wp14-site-dl | as above | OPEN |

### QA rows of the spec (section 11.2) prepared for WP14 part 2
| Row | Check | How | AC |
|---|---|---|---|
| M-4 | Store texts in 8 languages and the two autostart hints (Windows, CDP, no package) | `node --experimental-strip-types scripts/test-about-store.mjs --require-browser` (the full run; `--quick` is what CI runs); real app: debug build with `HEYLOOK_SIMULATE_PACKAGED=1` (and `HEYLOOK_SIMULATE_AUTOSTART_LOCK=user` or `policy`) through the test bridge, screenshots of About and Notifications & tray in 8 languages at 960 x 560 and 1280 x 800, light and dark | AC-WA.3.1, AC-WA.3.2 |
| M-5 | No update check in packaged mode | debug build with `HEYLOOK_SIMULATE_PACKAGED=1`: bridge `invoke check_update {trigger: "manual"}` answers `kind: "managed"`; a local latest.json server (HEYLOOK_UPDATE_ENDPOINT) sees 0 requests; `update_download` / `update_install` refuse with "this copy is updated by its package manager or store (msstore)"; CI: the log of `msix-check` or a private-audience install shows no request to github.com | AC-WA.2.3 |
| M-6 | WebView2 missing: the start-fail dialog appears in the chosen app language | debug build, process environment only: `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` pointing at an empty folder; the existing "Hey Look! could not start" dialog names the WebView2 Runtime and Microsoft's page; no Windows crash dialog (nothing changed by WP14: `startfail.rs`) | AC-WA.6.4 |
| M-7..M-11 | OAuth loopback, attachments / print / pickers, Store update of a running app, toasts, autostart by the startup task | owner smoke on a private-audience install (PACKAGING.md > Microsoft Store); NOT RUN until then | AC-WA.6.5, 2.5, 2.6, 6.7, 6.9, 2.4 |

### 32.3 W13.10 Create a folder and a one-level subfolder (WP13d)

Windows: `node --experimental-strip-types scripts/test-folder-create.mjs --require-browser` (static part and the dev-preview part), `cargo test --lib folders` (the fake IMAP server: both delimiters, the INBOX namespace, `\Noinferiors`, refusals, UTF-7). Not run on a Mac or Linux. The kit's stub IMAP server needs: a mailbox A that allows CREATE (delimiter `/`), a second stub with delimiter `.` and the INBOX namespace (`INBOX.Sent`), a stub variant that refuses CREATE with `[NOPERM]` / `[CANNOT]`, and a mailbox that needs a new sign-in (item 6).

Visible changes, what to look at (Mac WKWebView, Linux WebKitGTK):
1. **Menu of a mailbox heading.** Right-click (Mac: two-finger click or Ctrl+click; keyboard: focus the heading, Shift+F10 or the Menu key) on the mailbox name in the side menu: "Move up", "Move down", a divider, "New folder…". Choosing it opens the dialog "New folder" with "Create in" above the mailbox name, one field "Folder name" with the focus, and Cancel / Create (Create is off while the field is empty).
2. **Menu of a folder of the person.** Right-click a top-level folder you made: one entry "New subfolder…" (the dialog says "Create in" `<folder> — <mailbox>`). A subfolder, Inbox, Drafts, Sent, Archive, Junk, Deleted Items and the Favorites rows have NO menu of ours (nothing opens; the app's own right-click guard keeps the system menu away).
3. **Tree.** A folder with subfolders has a small chevron button in the indent before its icon (down = open); the subfolder is indented 16 px more than its parent; the chevron folds and opens it (click, or Left / Right arrow on the row); the folded state is kept after a restart. The new row has the keyboard focus after Create and is NOT opened. "Release v1.0" shows as one folder.
4. **Dialog errors** under the field, in red, the dialog stays open: empty ("Enter a folder name."), "a/b" ("A folder name can’t contain /."), "inbox" (reserved), the name of a folder that is there (any case), 101 characters, the server's refusals. While the server works the button shows a ring and keeps its word; Cancel closes the dialog and the folder still arrives.
5. **Texts** in de, ru, vi, fr, ja at 960 x 560: the menu entry, the dialog title, "Create in", the errors (the longest: de "Ein Ordner mit diesem Namen existiert hier bereits.", es "El nombre de una carpeta no puede contener {chars}.") wrap inside the dialog, no clipping, no raw key.
6. A mailbox that needs a sign-in again: "New folder…" is greyed with "Sign in to this mailbox again first." at its end; activating it does nothing.

Probes (DOM only, through the bridge `eval`; JSON):
- P-fd-menu (menu open): `return JSON.stringify([...document.querySelectorAll('[role=menu] [role=menuitem]')].map(e=>({text:e.querySelector('.menu-lbl').textContent.trim(),hint:(e.querySelector('.menu-hint')||{}).textContent||'',disabled:e.getAttribute('aria-disabled')==='true',clipped:e.scrollWidth>e.clientWidth+1||e.querySelector('.menu-lbl').scrollWidth>e.querySelector('.menu-lbl').clientWidth+1})).concat([{separators:document.querySelectorAll('[role=menu] [role=separator]').length}]))`
- P-fd-dialog (dialog open): `const d=document.querySelector('[role=dialog]');if(!d)return JSON.stringify(null);const i=d.querySelector('#fd-name'),e=d.querySelector('#fd-err'),b=d.querySelector('button[type=submit]'),r=d.getBoundingClientRect();return JSON.stringify({title:d.querySelector('.modal-head b').textContent,loc:d.querySelector('.fd-lbl').textContent,where:d.querySelector('.fd-where').textContent,focus:document.activeElement===i,err:e?e.textContent:null,invalid:i.getAttribute('aria-invalid'),described:i.getAttribute('aria-describedby'),create:b.textContent.trim(),createOff:b.disabled,busy:b.getAttribute('aria-busy'),ring:!!b.querySelector('.spin'),inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,w:Math.round(r.width),clipped:[...d.querySelectorAll('.fd-where,.fd-err,.fd-actions .btn,.modal-head b')].some(x=>x.scrollWidth>x.clientWidth+1&&getComputedStyle(x).textOverflow!=='ellipsis'),font:getComputedStyle(i).fontFamily})`
- P-fd-tree (side menu open, the mailbox's rows): `return JSON.stringify([...document.querySelectorAll('.fp-group .fp-row[data-fkey]')].map(r=>{const c=r.querySelector('.fp-chev'),cr=c&&c.getBoundingClientRect(),ic=r.querySelector('.fp-ico').getBoundingClientRect();return {key:r.dataset.fkey,label:r.querySelector('.fp-lbl').textContent,pad:parseInt(r.style.paddingLeft||'0'),level:r.getAttribute('aria-level'),expanded:r.getAttribute('aria-expanded'),chev:c?{name:c.getAttribute('aria-label'),w:Math.round(cr.width),h:Math.round(cr.height),gapToIcon:Math.round(ic.left-cr.right)}:null,iconLeft:Math.round(ic.left)}}))`
- P-fd-focus (after Create): `const a=document.activeElement;return JSON.stringify({fkey:a&&a.dataset.fkey,opened:window.__store?window.__store.getState().folder:null})`

PASS (numbers):
- P-fd-menu on a mailbox heading: texts `["Move up","Move down","New folder…"]` (in the language), `separators` 1, `clipped` false everywhere; on a mailbox that needs a sign-in the last entry has `disabled` true and `hint` "Sign in to this mailbox again first.". On a top-level folder of the person: `["New subfolder…"]`. On a subfolder and on the standard folders: no menu at all (`[]`).
- P-fd-dialog right after it opened: `focus` true, `createOff` true, `err` null, `inside` true, `w` <= 440; after "a/b" + Enter: `err` the text of the language, `invalid` "true", `described` "fd-err"; after a valid name + Enter on a slow server: `busy` "true", `ring` true, `create` the same word as before; `clipped` false in en, vi, fr, zh-Hans, es, ja, de, ru at 960 x 560, light and dark; `font` a family of the language.
- P-fd-tree with Projects and its subfolder 2026: Projects `chev.name` "Subfolders of Projects" (language), `chev.w` 14, `chev.h` 18, `expanded` "true"; 2026 `pad` equals Projects' `pad` + 16 and `level` is Projects' + 1; `iconLeft` of Projects equals `iconLeft` of a folder without children at the same depth +- 1 (the chevron sits in the indent, nothing moves); after folding: 2026 is not in the list and `expanded` "false".
- P-fd-focus right after Create: `fkey` `<account>|f:<new key>`, `opened` still the folder that was open.
Engine features relied on: the `contextmenu` event from a two-finger click / Ctrl+click on a Mac (WKWebView) and from Shift+F10 / the Menu key on Linux (the key handler also opens it, so it does not depend on the engine firing `contextmenu`), `CSS.escape` (Safari 10+), `Intl.Collator` with `numeric` and `sensitivity: "base"` in the app language (Safari 10+, WebKitGTK 2.20+), flex with negative margins on the chevron, a `<form>` with `noValidate` and an Enter handler on the field, `aria-level` / `aria-expanded` on `role=treeitem`, `requestAnimationFrame` for the focus after the dialog closes (not delivered to a hidden window: the focus then comes with the next frame).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-32.12 | Mac, Linux | the menu of a mailbox heading (right-click / two-finger, Shift+F10) and of a folder of the person; no menu on the others (items 1, 2) | P-fd-menu | as above | OPEN |
| WK-32.13 | Mac, Linux | the dialog: focus in the field, Enter creates, Esc / Cancel close, the focus goes back to the heading row (items 1, 4) | P-fd-dialog | `focus` true, `createOff` true | OPEN |
| WK-32.14 | Mac, Linux | create "Projects" then "2026" on the stub (both delimiters): the rows, indent, chevron, the new row focused, not opened (item 3) | P-fd-tree, P-fd-focus | as above | OPEN |
| WK-32.15 | Mac, Linux | the errors and the busy button; a server that refuses CREATE; the server log shows the modified UTF-7 name for "Báo cáo 報告" (item 4) | P-fd-dialog + the stub's log | `err` texts, `busy` "true" | OPEN |
| WK-32.16 | Mac, Linux | the dialog and the menu in de, ja, ru, vi, fr at 960 x 560, light and dark, computed font family (item 5) | P-fd-dialog, P-fd-menu | `clipped` false, `inside` true | OPEN |
| WK-32.17 | Mac, Linux | folded state kept after a restart; "Release v1.0" made in another client is one folder; a mailbox needing sign-in has the entry greyed (items 3, 6) | P-fd-tree, P-fd-menu | as above | OPEN |

## 34. WP3 Rich text remainder: AutoFormat as you type, format painter, mini toolbar (coder, `feature/v107-wp3`, W3.1, W3.2, W3.3)

(The spec asked for "section 33"; 33 is taken by WP14 part 2 in this file, so this is 34.) Nothing here was run on a Mac or Linux. Windows (Chromium, dev preview with the mock backend) runs `scripts/test-autoformat-ui.mjs` and `scripts/test-painter-mini.mjs` with real mouse and key events (CDP); the probes below measure the same numbers through the test bridge `eval` (the editor of the message body is `document.querySelector('.cp-editor .tiptap').editor`, that of a signature / template `document.querySelector('.rich-body .tiptap').editor`). Keys are written for Windows / Linux; on a Mac Ctrl is Cmd (the app's `kbd()` shows it). Parts: 34.1 AutoFormat, 34.2 Format painter, 34.3 Mini toolbar.

Where the painter is: the Format painter button sits at priority 185 (spec), the whole toolbar is about 1,000 px wide, so in a compose pane narrower than about 1,000 px (almost every inline compose, and a pop-out window at its 960 px minimum) it is a row of the More menu, with the hint Ctrl+Shift+D (Cmd+Shift+D on a Mac). QA on a Mac / Linux looks for the button in a window of 1,900 px or more, and for the More row otherwise.

### 34.1 W3.2 AutoFormat as you type

Visible changes, what to look at (Mac WKWebView, Linux WebKitGTK):
1. **Typing.** In a new message type `"Hello" -- (c) ... ` (ends with a space): the line reads `“Hello” – © … `. `don't` gives `don’t`, `'quoted'` gives `‘quoted’`, `-> --> <- (r) (tm) ` give `→ → ← ® ™`, `(C)` and `(R)` stay.
2. **Ctrl+Z (Cmd+Z) right after a change** gives back the typed characters with the caret behind them (`--` and the space, `(c)`, `...`); a second Cmd+Z is the ordinary undo of the typing. Backspace right after `©` deletes `©`.
3. **Not converted:** the Code style, inline code, link text, `https://a.test/x--y...`, `qa--1@example.test`, pasted text (Cmd+V and Cmd+Shift+V), text from an input method (Japanese, Chinese Pinyin: type a word with `...` or `--` and commit with Return).
4. **Mac only: "Use smart quotes and dashes"** (System Settings > Keyboard > Text Input > Edit) on: typing `"` gives ONE quote character, not two (WebKit may replace the straight quote itself before the editor sees it; the editor then sees a typographic quote and leaves it).
5. **Languages.** Switch the app language and type `"Test" 'a' x -- y ` and `don't`: de `„Test“ ‚a‘ x – y`, fr `« Test » ‘a’ x – y` with a no-break space inside the guillemets, ru `«Test» ’a’ x — y`, es `«Test» ‘a’ x — y`, zh-Hans `“Test” ‘a’ x —— y`, ja `“Test” ‘a’ x -- y` (no dash), en and vi `“Test” ‘a’ x – y`.
6. **Settings > Composing** row "AutoFormat as you type" with the hint (the hint shows that language's own quotes; Cmd+Z on a Mac); off: nothing is converted in an open compose (inline and window) and in the signature editor, on again: it converts without reopening.

Probes (DOM only, through `eval`; each returns JSON):
- P-af-text (the first paragraph of the open message as code points): `const t=document.querySelector('.cp-editor .tiptap').editor.state.doc.child(0).textContent;return JSON.stringify({text:t,cp:[...t].map(c=>c.codePointAt(0).toString(16))})`
- P-af-caret (after Cmd+Z): `const e=document.querySelector('.cp-editor .tiptap').editor;const s=e.state.selection;return JSON.stringify({text:e.state.doc.child(0).textContent,off:s.$from.parentOffset,empty:s.empty})`
- P-af-row (Settings > Composing open): `const r=document.getElementById('set-autoFormat');if(!r)return JSON.stringify(null);const m=document.querySelector('.modal').getBoundingClientRect(),q=r.getBoundingClientRect();return JSON.stringify({label:r.querySelector('.set-lbl>div').textContent,hint:r.querySelector('.set-lbl .muted').textContent,on:r.querySelector('input').checked,inside:q.left>=m.left-1&&q.right<=m.right+1,clipped:[...r.querySelectorAll('.set-lbl>div')].filter(e=>e.scrollWidth>e.clientWidth+1).length})`

PASS (numbers):
- P-af-text after typing sample 1 (en): `text` `“Hello” – © … ` with `cp` `["201c","48","65","6c","6c","6f","201d","20","2013","20","a9","20","2026","20"]`.
- P-af-caret right after Cmd+Z on `a -- `: `text` `a -- `, `off` 5, `empty` true; typing `z` after it gives `a -- z` (not converted again).
- fr sample: the two guillemets are `ab 00a0 ... 00a0 bb` (U+00AB U+00A0 ... U+00A0 U+00BB), never a plain space inside.
- P-af-row in 8 languages at 960 x 560 and 1280 x 800: `on` true, `inside` true, `clipped` 0, no `settings.` key in `label` or `hint`.
Engine features relied on: ProseMirror `handleTextInput` (it is reached from the DOM mutation of a typed character in WKWebView and WebKitGTK, as in Chromium; a character from an input method arrives inside a composition and is skipped through `compositionstart` / `compositionend` and `view.composing`; WebKit fires `compositionend` BEFORE the final `input`, Chromium after, so the editor also ignores keystrokes for 150 ms after `compositionend`), `performance.now()`, Unicode property escapes `\p{L}\p{N}` in a regular expression (Safari 11.1+, WebKitGTK 2.20+), prosemirror-history undo (nothing engine specific).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-34.01 | Mac, Linux | typing sample 1 and Cmd+Z after each change (items 1-2) | P-af-text, P-af-caret | as above | OPEN |
| WK-34.02 | Mac | smart quotes and dashes on: one quote character, not two (item 4) | P-af-text | `“x”` not `““x””`, no extra character | OPEN |
| WK-34.03 | Mac (Japanese input), Linux (ibus) | commit a word with `...` or `--` with Return (item 3) | P-af-text | the text is exactly what the input method produced | OPEN |
| WK-34.04 | Mac, Linux | de and fr samples (item 5); the Settings row in de and ja | P-af-text, P-af-row | as above | OPEN |

### 34.2 W3.1 Format painter

Visible changes, what to look at:
1. **Button and key.** In a window of 1,900 px: a brush button (pressed state) after Undo / Redo; narrower: a More row with the check and the hint Cmd+Shift+D. Cmd+Shift+D in the editor turns it on once; again it paints the selection (or the word at the caret).
2. **Pointer.** While on, the pointer over the text is a black brush with a white outline (hotspot on the bristles); normal again when off; over the toolbar and outside the editor it is the normal pointer. Light and dark theme, and the dark preview canvas of the compose window.
3. **Painting.** Select "Alpha" (bold, red, 14 pt, Georgia), click the button, drag over "Gamma": painted on release, the button released, the pointer normal. Double-click the button (trackpad and mouse): it stays on, three drags paint three words, Esc stops it. A click without a drag in a word paints the whole word; on a space or past the end of a line it paints no text.
4. **Keyboard.** Put the caret in "Alpha", Option+Shift+Right (selects the word), Cmd+Shift+D (on), Option+Shift+Right to "Gamma" with the arrows, nothing changed yet, Cmd+Shift+D paints it and it is off. VoiceOver says "Format painter is on. Select the text to format." and "Format painter is off."
5. **Ends** on: typing, a click into Subject, the Bold button, Esc (with the Paste options button showing, the first Esc ends the painter, the second closes the button).

Probes:
- P-fp-state: `const b=document.querySelector('[data-rove="painter"]');const ed=document.querySelector('.cp-editor .tiptap');const p=ed.querySelector('p');return JSON.stringify({button:!!b,pressed:b&&b.getAttribute('aria-pressed'),on:b&&b.classList.contains('on'),brush:ed.classList.contains('fmt-painting'),cursor:getComputedStyle(p).cursor.slice(0,40),status:(document.querySelector('.cp-fmt [role=status]')||{}).textContent})`
- P-fp-marks (marks of the first text node containing a word; change `Gamma`): `const e=document.querySelector('.cp-editor .tiptap').editor;let m=null;e.state.doc.descendants(n=>{if(m===null&&n.isText&&n.text.includes('Gamma'))m=n.marks.map(x=>x.toJSON())});return JSON.stringify(m)`
- P-fp-more (open the More menu first): `const r=[...document.querySelectorAll('.menu-row')].find(x=>/Format painter|Pinceau|格式刷|Copiar formato|書式のコピー|Format übertragen|Формат по образцу|Cọ định dạng/.test(x.textContent));return JSON.stringify(r?{text:r.textContent,role:r.getAttribute('role'),checked:r.getAttribute('aria-checked'),h:Math.round(r.getBoundingClientRect().height),clipped:r.scrollWidth>r.clientWidth+1}:null)`

PASS (numbers):
- P-fp-state off: `pressed` "false", `brush` false, `cursor` "auto" or "text"; on: `pressed` "true", `on` true, `brush` true, `cursor` starting with `url("data:image/svg+xml` (WebKit may report the computed value as `url(...) 6 16, copy`; a plain `copy` or `auto` while on is a FAIL: the engine refused the image), `status` "Format painter is on. Select the text to format." (once) or "Format painter stays on. Select text to format, or press Esc to stop." (double click).
- P-fp-marks of the painted word equals that of the source word (same JSON).
- P-fp-more: `role` "menuitemcheckbox", `checked` "false" / "true" while on, `text` contains `Cmd+Shift+D` on a Mac and `Ctrl+Shift+D` on Linux, `clipped` false in all 8 languages (longest: fr "Pinceau de mise en forme", 24 characters).
Engine features relied on: Pointer / mouse events (`mouseup` on `document`, capture), `MouseEvent.detail` 2 for the second click of a double click on a `<button>` (WebKit sets it; a trackpad double-tap that WebKit reports with `detail` 1 twice makes the button toggle on, off: report it), `Range.getClientRects()` for the "click on the word itself" test, `cursor: url("data:image/svg+xml,...") x y, copy` through a CSS custom property (`--fmt-cursor` on the editor element; the fallback `copy` shows when the engine refuses it; the CSP has `img-src data:`), prosemirror-history (one undo step).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-34.05 | Mac, Linux | the brush pointer over the text, on a light, a dark and the dark preview canvas; hotspot (item 2) | P-fp-state + the eye | `cursor` starts with `url("data:image/svg+xml`; the brush tip is at the click point | OPEN |
| WK-34.06 | Mac, Linux | painting with a mouse and a trackpad; a double click on the button (items 3, 5) | P-fp-state, P-fp-marks | as above | OPEN |
| WK-34.07 | Mac | Cmd+Shift+D, Option+Shift+Right (item 4); Full Keyboard Access | P-fp-state, P-fp-marks | the word is painted by the second Cmd+Shift+D | OPEN |
| WK-34.08 | Mac, Linux | the More row in a window under 1,000 px, in de and ja (item 1) | P-fp-more | as above | OPEN |
| WK-34.09 | Mac (VoiceOver), Linux (Orca) | the button "Format painter, toggle button" and the live messages (item 4) | accessibility inspector | role button, pressed state, status text | OPEN |

### 34.3 W3.3 Mini toolbar

Visible changes, what to look at:
1. **Shows** within 0.3 s of the release of the mouse (drag, double click, triple click, Shift+click) as a small box above the selection, centred on it, never on a selected character; below the selection when the first line is under the formatting toolbar (there is no room above) and, inside a table, below the text. Buttons: Bold, Italic, Underline | Font color (main + arrow) Highlight (main + arrow) | Link.
2. **Never** for a selection by keyboard (Shift+arrows, Option+Shift+arrows, Cmd+A), by touch or pen, inside a link (the link bubble shows), while the painter is on, during an input-method composition, when the setting is off.
3. **Use.** Clicking a button keeps the selection and the focus in the text; B / I / U show pressed and the box stays; the arrow of a colour opens the palette under the box; Link opens the link popover under the Link button and the box goes.
4. **Hides** on Esc (selection kept), typing, an arrow key, a press elsewhere, a scroll of the editor or the pane, a window resize, the window losing the focus, the focus moving to Subject / To; Cmd+B keeps it (B pressed).
5. **Keyboard.** Alt+F10 (on a Mac keyboard that needs fn: fn+Option+F10, or Full Keyboard Access) moves the focus to Bold; Right / Left / Home / End; Return on Italic; Esc returns to the text and hides it.
6. **Settings > Composing** "Show the mini toolbar when you select text" (on by default); in the signature editor of Settings the box is drawn above the dialog.

Probes:
- P-mt-box (select a word with the mouse first; poll up to 300 ms): `const m=document.querySelector('.mini-tb');if(!m)return JSON.stringify(null);const r=m.getBoundingClientRect();const s=getSelection();const g=s.getRangeAt(0);const w=document.createTreeWalker(g.commonAncestorContainer.nodeType===3?g.commonAncestorContainer.parentNode:g.commonAncestorContainer,NodeFilter.SHOW_TEXT);const L=[];for(let n=w.nextNode();n;n=w.nextNode()){if(!g.intersectsNode(n))continue;const q=document.createRange();q.selectNodeContents(n);if(n===g.startContainer)q.setStart(n,g.startOffset);if(n===g.endContainer)q.setEnd(n,g.endOffset);for(const c of q.getClientRects())if(c.width>0)L.push(c)}const l=Math.min(...L.map(c=>c.left)),h=Math.max(...L.map(c=>c.right)),t=Math.min(...L.map(c=>c.top)),b=Math.max(...L.map(c=>c.bottom));return JSON.stringify({w:Math.round(r.width),h:Math.round(r.height),overlap:!(r.right<=l||r.left>=h||r.bottom<=t||r.top>=b),above:r.bottom<=t,below:r.top>=b,gap:Math.round(r.bottom<=t?t-r.bottom:r.top-b),centreOff:Math.round((r.left+r.right)/2-(l+h)/2),inside:r.left>=8-.5&&r.right<=innerWidth-8+.5&&r.top>=8-.5&&r.bottom<=innerHeight-8+.5,z:getComputedStyle(m).zIndex,label:m.getAttribute('aria-label'),role:m.getAttribute('role'),focusInText:document.activeElement.classList.contains('ProseMirror')})`
- P-mt-none (after a keyboard selection or a touch selection; wait 400 ms): `return JSON.stringify(!!document.querySelector('.mini-tb'))`
- P-mt-keys (after Alt+F10 and after each Right): `const a=document.activeElement;return JSON.stringify({rove:a.getAttribute('data-rove'),pressed:a.getAttribute('aria-pressed')})`

PASS (numbers):
- P-mt-box: `overlap` false, `above` true (or `below` true where there is no room above or in a table), `gap` 8 (+-1), `centreOff` 0 (+-2) unless it was kept 8 px inside the window, `inside` true, `h` 34-38, `w` 195-250 (WebKit's font metrics may move it by a few px; a fr / de name changes nothing here, the buttons are icons), `z` "79", `role` "toolbar", `label` the language's name (en "Mini toolbar", de "Mini-Symbolleiste", fr "Mini barre d’outils", ja "ミニツールバー", ru "Мини-панель инструментов", es "Minibarra de herramientas", vi "Thanh công cụ nhỏ", zh-Hans "浮动工具栏"), `focusInText` true.
- P-mt-none: `false` after Shift+arrows, Ctrl+A, a touch selection and an IME composition.
- P-mt-keys after Alt+F10: `rove` "mini:bold"; after Right x7: "mini:italic", "mini:underline", "mini:fontColor", "mini:fontColor:opts", "mini:highlight", "mini:highlight:opts", "mini:link".
Engine features relied on: Pointer Events (`pointerType` "mouse" / "touch" / "pen"; Safari 13+, WebKitGTK 2.40), `Selection.getRangeAt` + `Range.getClientRects()` per text node (WebKit returns one rect per line box; the code takes the union of the text rects, not the rects of whole paragraphs), `position: fixed` with `z-index: calc(var(--z-menu) - 1)`, a `scroll` listener in the capture phase on `window` (WebKit sends no scroll event to `window` for an inner scroll box when the listener is not capturing), `focusin` (WebKit does not focus a `<button>` on a mouse click, so nothing relies on a click moving the focus), `compositionstart` / `compositionend`, the CSS animation `pop` (the box is measured while it runs; the placement uses `offsetWidth` / `offsetHeight`, which a transform does not change).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-34.10 | Mac, Linux | drag, double click, triple click, Shift+click on a word of the second line, then on the first line and the last visible line (item 1) | P-mt-box | as above | OPEN |
| WK-34.11 | Mac, Linux | Shift+arrows, Option+Shift+arrows, Cmd+A, a touch screen / trackpad force-click selection (item 2) | P-mt-none | `false` | OPEN |
| WK-34.12 | Mac, Linux | B / I / U, a colour from the palette, Link, then Esc, typing, a scroll, a resize (items 3-4) | P-mt-box, P-mt-none | the box stays while formatting, `null` after each hide key | OPEN |
| WK-34.13 | Mac (Full Keyboard Access), Linux | Alt+F10 and the arrows, Return on Italic, Esc (item 5) | P-mt-keys | as above | OPEN |
| WK-34.14 | Mac, Linux | the signature editor in Settings at 960 x 560: the box is above the dialog, in the theme; light and dark (item 6) | P-mt-box | `z` "79" (the dialog is 70), `inside` true | OPEN |
| WK-34.15 | Mac (VoiceOver), Linux (Orca) | the box is not announced when it appears; Alt+F10 says its name and "Bold, toggle button" | accessibility inspector | no live region in the box | OPEN |

## 35. WP4 (coder, `feature/v107-wp4`, W4.1 to W4.7, D-063; section number 35 because the WP3 coder took 34 first)

Nothing here was run on a Mac or Linux. Windows (Chromium, dev preview with the mock backend, real browser drags with `Input.dispatchDragEvent`): `node scripts/test-popout-nav.mjs`, `test-popout-dnd.mjs`, `test-popout-kinds.mjs` (each with `--require-browser`); the pure rules are `test-drag-drop.mjs`, `test-popout.mjs`, `test-caption-colors.mjs` (`node --experimental-strip-types`); Rust: `cargo test --lib drag popout wintheme capability_tests`. What can differ on WKWebView / WebKitGTK: HTML5 drag and drop BETWEEN two web views (custom types, `dropEffect`, drops on a window that is behind another), tooltips on disabled buttons, flex layout of the new window pages, SVG icon sizes, `outline-offset` with a negative value, and on a Mac the native title bar. The kit scripts are in `E:\hey-mail\e2e-v107-wp4\` (`mac-leak.mjs`, `acl.mjs`, `memory.ps1`, `memory-unix.md`).
Kit needs: the debug build with the bridge on the SHA under test; two mailboxes with a user folder "Projects" and an Archive; a conversation list of 5 or more rows; one conversation with an attachment; a stub mailbox with a few scheduled messages (one failed); `E:\hey-mail\e2e-v107-wp4\mac-leak.mjs` for the leak.

Visible changes, what to look at:
1. **macOS title bar (D-063)**: every window (main, compose, reader, and the new kinds) has a transparent title bar, so the strip above the page is the window's background colour (the app's own ground `--bg`: rgb(27,28,32) in Dark, white in Light) and not the system's grey (35,36,39 in Dark was measured). The title text and the traffic lights stay. Look at Dark and Light, each of the window kinds, the main window at 960 x 560 and 1280 x 800, and after a theme change with System + an OS switch.
2. **A closed window leaves nothing behind (W4.1, Mac)**: the tao fix. `mac-leak.mjs` (20 cycles of compose / reader / mixed, a stress run of 100): `nsapp.total`, `nsapp.titled` and the window-server count back to the baseline, footprint growth < 0.2 MB per cycle. Linux: the same script reports `webviewWindows` and RSS (AC-4.1.8).
3. **Page process dies (W4.2, Linux)**: `kill -9` of the `WebKitWebProcess` of a compose window: the window reloads with its text (up to the last snapshot) once; a second kill closes it with "A window stopped working and was closed." and the recovery toast. macOS has no hook (wry owns the navigation delegate): the 8 s `watch_content` reload is the net.
4. **Previous / Next in the reader window (W4.4)**: two icon-only buttons (chevron up / down) first in the toolbar, then a separator; `k` / `j`; the ends are disabled with a tooltip. Look at 520 px (both stay on screen), at the minimum height, light and dark, de / ru / vi / ja / fr / es / zh-Hans.
5. **Move to main window (W4.5)**: in a compose window the right end of the toolbar has an icon button (square with an arrow) instead of Pop out; Cmd+Shift+O (Ctrl+Shift+O) does the same; the pane is inert while the main window may be asking.
6. **Drag and drop (W4.7)**: a row of the list, the subject of a reader window and an attachment chip start a drag; the folders of the folder pane that accept show the selected look (`.fp-row.drop-hot`: background + 2 px accent outline, inset), the others show nothing and the pointer says "not allowed"; the editor of another message takes a chip (dashed outline `.compose-pane.chip-over`).
7. **New windows (W4.6)**: event, Settings, search results and Scheduled list in their own windows (the dialog as the page of the window: `.modal-page` > `.modal.windowed`, no header, no backdrop); the "Open in new window" icon button in the header of the event dialog and the Settings dialog (left of the close button, `.modal-head-acts`) and in the list header for a search / the Scheduled view (`.ml-newwin`).

Probes (DOM only; the body is for the bridge `/eval`, in the window named):
- P-strip (item 1, Mac; not DOM): `GET /windows` for the label, then `screencapture -x -o -l <CGWindowID> /tmp/w.png` (the id: `osascript -l JavaScript -e 'ObjC.import("CoreGraphics");ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly,$.kCGNullWindowID))).filter(w=>w.kCGWindowOwnerName=="Hey Look!").map(w=>[w.kCGWindowNumber,w.kCGWindowName])'`) and `magick /tmp/w.png -format "%[pixel:p{900,30}] %[pixel:p{900,100}]" info:` (a point in the title bar strip, a point of the page's ground; at 2x the picture is 2x: x 1800, y 60 and 200). The log gives the same from the app: `startup.log` `[wintheme]` lines `window: <label> ... titlebarAppearsTransparent true`.
- P-nav (item 4, in `reader-<n>`): `const bar=document.querySelector('.reader-bar').getBoundingClientRect();const b=[...document.querySelectorAll('.reader-bar .rb.nav')].map(x=>{const r=x.getBoundingClientRect(),s=x.querySelector('svg')?.getBoundingClientRect();return {label:x.getAttribute('aria-label'),title:x.title,disabled:x.disabled,text:x.textContent.trim(),box:[r.left,r.top,r.width,r.height].map(Math.round),svg:s?[Math.round(s.width),Math.round(s.height)]:null,inside:r.left>=bar.left-1&&r.right<=bar.right+1}});return JSON.stringify({win:[innerWidth,innerHeight],b,active:document.activeElement?.tagName,h1:document.querySelector('.rp-head h1')?.textContent,scroll:document.querySelector('.reader-pane')?.scrollTop})` (read after a press of the button / `j`)
- P-popin (item 5, in `compose-<n>`): `const b=document.querySelector('.cp-bar .icon-btn[data-fit="fixed"]');const r=b?.getBoundingClientRect(),s=b?.querySelector('svg')?.getBoundingClientRect();return JSON.stringify({label:b?.getAttribute('aria-label'),title:b?.title,box:r?[r.left,r.top,r.width,r.height].map(Math.round):null,svg:s?[Math.round(s.width),Math.round(s.height)]:null,inert:document.querySelector('.compose-pane')?.hasAttribute('inert'),busy:document.querySelector('.compose-pane')?.getAttribute('aria-busy')})`
- P-dnd-log (item 6, install in BOTH the source and the target window before the drag; read after): `window.__dnd=[];for(const t of ['dragstart','dragenter','dragover','drop','dragend'])window.addEventListener(t,e=>{if(window.__dnd.length<60)window.__dnd.push([t,[...(e.dataTransfer?.types||[])].join(','),e.dataTransfer?.effectAllowed,e.dataTransfer?.dropEffect,e.defaultPrevented])},true);return 1` then `return JSON.stringify(window.__dnd)`
- P-dnd-hot (item 6, in `main`, while the pointer is held over a folder): `return JSON.stringify([...document.querySelectorAll('.fp-row.drop-hot')].map(r=>{const c=getComputedStyle(r),b=r.getBoundingClientRect();return {acct:r.dataset.acct,key:r.dataset.key,outline:c.outlineStyle+' '+c.outlineWidth,offset:c.outlineOffset,bg:c.backgroundColor,box:[b.left,b.top,b.width,b.height].map(Math.round)}}))`
- P-dnd-chip (item 6, in the target `compose-<n>` during and after the drop): `const p=document.querySelector('.compose-pane');return JSON.stringify({over:p.classList.contains('chip-over'),outline:getComputedStyle(p).outlineStyle,chips:[...document.querySelectorAll('.att-chip .ellipsis')].map(e=>e.textContent.trim())})`
- P-win (item 7, in the new window): `const m=document.querySelector('.modal.windowed,.reader-win');const r=m?.getBoundingClientRect();return JSON.stringify({kind:document.querySelector('[data-popout]')?.dataset.popout,title:document.title,win:[innerWidth,innerHeight],box:r?[r.left,r.top,r.width,r.height].map(Math.round):null,head:!!document.querySelector('.modal-head'),back:!!document.querySelector('.modal-back'),scrollX:document.documentElement.scrollWidth>innerWidth})`
- P-nav-clip (item 7, in `settings-<n>` at its minimum size 720 x 500, de and ru): `return JSON.stringify([...document.querySelectorAll('.settings-nav button')].filter(b=>b.scrollWidth>b.clientWidth+1).map(b=>[b.textContent.trim(),b.scrollWidth,b.clientWidth]))`
- P-search (item 7, in `search-<n>`): `const b=document.querySelector('.search-win .ml-body');const r=b.getBoundingClientRect();return JSON.stringify({rows:document.querySelectorAll('.ml-row').length,body:[r.width,r.height].map(Math.round),scrolls:b.scrollHeight>b.clientHeight,query:document.querySelector('.sw-query')?.textContent,sel:document.querySelector('.ml-row.selected')?.dataset.thread})`
- P-newwin (item 7, in `main` with a search and in the event / Settings dialog): `const b=[...document.querySelectorAll('.ml-newwin,.modal-head-acts button')].map(x=>{const r=x.getBoundingClientRect();return {label:x.getAttribute('aria-label'),box:[r.left,r.top,r.width,r.height].map(Math.round),inside:r.right<=innerWidth&&r.left>=0}});return JSON.stringify({b,overflow:document.querySelector('.ml-head')?.scrollWidth>document.querySelector('.ml-head')?.clientWidth})`

PASS (numbers):
- P-strip: the pixel in the strip equals the pixel of the page's ground within 3 per channel in Dark (27,28,32 +-3, not 35,36,39) and in Light (255,255,255 +-3), for main, compose, reader and a window of each new kind; the log says `titlebarAppearsTransparent true` for every window. The title text is white in Dark and dark in Light (look).
- Leak (`mac-leak.mjs`): every `verdict` entry PASS; `memoryPerCycleMB` < 0.2; WebContent back to the baseline within 30 s; the control build (before the patch) shows `nsapp.total` growing by about the number of cycles (AC-4.1.1).
- P-nav: two entries; `text` ""; `svg` [16,16] (+-1); `box` width >= 30 and height >= 30; `inside` true at 520 px; after a press the `h1` is the new subject, `active` "H1", `scroll` 0; at the ends `disabled` true with the title "This is the first/last conversation in the list". On the Mac the disabled button still shows its tooltip (hover 1.5 s): if WKWebView shows none, report it (the plan is then an `aria-disabled` button with the same title).
- P-popin: `label` "Move to main window" (the language's), `title` ends with "(Cmd+Shift+O)" on a Mac, `svg` [16,16], `box` height >= 28; during the wait `inert` true and `busy` "true"; not present while "Sending…" runs.
- P-dnd-log: the SOURCE window logs `dragstart` with types containing `application/x-heylook-mail` (or `-file`) and `application/x-heylook-tok-<uuid>` and nothing like `text/plain`; the TARGET window logs `dragenter`/`dragover` with the SAME type names (the custom types must cross the two web views), `dragover` with `defaultPrevented` true over a folder that accepts and false over one that does not, `drop` once. If the types do not cross on WKWebView / WebKitGTK, stop and report: the fallback (documented, not enabled) is a second flavour `text/plain` = `heylook-drag:<token>` in `dragWire.ts begin` and `dragDrop.ts tokenIn`.
- P-dnd-hot: exactly one entry while over an accepting folder: `outline` "solid 2px", `offset` "-2px", `bg` the selected colour; none over Unread, Drafts, the current folder or a folder of another mailbox; none after the drop.
- P-dnd-chip: over the target: `over` true and `outline` "dashed"; after the drop the target's `chips` has the file once, the source still has it; dropped on its own message: `over` false, nothing added.
- P-win: `kind` the window's kind, `title` "<title> – Hey Look!", `box` = [0,0,innerWidth,innerHeight] +-1 for `.modal.windowed`, `head` false, `back` false, `scrollX` false at the default and at the minimum size.
- P-nav-clip: `[]` in de and ru at 720 x 500 (no label clipped).
- P-search: rows >= 1, `body` height > 100, `scrolls` true with 30 or more results, `query` the search text.
- P-newwin: the button inside the header (`inside` true), `overflow` false at 960 x 560 in de and ru.
Engine features relied on: HTML5 drag and drop with custom `dataTransfer` types between web views of one app (`dragstart`, `dragenter`, `dragover`, `drop`, `types` readable before the drop; `effectAllowed` "move" / "copy"; `disable_drag_drop_handler` leaves it to the page); `draggable="true"` on a `div`, `span` and `h1` (WebKit: the attribute is enough); `outline-offset` negative; `position: fixed` / flex `100vh` page for the windowed dialog (no `dvh`); the title attribute on a disabled button (tooltip); `NSWindow.titlebarAppearsTransparent` (macOS 10.10+); `proc_pid_rusage` (macOS 10.9+). No `clamp()`, `:has()`, `inert` beyond what the pane already used, `color-mix` beyond the existing tokens, scroll-padding or `dvh` in the new rules.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-35.01 | Mac | the strip above the page in Dark and Light, main + compose + reader + the four new kinds, 960 x 560 and 1280 x 800, after System + an OS switch (item 1, D-063) | P-strip + log | as above | OPEN |
| WK-35.02 | Mac | 20 cycles compose (Cmd+W), 20 reader (native close), 20 mixed, 100 stress, then Cmd+Q with a changed compose window, the red button of main, the Dock click (item 2) | `mac-leak.mjs` | all PASS | OPEN |
| WK-35.03 | Mac (control build) | the same on the commit before the patch: the leak must show (AC-4.1.1) | `mac-leak.mjs` | `nsapp.total` + about 20 | OPEN |
| WK-35.04 | Linux | 20 compose cycles: `webviewWindows` back, RSS < 0.2 MB per cycle (AC-4.1.8) | `mac-leak.mjs --mode=compose` | as above | OPEN |
| WK-35.05 | Linux | `kill -9` of a compose window's WebKitWebProcess twice (item 3, AC-4.2.6) | startup.log + the window | reload once, close the second time with the toast | OPEN |
| WK-35.06 | Mac, Linux | the reader toolbar buttons: size, 520 px, focus on the subject, tooltips on a disabled button, 8 languages, light and dark (item 4) | P-nav | as above | OPEN |
| WK-35.07 | Mac, Linux | Move to main window in a compose window: icon, tooltip with the platform key, Cmd/Ctrl+Shift+O from the body and from the To field, inert while waiting (item 5) | P-popin | as above | OPEN |
| WK-35.08 | Mac, Linux | a drag from the list to a folder in the same window: highlight, drop, Undo; not-allowed targets show nothing (item 6) | P-dnd-hot, P-dnd-log | as above | OPEN |
| WK-35.09 | Mac, Linux | a drag from a reader window's subject to a folder of the main window (two web views, the source behind the target and the reverse) (item 6) | P-dnd-log in both | the custom types cross; `drop` once; the reader closes | OPEN |
| WK-35.10 | Mac, Linux | a chip from one compose window into another, and between the inline pane and a window; its own message does nothing (item 6) | P-dnd-chip, P-dnd-log | as above | OPEN |
| WK-35.11 | Mac | trackpad and mouse drags; Esc while dragging; a drop on the Dock or the desktop (nothing happens) (item 6) | P-dnd-log | no `drop` in a window; nothing moved | OPEN |
| WK-35.12 | Mac, Linux | the event window and the Settings window at default and minimum size, light and dark: the page fills the window, no header, no scrollbar of the page (item 7) | P-win | as above | OPEN |
| WK-35.13 | Mac, Linux | the Settings window at 720 x 500 in de and ru (item 7, AC-4.6.11) | P-nav-clip | `[]` | OPEN |
| WK-35.14 | Mac, Linux | the search window (30 or more results) and the Scheduled window: rows, scroll, selection, the empty search text (item 7) | P-search | as above | OPEN |
| WK-35.15 | Mac, Linux | the "Open in new window" buttons in the event dialog, the Settings dialog and the list header at 960 x 560 in de and ru (item 7) | P-newwin | as above | OPEN |
| WK-35.16 | Mac, Linux | `acl.mjs` on each system with a compose, a reader and (after WP4c) an event, search, scheduled and Settings window open: the table of refused / reached (AC-4.9.4) | `acl.mjs` | all as expected | OPEN |

### 35.B fix23 (coder, `feature/v107-fix23`): D-093 leak, D-092 title strip, D-094 window cap, D-095 toast

Nothing here was run on a Mac or Linux. The Mac code (macwin.rs `hold` / `sweep` / `check` / `set_ground`) was type-checked in a scratch crate for `aarch64-apple-darwin` (`cargo check`, the real files, stand-ins only for startup / wintheme / bgcolor); Rust source guards: `popout::tests::the_macos_sweep_takes_away_every_reference_the_app_side_can_and_checks_the_result`, `windows_on_their_way_out_do_not_count_against_the_cap_of_eight`.

What changed and what to look at:
1. **D-093, what the sweep does now** (one second after a window's `Destroyed`, main thread): `setDelegate:nil`; `removeObserver:` of tao's delegate on `NSDistributedNotificationCenter` and `NSNotificationCenter` (tao registers the delegate for `AppleInterfaceThemeChangedNotification` and never removes it) and of the window on the default centre; `NSApp removeWindowsItem:`; the content view is replaced by an empty `NSView` (tao's view, wry's parent view and the web view's views go, so the memory of a leftover shell is a few KB); `orderOut:`, `close`; our references are dropped. A weak reference is kept, and `check` (one more second later: `COUNT_AFTER`) logs `native window N: freed` or `STILL ALIVE ... retain count n` and counts it. `GET /native` has a new `sweeps: { swept, freed, alive }` on macOS: `alive` is the leak. startup.log lines: `<label>: native window N: visible a then b, retain count x then y ..., delegate retain count z; NSApp lists ...` and `<label>: native window N: freed (...)` / `STILL ALIVE ...`.
2. **Experiment (debug build only)**: `HEYLOOK_MAC_RELEASE_LEAK=1` makes `check` release a still-alive window once when its retain count is exactly 2 (this check's own reference plus ONE leaked one). Run it only on the Mac session's debug build; a release build never reads the variable (a Rust guard pins that). If `alive` stays 0 with it and nothing crashes in 100 cycles, the leak is exactly one reference and the experiment can become the fix (report the retain counts from the log first).
3. **D-092, strip of the reader window**: the reader's reading toolbar (`.reader-bar`) is `--bg2` = #232429 = (35,36,41), exactly the colour QA measured as the strip, while the native strip is the window's background colour = `--bg` = (27,28,32). Sample the strip INSIDE THE NATIVE TITLE BAR (y from 2 to 24 px of the window frame, x between the traffic lights and the right edge), not below it; the first row of the page starts below the title bar. `macwin::apply_appearance` now also sets `NSWindow.backgroundColor` natively (`set_ground`, the same two values as bgcolor.rs) for EVERY window of every kind, at creation and at every theme change.

Probes (the bridge `GET /native` and the window screenshot of the Mac session):
- P-sweeps: `GET /native` -> `sweeps`, `nsapp.total`, `nsapp.titled` before and after 20 cycles (mac-leak.mjs modes compose, reader, mixed, stress).
- P-strip2 (Mac): for each window kind (main, compose, reader, event, search, scheduled, settings) in Dark and Light: `screencapture -x -o -l <CGWindowID>` and read the pixels at y = 4, 12 and 22 (title bar) and at y = 40 (page): title-bar pixels must equal (27,28,32) Dark / (255,255,255) Light within 3 per channel; `GET /eval` in the window: `const c=getComputedStyle(document.querySelector('.reader-bar')).backgroundColor` documents the page colour that must NOT be mistaken for the strip.

PASS (numbers): after 20 compose cycles and after 20 reader cycles: `nsapp.total` and `nsapp.titled` equal to the baseline (delta 0, tolerance 0) or, if the leak remains, `sweeps.alive` = cycles and footprint growth < 0.2 MB per cycle (the views are freed even then); WebContent back to the baseline within 30 s; strips as above for all 7 kinds; Cmd+W in a compose window with text asks (Discard / Save / Cancel) like the red button, in an empty one closes at once; after 20 mixed cycles Settings, search and Scheduled windows open (a ninth live window is refused with the toast, a closing window is not counted).
Engine features relied on: `NSWindow.backgroundColor`, `titlebarAppearsTransparent`, `NSColor colorWithSRGBRed:green:blue:alpha:` (macOS 10.9 and later), `-[NSApplication removeWindowsItem:]`, weak references to windows (`objc2::rc::Weak`, ARC zeroing weak references).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-35.17 | Mac | 20 compose cycles (Cmd+W), 20 reader cycles, then the mixed and the stress runs: `nsapp.total`, `titled`, window-server count, footprint per cycle; `sweeps` and the `freed` / `STILL ALIVE` lines in startup.log (D-093) | P-sweeps + `mac-leak.mjs` | delta 0 / < 0.2 MB per cycle / `alive` 0 | OPEN |
| WK-35.18 | Mac (debug build) | the same with `HEYLOOK_MAC_RELEASE_LEAK=1` (experiment): `alive` 0, no crash in 100 cycles, retain counts in the log | P-sweeps | `alive` 0, no crash | OPEN |
| WK-35.19 | Mac | the strip of every window kind in Dark and Light (D-092) | P-strip2 | within 3 per channel of the ground | OPEN |
| WK-35.20 | Mac | Cmd+W (real key) in a compose window with text and in an empty one; 20 mixed cycles; then Settings, a search and the Scheduled list open (D-094) | `mac-leak.mjs --mode=mixed` + bridge | the question appears with text; all three windows open | OPEN |
| WK-35.21 | Linux | `kill -9` of a compose window's WebKitWebProcess twice: the toast "A window stopped working and was closed." is in the main window's `window.__store.getState().toasts` and on screen until it is closed (D-095: it was a timed 8 s toast, now sticky) | `/eval` in main | one toast with `sticky` true after 10 s | OPEN |

#### 35.B round 10b additions (coder, `feature/v107-fix24`): teardown before a window ends, the page's top edge on macOS

What `leaks --traceTree` shows and what it does not: it lists every word of memory that holds the address of the window, including raw pointers that retain nothing (the 1280-byte Rust block at +720 of the web view's ivars is most likely a plain `NSWindow *` of a handler's captured state). So the list of holders is not a list of retains; the discriminating numbers are the retain counts, which `sweep` / `check` log (`retain count x then y`, `delegate retain count z`, `STILL ALIVE ... retain count n`). Please send those lines of the 5-cycle run together with the next tree.
New in this commit: `macwin::teardown` runs on the main thread BEFORE `w.destroy()` (`destroy_on_event_loop`) and when a close that goes straight through starts (reader, Settings, search, Scheduled): first responder cleared, `unregisterDraggedTypes` on the window and every view below its content view, every notification observer of the window, its delegate and its views removed on both centres, the web view's navigation / UI delegate cleared, loading stopped, detached, title bar accessories and toolbar removed, the content view replaced by an empty one; one startup.log line per window: `<label>: teardown: first responder <class> cleared true; n drag destination(s) unregistered; ...; frame view children before: <classes>; m view(s) below the content view`. The frame-view children list shows whether the SwiftUI hosting view of the title bar widgets (`_NSCoreHostingView<ThemeWidgetView>`) hangs there: it is created by the system for the title bar (macOS 26 / 27), the app does not make it and does not remove it. Experiment (debug builds only): `HEYLOOK_MAC_RELEASE_LEAK=1` releases the remaining references one by one (at most 40, `HEYLOOK_MAC_RELEASE_KEEP=<n>` leaves n) and logs whether the window is gone; a crash while it runs means one of the holders was real and live. No handler of ours keeps a window or webview handle: the popout registry, the labels and the event handlers hold label strings only (grep: no `WebviewWindow` / `Window` is stored or captured by a closure that outlives its window).
D-092: the reader's strip was (35,36,41) = `--bg2` = the colour of `.reader-bar`; on macOS (`<html data-os="macos">`, set from shell_info) the reader's bar and the windowed Settings' nav now use `--bg`; search, Scheduled and event windows already start with the ground colour. Measure the native strip at y = 2 to 24 px of the window (CGWindowListCreateImage / `screencapture -l`), not below it.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-35.22 | Mac | 5 reader and 5 compose cycles with the debug build: the `teardown:` and `native window N:` lines of startup.log; `GET /native` `sweeps`; `leaks --traceTree` of a leaked window afterwards: which holders are gone | P-sweeps + log | the lines are there; after the experiment (`HEYLOOK_MAC_RELEASE_LEAK=1`) `alive` 0 | OPEN |
| WK-35.23 | Mac | the top 2 to 24 px of the window of every kind (reader, search, Scheduled, event, Settings) in Dark and Light | P-strip2 | within 3 per channel of (27,28,32) Dark / (255,255,255) Light | OPEN |

#### 35.B round 11a correction (coder, `feature/v107-fix26`): the teardown runs AFTER the window has ended

fix24 ran `macwin::teardown` BEFORE `w.destroy()`, and no window could be closed any more (the label stayed in `/windows`, `webviewWindows` grew by one per close, "no native window" every 2 s). Cause: AppKit delivers `windowWillClose:` to the window's delegate through an observer that the window registers itself when it gets the delegate, and tao's `Destroyed` event (which removes the label from tauri's manager) comes from that method; the teardown's `removeObserver:` for the delegate (and the window) cancelled that registration. Now the destroy is requested first and alone (`<label>: destroy requested`), the `Destroyed` event is logged (`<label>: destroy done (the Destroyed event came)`), and the teardown is the first part of the sweep a second later (`<label>: native window N: teardown done (<what was undone>); visible ... retain count x then y ...`), on the pointer held at creation. The wintheme poll leaves a window that is on its way out alone.
| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-35.24 | Mac | 20 compose and 20 reader cycles (mac-leak.mjs): every close takes the label out of `/windows` within 3 s; startup.log has `destroy requested`, `destroy done`, `teardown done`, `native window N: freed` or `STILL ALIVE` per window; no `no native window` lines | `/windows`, startup.log | 0 labels left, 4 lines per window, 0 `no native window` | OPEN |

#### 35.B fix27 (coder, `feature/v107-fix27`): D-097, the three window buttons no longer lie over the page headers

Cause: tauri's default title bar style on macOS ("Visible") builds every window with `NSWindowStyleMaskFullSizeContentView` (tauri-runtime-wry `title_bar_style`: `with_fullsize_content_view(true)`, 0x800f = titled + closable + miniaturizable + resizable + full-size content view), and D-063 (W4.3, `macwin::set_one`) made the title bar transparent: the page started at y = 0 under the buttons. It arrived with W4.3 / D-063 (before that the opaque bar covered the strip; 1.0.6 never set `titlebarAppearsTransparent`).
Fix: the main window gets `"titleBarStyle": "Transparent"` in tauri.conf.json, every secondary window `.title_bar_style(TitleBarStyle::Transparent)` in `popout::create` (transparent title bar, NO full-size content view), and `macwin::set_one` clears the flag (1 << 15) from any window that still has it. The native strip keeps the window's background colour (the ground colour, D-063), the buttons have their own band (macOS standard 28 px), the page starts below it, nothing in the page was moved. The reader bar / Settings nav `--bg` override of fix24 stays (the strip and the first row of the page are one colour).
Windows and Linux: unchanged (the key is read on macOS only).

Probes (Mac session, bridge `/eval` in each window and `/native`):
- P-d097-mask: `GET /native` -> per window `styleMask`.
- P-d097-top: `(()=>{const k=[...document.querySelectorAll('header, .reader-bar, .rp-head, .compose-pane > *:first-child, .modal.windowed > *:first-child, h1')].slice(0,6).map(e=>{const r=e.getBoundingClientRect();return [e.className||e.tagName,r.left,r.top,r.right,r.bottom]});return JSON.stringify({innerHeight,rootTop:document.getElementById('root').getBoundingClientRect().top,docTop:document.documentElement.getBoundingClientRect().top,items:k})})()`
- P-d097-ax: the AX rectangles of the close / minimise / zoom buttons in window coordinates (the Mac session's accessibility readout) against the window origin of the page: the page's y = 0 must be at or below the bottom of the buttons.

PASS (numbers): `styleMask` of every window kind has bit 0x8000 CLEARED (0x000f or 0x400f-like without it) and `titlebarAppearsTransparent` true; `rootTop` 0 in the page and the page's top-left in the window is below y = 24 (the buttons' bottom edge, 16 x 16 at (8,8), (31,8), (54,8)): the intersection of the AX button rects with every header child rect = 0 px^2; the strip colour (screenshot pixels at y = 4, 12, 22, x = 300 to 400) within 4 levels of the ground colour (27,28,32) Dark / (255,255,255) Light; no window title text drawn over a header.
Engine features relied on: `NSWindow styleMask`, `setStyleMask:`, `titlebarAppearsTransparent`, `NSWindow.backgroundColor` (macOS 10.9 and later).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-35.25 | Mac | main window at 960 x 560 and 1280 x 800, Dark and Light: the logo and the brand row are clear of the three buttons; crop of the top-left 400 x 80 | P-d097-mask, P-d097-top, P-d097-ax | intersection 0, mask bit 0x8000 clear | OPEN |
| WK-35.26 | Mac | compose window (Send, Send later, Discard, Attach clickable at their top edge; no window title over them) | as above | as above | OPEN |
| WK-35.27 | Mac | reader window: Previous and Next clickable (a real click on the upper half of each) | as above | as above | OPEN |
| WK-35.28 | Mac | search results, Scheduled, event, Settings window (windowed Settings nav: the first nav item and the close X of the dialog) | as above | as above | OPEN |
| WK-35.29 | Mac | the strip colour of every kind within 4 levels of the ground, Dark and Light (D-063 stays fixed) and a window dragged by its title bar band; a drag of a mail onto a folder and a chip between compose windows still work (the page moved down by the band, the drop targets did not move relative to the page) | P-strip2 + P-dnd-log | strip within 4, drag by the band moves the window, drops land | OPEN |
| WK-35.30 | Mac (debug build) | the devtools inspector opened in a window (tauri's note: without the full-size flag it may push the content): the page is not displaced when it opens and closes | P-d097-top | rootTop 0 before and after | OPEN |

#### 35.B fix28 (coder, `feature/v107-fix28`): D-093, the guarded release of the extra references of a finished window (ON by default)

Round 12b result: with `HEYLOOK_MAC_RELEASE_LEAK=1` the leak stops (3 warm-up + 20 cycles of compose and of reader: `nsapp.total` 5 to 5, `titled` 1 to 1, window server 6 to 6, `webviewWindows` 1 to 1, 3 min 20 s without a crash; the log: retain count 4, 3 released, `NSApp lists 8 -> 7 -> 6`). The three extra references belong to tao / wry / WebKit / AppKit and cannot be removed from our side, so the same release is now the fix, with guards (`src-tauri/src/leakfix.rs` pure rules + tests, `macwin.rs` `leak_fix`).

What happens (main thread, one second after the sweep, after `Destroyed` and `teardown_views`): the weak reference is loaded (this check's own strong reference = 1). If the window is alive and ALL of these hold: it ended by its `Destroyed` event and tauri no longer lists the label, it is not the "main" window, the app is not quitting, it is not visible, not key, not main, has no sheet, no child windows, no parent, and the kill switch `HEYLOOK_MAC_NO_LEAK_FIX=1` is not set, then `retainCount` is read before EVERY release and one reference is released while `retainCount > 1` (at most 4 per window, nothing at all when the count is above 16). The strong reference is dropped last, so the window can only be freed by that drop and no message reaches a freed object; the weak reference then says freed or still alive. A future macOS / tao / wry that fixes the leak leaves count 1: nothing is released. Log line per window (startup.log, after the `STILL ALIVE` line): `leak fix: released k extra reference(s), window freed|still alive` or `leak fix: not applied (<reason>)`. `GET /native` `sweeps`: `{ swept, freed, alive, released }` (`released` = references given back in all).

Probes (Mac session, debug build with the test bridge, `E:\hey-mail\e2e-v107-wp4\mac-leak.mjs --mode=all --cycles=20 --warmup=3`; do NOT set `HEYLOOK_MAC_RELEASE_LEAK` any more, the fix is on without it):
- P-leak28-count: `GET /native` before and after: `nsapp.total`, `nsapp.titled`, `webviewWindows`, `sweeps`.
- P-leak28-log: `grep -c "leak fix: released" startup.log`, `grep "leak fix: not applied" startup.log | sort | uniq -c`, `grep -c "STILL ALIVE" startup.log`.
- P-leak28-mem: `footprintBytes` of `/native` after each cycle (compose and reader separately), after a 20 s rest.

PASS (numbers): after 3 warm-up + 20 cycles each of compose and reader: `nsapp.total` +0, `titled` +0, window server +0, `webviewWindows` +0; `sweeps.released` > 0 and about 3 per swept window (`released` <= 4 * `swept`); `sweeps.alive` may equal `swept` (the counter says "found alive by the weak check, then released"); no `not applied` line other than none expected for a closed pop-out; NO crash and no `EXC_BAD_ACCESS` / `objc_release` in `~/Library/Logs/DiagnosticReports` over 10 minutes of mixed use (open and close compose, reader, search, Settings, Scheduled and event windows, Cmd+W, the red button, minimise, full screen on a reader before closing, Quit with windows open). Footprint per cycle: record it (round 12b: reader +1.21 MB, compose +0.22 MB with the release already on); the goal of this row is "no growth of the window list and no crash", the footprint goal is < 0.2 MB per cycle (see WK-35.34).
Kill switch check: start with `HEYLOOK_MAC_NO_LEAK_FIX=1`, 3 cycles: `leak fix: not applied (switched off` in the log, `released` stays 0, `nsapp.total` grows by 1 per cycle (the old leak).
Engine features relied on: `NSObject retainCount` / `release` on the finished window (AppKit, all macOS versions), `NSWindow isVisible / isKeyWindow / isMainWindow / attachedSheet / childWindows / parentWindow`.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-35.31 | Mac | 3 + 20 cycles compose, then reader: window list flat | P-leak28-count | `nsapp.total` +0, `titled` +0, `sweeps.released` > 0 | OPEN |
| WK-35.32 | Mac | 10 minutes of mixed use incl. Quit with windows open, full screen reader closed, minimised window closed | P-leak28-log | no crash report, no `leak fix: not applied` for a closed pop-out except the listed reasons | OPEN |
| WK-35.33 | Mac | the kill switch `HEYLOOK_MAC_NO_LEAK_FIX=1` | P-leak28-count | `released` 0, `nsapp.total` +1 per cycle | OPEN |
| WK-35.34 | Mac | footprint per cycle after the fix (reader and compose, 20 cycles, 20 s rest) | P-leak28-mem | record MB per cycle; goal < 0.2 | OPEN |

#### 35.B fix29 (coder, `feature/v107-fix29`): fix28 crashed on the first close; the release is OFF by default, the arithmetic is corrected

Round 13: fix28 (release ON by default) crashed the app on the first window close, 2 of 2 attempts: SIGSEGV `objc_release` <- `AutoreleasePoolPage::releaseUntil` <- `objc_autoreleasePoolPop` on the main thread; the log before it said `retain count 4 ... leak fix: released 4 extra reference(s), window still alive`. The experiment of fix26 released 3 (count 4 including the check's own reference) and never crashed. Cause (from the data): fix28 asked the window six questions (`isVisible`, `isKeyWindow`, ..., `childWindows`) and THEN read `retainCount` in a loop that released while the count was above 1; a question can leave a reference to the window in the autorelease pool (or retain it for the length of a call), so the count read after the questions was 5, the loop released 4 and the 4th was the pool's reference: the pool's pop released it again.

fix29: (1) the release is OFF unless `HEYLOOK_MAC_LEAK_FIX=1` (debug and release builds); `HEYLOOK_MAC_NO_LEAK_FIX=1` is a hard off that wins. (2) The count is the FIRST message sent to the window after `check` made its strong reference; the questions run inside an autorelease pool that is emptied; the count is read again; the number to release is `min(first, second) - 1` (3 for the observed 4), fixed before the first release (`leakfix::release_plan`), each release only while the count just read is above 1, and the check's own strong reference is dropped exactly once, after the loop, by the function that owns it. (3) The log line has the counts: `leak fix: released 3 extra reference(s) (retain count 4 then 4 before, planned 3, one by one: 4>3 3>2 2>1), window freed|still alive`.

Mac QA (debug and release build): first WITHOUT the variable: no `leak fix: released` line, `not applied (off ...`, no crash, `nsapp.total` grows by one per closed window (the old leak). Then with `HEYLOOK_MAC_LEAK_FIX=1`: 3 + 20 cycles of compose and reader, 10 minutes of mixed use.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-35.35 | Mac | default build, no variable, 20 compose + 20 reader closes | P-leak28-log | no crash, `leak fix: not applied (off` per window, `sweeps.released` 0 | OPEN |
| WK-35.36 | Mac | `HEYLOOK_MAC_LEAK_FIX=1`, 3 + 20 cycles each | P-leak28-count, P-leak28-log | no crash; `released` 3 per window with the trace `4>3 3>2 2>1`; `nsapp.total` +0; if the first count differs from 4 write down the line | OPEN |
| WK-35.37 | Mac | `HEYLOOK_MAC_LEAK_FIX=1` plus `HEYLOOK_MAC_NO_LEAK_FIX=1` | P-leak28-log | `not applied (off`, no release | OPEN |

#### 35.B fix30 (coder, `feature/v107-fix30`): D-099, the native title strip in the Light theme (reader and search windows)

What the numbers say: the reader strip read (21,21,21) in Light. That is the Dark ground (27,28,32) as tao writes it (`NSColor colorWithRed:green:blue:alpha:`, a colour space of its own: the dark ground reads about 21, white about 253), not the app's exact sRGB ground, and not the Light one: so the window had a Dark ground from tao's call and our sRGB call (`macwin::set_ground`) did not come after it, or came with the other theme. Two causes in the code are removed, whichever it was: (1) `bgcolor::apply` took the theme of each window from `w.theme()`, the value tao CACHED when that window was last told a theme (`set_theme` stores `current_theme`), so a window that kept an old one got the other ground: now ONE theme for all windows (`bgcolor::current`: the setting, else the OS read fresh from the global default `AppleInterfaceStyle`); (2) the exact sRGB ground was set only by the appearance pass (`macwin::apply_appearance`, its own task); `bgcolor::apply` now queues `wintheme::ground_all` on the main thread right behind tao's call, for every window (tauri's list and every other titled window), with `setOpaque: YES` (nothing behind the window or a title bar material mixes into the strip: the search window had two bands, 22 at y 6 and 240 below). The watchdog (every 2 s) now also compares the window's `backgroundColor` (converted to sRGB) with the ground of the theme and applies again when any window is more than 2 levels off (`macwin::mismatched`), so a late writer cannot leave a wrong strip.
Triggers, all through `wintheme::apply_all` -> `bgcolor::apply`: window creation (`popout::create`), the main window at start, the setting (Light / Dark / System), the OS theme (notification, tao event, watchdog), the accent / custom bar colours (their `set_setting("prefs")` path calls `apply_all`).

Probes (Mac session, the bridge `/eval` is not needed: native pixels):
- P-strip3: for each window kind (main, compose, reader, search, Scheduled, event, Settings) with the window in front: `screencapture -x -o -l <CGWindowID>`, read the pixels at x = 0.7 w and y = 6, 14 and 22 px (at 2x: 12, 28, 44): the title strip.
- P-ground-log: `startup.log` lines `  ground colour: <label>: background colour Some(..) -> Some(..)` (a window that was not right when the ground pass ran) and `watchdog: [..] do not show what the setting asks` (should not appear in a quiet run).

PASS (numbers): every pixel of P-strip3 within 4 levels per channel of the ground: Light (255,255,255), Dark (27,28,32), for all 7 kinds, with the theme set to Light, to Dark and to System (OS Light and OS Dark), and AFTER switching the open window Light -> Dark -> System -> Light (wait 3 s after each switch). No two bands (y 6 equal to y 14 and y 22 within 4).
Engine features relied on: `NSWindow.backgroundColor`, `setOpaque:`, `NSColor colorWithSRGBRed:green:blue:alpha:`, `colorUsingColorSpace:` with `NSColorSpace.sRGBColorSpace`, `NSUserDefaults` `AppleInterfaceStyle` (all macOS 10.9 and later).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-35.31 | Mac | the strip of all 7 kinds in Light (setting Light, and System with the OS in Light), x = 0.7 w, y 6 / 14 / 22 | P-strip3 | within 4 of (255,255,255), one band | OPEN |
| WK-35.32 | Mac | the same in Dark (setting Dark, and System with the OS in Dark) | P-strip3 | within 4 of (27,28,32) | OPEN |
| WK-35.33 | Mac | with a reader, a search and a Settings window open: setting Light -> Dark -> System -> Light, then the OS switched Dark and Light (System): the strip of every open window after 3 s | P-strip3, P-ground-log | within 4 each time | OPEN |
| WK-35.34 | Mac | a reader and a search window opened AFTER the theme was changed (created in Dark, then Light; created in Light, then Dark) | P-strip3 | within 4 | OPEN |
| WK-35.35 | Mac | a custom accent colour / custom top bar colour chosen with the windows open: the strip does not change (it is the ground), the page bar does | P-strip3 | within 4 of the ground | OPEN |

#### 35.B fix31 (coder, `feature/v107-fix31`): DEC-024 "mac-window-floor": no manual release, amended ACs

Decision: nothing is ever released by hand again (fix28 and fix29 crashed in `objc_autoreleasePoolPop`: the pool holds references that `retainCount` cannot tell from the leaked ones). The experiment switches are gone. What a close does: after the `Destroyed` event, one second later, on the main thread (`macwin::sweep`): `makeFirstResponder:nil`, `unregisterDraggedTypes` on the window and its views, `removeObserver:` for the window, its delegate and its views on both centres, the web view's delegates cleared / loading stopped / removed from its parent, title bar accessories and toolbar removed, an empty content view, `setDelegate:nil`, `removeWindowsItem:`, `orderOut:`, `close`; then the references that `hold` took itself are dropped. The empty shell (about 0.1 to 0.3 MB) may stay in the NSApp list until the app quits. A debug build also logs the read-only line `native window N: STILL ALIVE ... retain count n` (or `freed`); a release build logs the `closed` line per window and nothing else. `GET /native` `sweeps` is `{ swept, freed, alive }` (debug builds count `freed` / `alive`).

Probes (Mac session, release-profile build with the bridge, `E:\hey-mail\e2e-v107-wp4\mac-leak.mjs`, baseline after 2 warm-up cycles, values after 10 s idle):
- P-floor-count: `GET /native`: `nsapp.total`, `nsapp.visible`, `nsapp.titled`, `webviewWindows`, `footprintBytes`; the window-server count (on screen / all) from the kit; `pgrep -f com.apple.WebKit.WebContent | wc -l`.
- P-floor-log: `grep -c "closed" startup.log`, `ls ~/Library/Logs/DiagnosticReports | grep -i hey` (no new report).
- P-floor-trace (rounds of option C, one per round): `leaks --traceTree <pid>` of one leaked shell before and after the round's change.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-35.38 | Mac | AC-4.1.2 compose, 20 cycles (Shift+C, visible, Cmd+W) | P-floor-count | no crash; label leaves `/windows` within 3 s; WebContent and `webviewWindows` back to the baseline within 10 s; visible, titled-visible and on-screen windows back to the baseline; footprint <= 0.2 MB per cycle; `nsapp.total` <= +1 per cycle (record it) | OPEN |
| WK-35.39 | Mac | AC-4.1.3 reader, 20 cycles (Shift+Enter, `popout_close`) | P-floor-count | as above with footprint <= 0.5 MB per cycle | OPEN |
| WK-35.40 | Mac | AC-4.1.4 mixed close paths: Discard with text, Esc, red button, Cmd+W | P-floor-log | as above per kind; one `closed` line per window; no crash report | OPEN |
| WK-35.41 | Mac | AC-4.1.5 stress: 100 quick cycles, half closed before ready | P-floor-count | no crash, no blank window on screen, per-cycle limits hold | OPEN |
| WK-35.42 | Mac | AC-4.1.10 long run: 200 mixed cycles over >= 20 min, then 10 min idle | P-floor-count | no crash; a mail opens in the main window in <= 1 s; footprint growth <= 60 MB | OPEN |
| WK-35.43 | Mac | 30 minutes of normal mixed use (compose, reader, search, Settings, Scheduled, event, Cmd+Q with windows open) | P-floor-log | no crash report | OPEN |
| WK-35.44 | all | AC-4.1.11 static: `cargo test --lib leakfix`, `git grep` for the removed switches | - | tests pass, no match | PASS (Windows, fix31) |

Superseded by this section: WK-35.17, WK-35.18, WK-35.24 and WK-35.31 to WK-35.37 (their probes needed the release code or its switches).
Engine features relied on: `NSWindow` / `NSView` / `NSNotificationCenter` public API only (macOS 10.9 and later).

## 36. WP5 platform parity (coder, `feature/v107-wp5`): W5.10 macOS notification permission, W5.1 PDF viewer, W5.2 / W5.5 colour scheme, W5.3 Print, W5.4 / W5.6 Linux notifications and no-tray texts, W5.8 installer

Nothing here was run on a Mac or Linux. Windows (Chromium, dev preview with the mock backend): the test named in each part. Rows are appended per sub-package; the sub-package that is not listed yet has no visible change on WebKit.

### 36.A WP5d-mac (W5.10): the macOS notification note in Settings > Notifications & tray

Kit needs: a Mac session with the QA identity `thnonl.heylook.qa` started from the `.app` (`open -n`), notifications for it turned OFF in System Settings > Notifications (or "Don't Allow" answered once); the debug bridge (`/eval` in the `settings-<n>` window if Settings is open in its own window, else `main`). To see the note without touching System Settings on a build of this SHA: start it with `HEYLOOK_TEST_NOTIFY_PERMISSION=denied`.

Visible change: under the "Test notification / Send test" row of Settings > Notifications & tray (macOS only, and only while notifications are denied) a muted paragraph (`settings.tray.macDenied`, 2 to 4 lines at 960 x 560 in de / ru) and a secondary button `settings.tray.macOpenSettings`, in a column (`.mac-notify-denied`: `display:flex; flex-direction:column; align-items:flex-start; gap:8px; padding:10px 0 14px; border-bottom:1px solid var(--border)`).

Probe P-macnote (in the window that shows Settings): `const n=document.querySelector('.mac-notify-denied');if(!n)return JSON.stringify(null);const t=n.querySelector('.muted'),b=n.querySelector('button'),body=document.querySelector('.settings-body').getBoundingClientRect(),r=n.getBoundingClientRect(),br=b.getBoundingClientRect(),cs=getComputedStyle(t);return JSON.stringify({text:t.textContent.trim(),button:b.textContent.trim(),font:cs.fontFamily,size:cs.fontSize,lines:Math.round(t.getBoundingClientRect().height/parseFloat(cs.lineHeight)),inside:r.left>=body.left-1&&r.right<=body.right+1&&br.right<=body.right+1,clipped:b.scrollWidth>b.clientWidth+1||t.scrollWidth>t.clientWidth+1,h:Math.round(r.height),btnH:Math.round(br.height),tabOrder:!!(t.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING),dir:cs.direction})`

PASS (numbers): `inside` true, `clipped` false, `h` < 220 (at 960 x 560 in the longest language, ru and de), `btnH` between 28 and 40, `lines` <= 5, `font` is the system family (record it: San Francisco / `-apple-system` on the Mac, in ja the Hiragino family), `text` and `button` are the agreed texts (de: „Mitteilungen“ as the macOS pane name; ja: 「通知」: compare with the real System Settings window, AC-5.10.7), no text starts with `settings.`. Light and dark: the note's colour is `var(--muted)`, the button the normal `.btn` look.

Engine features relied on: `flex-direction: column` + `align-items: flex-start` + `gap` (flex gap needs WebKit 14.1 / macOS 11.3+ and WebKitGTK 2.30+; the layout is still a readable column where gap is missing because the paragraph has its own line height); `overflow-wrap: anywhere` (Safari 15.4+; an older engine breaks at spaces only, which still fits the text because the column is the width of the settings body); `window` `focus` event for the re-read (fires in WKWebView when the app is brought back to the front).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-36.01 | Mac | the note + button in Settings > Notifications & tray with the permission denied: 960 x 560 and 1280 x 800, light and dark, de and ja (and ru for the longest text), font family recorded | P-macnote | as above | OPEN |
| WK-36.02 | Mac | the focus re-read: turn notifications on in System Settings, click back into the app, the note disappears without a restart (AC-5.10.3) | P-macnote returns null | the note is gone within 1 s of the window coming forward | OPEN |

## Fix22 (coder, `feature/v107-fix22`): D-090 mini toolbar under a word of the first line, D-091 first quote after focus

Nothing here was run on a Mac or Linux (Windows: `scripts/test-painter-mini.mjs`, `scripts/test-popover-room.mjs`, `scripts/test-autoformat.mjs`, `scripts/test-autoformat-ui.mjs`).

D-090: `placePopover` got `roof` (the least y a popover may reach on its way up); `useMiniShow.ts` sets it to the bottom of the formatting toolbar (`.fmt-tb`) of the editor when that is above the selection, else the top of the scroll area. A word whose top is less than 8 + 36 + 8 px under the roof gets the mini toolbar BELOW it (8 px gap), later lines keep it above.

Probe P-mini1 (run in the window with the compose, after a real double click on the first word of the body): `(()=>{const m=document.querySelector('.mini-tb'),b=document.querySelector('.fmt-tb');if(!m||!b)return JSON.stringify(null);const s=getSelection().getRangeAt(0).getBoundingClientRect(),r=m.getBoundingClientRect(),f=b.getBoundingClientRect();return JSON.stringify({miniTop:r.top,miniBottom:r.bottom,barBottom:f.bottom,selTop:s.top,selBottom:s.bottom,overlapBar:!(r.right<=f.left||r.left>=f.right||r.bottom<=f.top||r.top>=f.bottom),gapBelow:r.top-s.bottom,h:r.height})})()`

PASS (numbers): `overlapBar` false; for a word in the first line `gapBelow` between 7 and 9 and `miniTop` >= `selBottom`; for a word of the fourth line the toolbar is above (`miniBottom` <= `selTop` - 7) and `overlapBar` false; `h` between 30 and 46.

Engine features relied on: `getBoundingClientRect`, `position: fixed` (unchanged).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-F22.01 | Mac, Linux | double click on the first word of the body, inline compose and compose window, 960 x 560 and 1280 x 800 (the report D-090: Mac mini [30,317,253,357] vs bar [62,316,960,355]) | P-mini1 | `overlapBar` false, `gapBelow` 7 to 9 | OPEN |
| WK-F22.02 | Mac, Linux | the same on a word of the third or fourth line: above, as before | P-mini1 | `miniBottom` <= `selTop` - 7, `overlapBar` false | OPEN |

D-091 (no visible change): the opening / closing decision ignores invisible format characters before the caret (`autoFormat.ts` `lastChar`). Mac check WK-F22.03: focus the body, type `"Hello"` as the very first keys (also with the Vietnamese Telex input source active), 5 times in a row after a click into the body: the paragraph reads `“Hello”` each time (probe: `document.querySelector('.cp-editor .tiptap').editor.state.doc.textContent`). If H”ello” ever shows again, note the input source and whether the first key arrived through `compositionstart/end`: the cause is then the order of events, not the quote rule.

### 36.B WP5a (W5.1): the PDF viewer of the attachment preview on macOS and Linux (PDF.js)

Not built: the native variants E1 / E2 of the experiment (`hlpdf://` frame / embed) and their Mac round; PDF.js is the guaranteed path and wins every tie of the choice rule (spec W5.1, "Choice rule"). The native round can still be added on request (about half a day: a scheme handler, the per-run policy `frame-src` / `object-src` `hlpdf:`, navguard).
Kit: `E:\hey-mail\e2e-v107-wp5\pdf\` (`make-samples.mjs` writes S1 to S5 and S7 to S10 into `samples\`; S6 needs real JPEG 2000 / JBIG2 files; `append-mail.mjs <host> <port> <user> <password>` APPENDs one mail with all of them, S1, S10 and a PNG first, to a stub mailbox). A debug build for the Mac / Linux session: `HEYLOOK_TEST_BRIDGE=0`; the debug seams: `HEYLOOK_TEST_PDF_VIEW=card|pdfjs|pdfjs-broken|frame` (AC-5.1.13 is `pdfjs-broken`).

Visible changes, what to look at:
1. **The pages** (`.pv-pdfjs` in `.pv-stage.pdfjs`): white sheets (`.pv-page`, 16 px apart, `box-shadow: var(--shadow)`) on `var(--bg3)`, centred, 48 px of room left and right, Fit = stage width minus 96 px, 100 % = 96 / 72 css px per PDF point; a canvas per page near the view (the visible ones and one more each side; the others are freed); a text layer over each canvas (`.pv-text-layer`, transparent text, selectable).
2. **The header**: name (ellipsis first), "i of n" (attachments, existing), the page number `Page 3 of 30` (`.pv-page-no`), zoom out / Fit or "150%" / zoom in, Open, Save as, close; one line at 960 x 560 in all 8 languages.
3. **The states** (`.pv-pdfjs-msg`): spinner "Loading…" until page 1 is drawn; "protected by a password" (locked); "could not be drawn" with Open (damaged, or page 1 not drawn in 10 s); the card (engine or worker cannot be loaded); "not a valid PDF" for a file called .pdf.
4. **Keyboard**: the stage takes the focus once the first page is drawn (`document.activeElement.className` = `pv-pdfjs`); PageDown / PageUp / Home / End / arrows scroll; Left / Right and Esc keep the dialog's meaning; Shift+Tab goes to the header.

Probes (DOM; `/eval` in the window that shows the preview; all print JSON):
- P-pdf-state: `const s=document.querySelector('.pv-pdfjs');return JSON.stringify({state:s?.dataset.state,worker:s?.dataset.worker,page:s?.dataset.page,pages:document.querySelectorAll('.pv-page').length,canvases:document.querySelectorAll('.pv-page canvas').length,text:document.querySelectorAll('.pv-text-layer span').length,head:document.querySelector('.pv-head')?.innerText.replace(/\s+/g,' '),active:document.activeElement.className,links:document.querySelectorAll('.pv-stage a,.pv-stage [href]').length,frames:document.querySelectorAll('.pv-stage iframe,.pv-stage object,.pv-stage embed').length})`
- P-pdf-pixels (page 1): `const c=document.querySelector('.pv-page canvas');const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let k=0;k<d.length;k+=4)if(d[k]<250||d[k+1]<250||d[k+2]<250)n++;const r=c.getBoundingClientRect();return JSON.stringify({w:c.width,h:c.height,cssW:r.width,cssH:r.height,dpr:devicePixelRatio,nonWhite:n,sharp:Math.abs(c.width-r.width*devicePixelRatio)<2.5})`
- P-pdf-head (960 x 560, every language): `const head=document.querySelector('.pv-head'),hr=head.getBoundingClientRect();const kids=[...head.querySelectorAll(':scope > *, .pv-pdf-tools > *')].filter(k=>k.getClientRects().length);const rects=kids.map(k=>k.getBoundingClientRect());return JSON.stringify({h:Math.round(hr.height),lines:new Set(rects.map(x=>Math.round((x.top+x.bottom)/12))).size,inside:rects.every(x=>x.left>=hr.left-1&&x.right<=hr.right+1),clipped:kids.filter(k=>!k.classList.contains('pv-name')&&k.scrollWidth>k.clientWidth+1).length,page:document.querySelector('.pv-page-no')?.textContent,font:getComputedStyle(head).fontFamily})`
- P-pdf-csp: `window.__csp` after installing `document.addEventListener('securitypolicyviolation',e=>(window.__csp??=[]).push(e.effectiveDirective+' '+e.blockedURI))` BEFORE opening the preview; plus `/console`.
- P-pdf-leak: `GET /native` `footprintBytes` (Mac) after cycle 1 and after cycle 10 of S2 (open, scroll to the end, Esc); WebContent count `pgrep -f com.apple.WebKit.WebContent | wc -l`; on Linux `smem -P hey-look` or the PSS sum of the app and WebKitWebProcess.

PASS (numbers): S1: `state` ready within 3 s of the double click (S8 within 6 s), `head` "agenda... Page 1 of 1 Fit Open Save as…", `nonWhite` > 3000, `links` 0, `frames` 0, `worker` "module" (record it: "fake" means WKWebView / WebKitGTK refused the module worker and the PDF is drawn on the page thread: slower, still correct), `__csp` []; S2: `Page n of 30` follows the scroll within 300 ms, `canvases` <= 7, `sharp` true at Fit / 100 / 150 / 200 % on a Retina or scaled display (`dpr` 2); S3: the CJK glyphs drawn (`nonWhite` > 6000 and the text layer holds the characters; no empty boxes); S4 locked message in 8 languages and Open opens Preview.app / the default viewer; S5 "could not be drawn" + Open; S7 the not-a-PDF message; S9 no dialog, no navigation; S10 each page at its own size; P-pdf-head: `lines` 1, `inside` true, `clipped` 0, `h` < 56 in 8 languages (record `font`); P-pdf-leak: the footprint after cycle 10 within +30 MB of cycle 1 (AC-5.1.11); `sweeps` as in 35.B are unaffected.
Engine features relied on: module workers (`new Worker(url, { type: "module" })`, Safari 15 / macOS 12 and later WKWebView, WebKitGTK 2.38+; older: pdf.js falls back to running the worker code on the page thread, `worker` "fake", and if that fails too the card is shown), dynamic `import()` of a module from `tauri://localhost/` inside the worker (the JPEG 2000 / JBIG2 decoders), `Canvas 2D` up to 16.7 M pixels per canvas (`MAX_CANVAS_PIXELS`), `FontFace` from memory (fonts embedded in the PDF), `ResizeObserver`, `requestAnimationFrame`, `display: contents` (the header slot), CSS custom properties in `calc()` and `font-size: calc(var(--text-scale-factor) * var(--font-height))` (the text layer), `::selection` colours, `-webkit-user-select`, `overflow: auto` scroll anchoring is NOT relied on (the layout is arithmetic). WebAssembly is NOT used (`useWasm: false`; the shipped policy has no 'wasm-unsafe-eval'): the JavaScript decoders of JPEG 2000 and JBIG2 are shipped instead. XHR to a custom scheme (`tauri://`): pdf.js reads cMaps and fonts on the page thread (`useWorkerFetch: false`), a CMYK colour profile with a synchronous request inside the worker (a refusal there only costs the colour conversion).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-36.03 | Mac, Linux | S1 by double click and by the menu's Preview: drawn, header, no link, no frame; S1's http and mailto link clicked: nothing opens (AC-5.1.1, 5.1.3) | P-pdf-state, P-pdf-pixels | as above; no new window, the pointer is not a hand over text | OPEN |
| WK-36.04 | Mac, Linux | S2 scrolled, Fit / 100 / 150 / 200 %, a window resize in Fit, Retina and a 1x display (AC-5.1.2) | P-pdf-state, P-pdf-pixels | `sharp` true, canvases <= 7, re-fit within 400 ms | OPEN |
| WK-36.05 | Mac, Linux | S3 (CJK without embedded fonts), S6 (JPEG 2000, JBIG2: needs real files), S9, S10 (AC-5.1.4) | P-pdf-pixels, `/console` | glyphs and images drawn; no dialog | OPEN |
| WK-36.06 | Mac, Linux | S4, S5, S7 in the 8 languages at 960 x 560 and 1280 x 800, Light and Dark (AC-5.1.5, 5.1.6, 5.1.9) | P-pdf-head, screenshots | texts as agreed, `lines` 1 | OPEN |
| WK-36.07 | Mac, Linux | the keyboard: Tab into the pages, PageDown / Home / End, Left / Right between 2 PDFs and a PNG, Esc, focus back on the card (AC-5.1.7) | P-pdf-state | `active` "pv-pdfjs" after open; the card has the focus after Esc | OPEN |
| WK-36.08 | Mac (VoiceOver), Linux (Orca) | "Page 1 of 1" and the text of S1 are read (AC-5.1.8; Orca NOT RUN when not installed) | by ear | both read | OPEN |
| WK-36.09 | Mac, Linux | the policy: no violation while S1 to S10 are opened (AC-5.1.10); `worker` kind recorded | P-pdf-csp | `__csp` [] and no "Refused" line | OPEN |
| WK-36.10 | Mac, Linux | 10 open / close cycles of S2 (AC-5.1.11) | P-pdf-leak | within +30 MB of cycle 1 | OPEN |
| WK-36.11 | Mac, Linux (debug) | `HEYLOOK_TEST_PDF_VIEW=pdfjs-broken`: the card with Open / Save as, never a blank stage (AC-5.1.13) | P-pdf-state | `.pv-card` present, no `.pv-pdfjs` visible | OPEN |

### 36.C WP5b (W5.5): a newsletter's `prefers-color-scheme` follows the message background

Kit needs: kit mail N1 (spec W5.5): a white body with the rules `@media (prefers-color-scheme: dark){body{background:#000;color:#eee}.ld{display:block}.ll{display:none}}`, a light / dark logo pair switched by `display`, a `<picture><source media="(prefers-color-scheme: dark)" srcset="<address>">` and a compound block `@media screen and (prefers-color-scheme: dark) and (max-width: 600px)`. Note for the kit: the sanitizer drops a `<style>` that is the FIRST thing of the body (the parser moves it to the head, as for every mail) and a `srcset` that is a data: address; put the `<style>` after a first element and give the dark source an https or relative address.
Visible change: none by itself; the colours of such a mail follow the message-background button (Original / Dark), not the OS.
Probe P-cs (in `main` or the reader window with the mail open): `const f=document.querySelector('.msg-frame'),d=f.contentDocument,v=s=>{const e=d.querySelector(s);return e?getComputedStyle(e).display:null};return JSON.stringify({canvas:window.__store?.getState().prefs.mailCanvas,bg:getComputedStyle(d.body).backgroundColor,ll:v('.ll'),ld:v('.ld'),orig:d.querySelectorAll('[data-hm-orig],[data-hm-orig-media]').length,pic:d.querySelector('picture img')?.currentSrc.slice(-30),media:[...d.querySelectorAll('source[media],style[media]')].map(e=>e.getAttribute('media')),dpr:devicePixelRatio})`. (`window.__store` exists in debug builds only; otherwise read the button's `aria-pressed`.)
PASS: with the Original background: `ll` "block", `ld` "none", `media` all `(min-width:0px)` / `(max-width:0px)` (no `prefers-color-scheme` text left), `pic` the img's own source, on a dark OS (System dark) and a light OS, in a Light and a Dark app theme; with the Dark background: `ld` "block", `ll` "none", `pic` ends with the dark source, body dark (luminance < 90); a switch in either direction keeps the frame (`contentWindow.__marker` set before survives), the pane's scroll position, and rewrites within 200 ms.
Engine features relied on: a change of the `media` attribute of a `<source>` makes the `<picture>` choose its image again (HTML spec; Safari and WebKitGTK: check); changing the text of a `<style>` element re-evaluates its rules (DOM mutation of `textContent`); `(min-width:0px)` / `(max-width:0px)` as media features inside `and` / `not` / comma lists; `beforeprint` / `afterprint` events on the frame's window (print on macOS is W5.3's own document, Windows and Linux print the frame).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-36.12 | Mac, Linux | N1 on a dark OS with the app Light and Original; on a light OS with the app Dark and Original; with the Dark background on either OS (AC-5.5.1) | P-cs | as above | OPEN |
| WK-36.13 | Mac, Linux | the switch in place: the `<picture>` chooses its source again, the scroll position stays, no reload (AC-5.5.1) | P-cs before / after | `pic` changes, marker survives | OPEN |
| WK-36.14 | Linux | print with the Dark background gives a light page (AC-5.5.2) | print preview | light | OPEN |

### 36.D WP5b (W5.2): Linux follows the desktop's colour scheme

Nothing here was run on Linux. The Linux code (`linuxtheme.rs`: zbus 5 blocking, `ReadOne` / `Read`, `SettingChanged`) was type-checked in a scratch crate for `x86_64-unknown-linux-gnu` (`cargo check`, the real file, stand-ins for tauri / startup / wintheme). Windows: `scripts/test-os-theme.mjs`, `test-os-theme-ui.mjs` (the dev preview plays the backend), `cargo test --lib` (`the_portal_value_and_the_gtk_settings_give_the_os_scheme`, `on_linux_a_system_theme_pins_the_resolved_os_theme`).
Diagnosis rows of the spec (D1 to D4) are unchanged and still worth running once with this build: the `[ostheme]` lines of startup.log say which source answered and what the portal said.
Visible change: with the theme System on Linux, the app, every open window, GTK's own parts (header bar of GNOME, scroll bars, `<select>` popups, file dialogs) show what the desktop shows, within 2 s of a switch; the first window is made dark under a dark desktop.
Probe P-ostheme (in any window, through the bridge `/eval`): `const r=document.documentElement;return JSON.stringify({dataTheme:r.getAttribute('data-theme'),bg:getComputedStyle(r).getPropertyValue('--bg').trim(),engineDark:matchMedia('(prefers-color-scheme: dark)').matches,bodyBg:getComputedStyle(document.body).backgroundColor,colorScheme:getComputedStyle(r).colorScheme,boot:localStorage.getItem('heylook.boot')})`.
PASS: with System and a dark desktop: `dataTheme` "dark", `bg` "#1b1c20", `bodyBg` dark, whatever `engineDark` says (record it: it is D3); after the desktop goes light: `dataTheme` "light" and `bg` "#ffffff" within 2 s, in the main, a compose and a reader window; `boot` has `"os":"dark"` / `"light"` for System. With Light or Dark chosen: `dataTheme` as chosen through every desktop switch. startup.log has `[ostheme] dark (portal color-scheme 1)` at start and at each switch; `[wintheme] ... applied to N windows` follows; a first window under a dark desktop is dark at its first paint (a light flash under 0.5 s is accepted and noted). `GTK_THEME=Adwaita:dark` without a portal: `[ostheme] dark (GTK_THEME ends in :dark; ...no live change in this mode)`.
Engine features relied on: `:root[data-theme="dark"]` custom properties (no engine feature); WebKitGTK's `prefers-color-scheme` is NOT relied on any more on Linux (the page writes `data-theme` itself); GTK `gtk-application-prefer-dark-theme` set through the window's theme (tao) for the native parts; `localStorage` for the start screen.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-36.15 | Linux (KDE) | start under Breeze and under Breeze Dark; five switches in System Settings > Colours: main, an open compose and a reader window, GTK parts (AC-5.2.1, 5.2.2) | P-ostheme + log timestamps | as above, <= 2 s | OPEN |
| WK-36.16 | Linux | Light / Dark chosen while the desktop is the other: stays; back to System follows at once (AC-5.2.3) | P-ostheme | as chosen / as the desktop | OPEN |
| WK-36.17 | Linux | no portal (`systemctl --user stop xdg-desktop-portal`, or a `dbus-run-session`): `GTK_THEME=Adwaita:dark` dark, `gtk-application-prefer-dark-theme=1` dark, neither light; the log names the source (AC-5.2.4); restore the portal | log + P-ostheme | as above | OPEN |
| WK-36.18 | Linux | the native `<select>` popup (Settings > Default account) and the scroll bars under a dark desktop (AC-5.2.5) | look | dark | OPEN |
| WK-36.19 | Mac, Windows | System follows an OS switch within 2 s, Light / Dark as before, no `data-theme` set for System (AC-5.2.7) | P-ostheme | `dataTheme` null for System | OPEN |

### 36.E WP5c (W5.3): Print on macOS

Nothing here ran on a Mac. The Rust (`macprint.rs`: a WKWebView in no window, JavaScript off, `loadHTMLString:baseURL:nil`, `printOperationWithPrintInfo:`, `runOperationModalForWindow:`) was type-checked in the scratch crate for `aarch64-apple-darwin` against objc2-web-kit 0.3.2 / objc2-app-kit 0.3.2 (the versions wry uses), the rules (when the load is done, when the sheet is over) are tested on every system.
Visible change: macOS shows Print in the More menu of a message (main window and reader window) and Cmd+P prints in a reader window. The system print sheet opens on the window that asked; its preview shows only the message (light, no app UI); PDF > Save as PDF keeps the text. Confidential mail: Print greyed out, Cmd+P does nothing.
Engine features relied on: `WKWebView.printOperationWithPrintInfo:` (macOS 11+; the code answers an error toast on a system without it, the operation is not created), `WKWebpagePreferences.allowsContentJavaScript`, `NSPrintOperation.runOperationModalForWindow:` (a sheet), CSS `break-inside: avoid` for images, rows and quotes in the printed page.
Kit: mail N2 (about 6 printed pages), the one-page mail, a mail with a blocked remote picture from the kit's local HTTP server (count its requests), N1 (dark rules). Debug build with the bridge for the seam `HEYLOOK_TEST_PRINT_FAIL=1` (debug builds only).
Probes: P-print-log (startup.log, tag `[print`): `print sheet requested <ms> ms after the request` then `print over (sheet was shown true), the print view is released`; failure lines `print failed after <ms> ms: <why>`. P-print-win (`GET /native` before and after 5 prints): `nsapp.total` equal; `pgrep -f com.apple.WebKit.WebContent | wc -l` back to the baseline within 60 s. P-print-pages: `mdimport <saved.pdf>; mdls -name kMDItemNumberOfPages <saved.pdf>`. P-print-req: the kit's HTTP server log shows 0 requests while printing a mail whose remote picture is blocked.
PASS (numbers): the sheet within 2 s of the click for a one-page mail (`print sheet requested` < 2000 ms); N2 gives >= 6 pages in the sheet and in the saved PDF and no line cut at a page end; `nsapp.total` +0 after 5 prints; WebContent count back to the baseline within 60 s; 0 requests to the blocked picture's server; with the Dark message background the print is light (white page, dark text); a second press while the sheet is open logs `a print is under way: the request is ignored` and opens nothing; the forced failure (`HEYLOOK_TEST_PRINT_FAIL=1`) shows the toast "Couldn’t print this message." in the calling window (read it in all 8 languages).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-36.20 | Mac | one-page mail, More > Print: the sheet on the main window, preview shows the mail only; Save as PDF (AC-5.3.1) | P-print-log | sheet < 2000 ms; PDF has the text, no app UI | OPEN |
| WK-36.21 | Mac | N2, about 6 printed pages (AC-5.3.2) | P-print-pages | >= 6 pages, no cut line | OPEN |
| WK-36.22 | Mac | blocked pictures print as placeholders, after "Show pictures" they print; the blocked remote picture makes no request (AC-5.3.3, 5.3.8) | P-print-req | placeholders; 0 requests | OPEN |
| WK-36.23 | Mac | Dark message background on: the print is light (AC-5.3.4, AC-5.5.2 Mac) | print preview | light | OPEN |
| WK-36.24 | Mac | reader window: Cmd+P and More > Print open the sheet on the reader window; Cancel leaves it usable; the main window stays usable behind (AC-5.3.5) | look | sheet on the reader | OPEN |
| WK-36.25 | Mac | confidential mail: Print greyed out, Cmd+P nothing (AC-5.3.6) | look | disabled | OPEN |
| WK-36.26 | Mac | 5 prints in a row (AC-5.3.7) | P-print-win | `nsapp.total` +0, WebContent back in 60 s | OPEN |
| WK-36.27 | Mac | forced failure, 8 languages (AC-5.3.9) | `HEYLOOK_TEST_PRINT_FAIL=1` | toast text, no sheet, a second print works | OPEN |
| WK-36.28 | Windows, Linux | Print still opens the system / GTK print dialog with the message (AC-5.3.10) | look | dialog with the mail | OPEN |

### 36.F WP5d (W5.4, W5.6) and WP5c (W5.7, W5.9): Linux notification buttons, no-tray texts, signals, the macOS app menu

Nothing here ran on Linux or a Mac. The Linux Rust (`linuxnotify.rs`: zbus 5 blocking, `GetCapabilities`, `NameHasOwner`, `ListActivatableNames`, `receive_all_signals` for `ActionInvoked` / `NotificationClosed`; notify-rust 4.18 `action`, `Hint::Category`, `Hint::DesktopEntry`, `show().id()`) was type-checked in a scratch crate for `x86_64-unknown-linux-gnu` (the notify-rust calls verbatim, the module itself); the signal handlers of W5.9 and the rest of `shell.rs` compile only on Linux CI. The rules are tested on every system.
Visible changes: (1) Linux, W5.4: a new-mail notification has the buttons of Settings > Mailboxes > Notifications > Buttons (default Archive, Delete, Mark as read) when the service lists `actions`; a click on the body opens the conversation in the main window (also from the tray); the summary (more than 3 mails) and the test notification have no buttons, their body click shows the main window; hints `category email.arrived`, `desktop-entry hey-look`. Without `actions`, Settings shows the note `settings.notify.noButtonsDesktop` and sends no actions. (2) Linux without a tray host, W5.6: five texts (Welcome bullet, quit question button "Keep Hey Look! open", Send later picker without the tray link, Settings > Filters intro, Settings tab "Notifications & startup"). The macOS Welcome says "menu bar". Send test answers at once when no notification service exists and none can be started. (3) W5.9 Linux: SIGTERM / SIGHUP / SIGINT leave by the exit path without questions; a second signal ends the process. (4) W5.7 macOS: the app menu plan keeps Show All (unit-tested; no UI change).
Probes: P-nact (Linux, through a notification monitor: `dbus-monitor "interface='org.freedesktop.Notifications'"` while a new mail arrives): the `Notify` call's actions array `default, Open Hey Look!, archive, Archive, delete, Delete, read, Mark as read` (labels in the app language) and the hints. P-nthreads: `ls /proc/<pid>/task | wc -l` before and after 50 notifications. P-notray (`/eval` in the main window): `document.body.innerText` on Welcome / the quit question / the Send later picker / Settings > Filters / the Settings tab contains no "tray" (en) and no "Infobereich" (de), except the disabled keep-running row and its hint. P-sig: `kill -TERM <pid>` with a scheduled message waiting and a queued archive: startup.log has `quit: signal SIGTERM: leaving without questions`, `exit: done, the process ends` within 5 s; a second `kill -TERM` within the first 2 s logs `ending the process now`.
PASS (numbers): AC-5.4.1 hidden window, new mail: 3 buttons in en then in de; Archive puts the mail in Archive on the stub and updates the badge, no window opens; AC-5.4.2 a body click shows the conversation; AC-5.4.3 buttons Flag / Snooze / Reply do their job (Snooze until the "tomorrow" time, Reply opens the main window with a reply); AC-5.4.4 none, none, none: no buttons and the body click works; AC-5.4.6 thread count within +-2 after 50 notifications; AC-5.6.1 the 4 screens contain no "tray" / "Infobereich"; AC-5.6.4 in a `dbus-run-session` without a notification service Send test fails with "No notification service is running..." within 1 s (if the bus can start a service that fails: within 6 s with the button busy); AC-5.6.5 the nav entry "Benachrichtigungen & Autostart" is not clipped at 960 x 560 (the dev-preview test measured it on Windows fonts: record `clipped` false and the font on Linux); AC-5.9: the P-sig lines on Linux, 1 Mac row for Cmd+Q / Dock Quit / log out ending by the same road.
Engine features relied on: D-Bus (`org.freedesktop.Notifications` 1.2: `actions` capability, `ActionInvoked`, `NotificationClosed`); GLib `unix_signal_add_local` for the signals.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-36.29 | Linux (KDE VM) | AC-5.4.1 buttons in en and de, Archive works while the window is hidden | P-nact | 3 buttons; mail in Archive; no window | OPEN |
| WK-36.30 | Linux | AC-5.4.2 / 5.4.3 / 5.4.4: body click, the other buttons, no buttons | P-nact | as listed | OPEN |
| WK-36.31 | Linux | AC-5.4.5 `HEYLOOK_TEST_NOTIFY_NO_ACTIONS=1` (debug build): the note in 8 languages, no actions sent | P-nact | note shown, `Notify` actions empty | OPEN |
| WK-36.32 | Linux | AC-5.4.6 50 notifications | P-nthreads | thread count +-2 | OPEN |
| WK-36.33 | Linux (GNOME if available) | AC-5.4.7 | P-nact | as WK-36.29 | NOT RUN unless GNOME |
| WK-36.34 | Linux (KDE, System Tray widget removed) | AC-5.6.1 the four screens, restart first | P-notray | no "tray" / "Infobereich" except the disabled row | OPEN |
| WK-36.35 | Mac | AC-5.6.3 the Welcome bullet in 8 languages (fresh data folder) | look | "menu bar" text | OPEN |
| WK-36.36 | Linux | AC-5.6.4 Send test without a service | P-notray | error within 1 s | OPEN |
| WK-36.37 | Linux | AC-5.6.5 nav entry at 960 x 560 in de | P-nav-clip | not clipped | OPEN |
| WK-36.38 | Linux | AC-5.9 SIGTERM / SIGHUP / SIGINT | P-sig | log lines; exit within 5 s | OPEN |
| WK-36.39 | Mac | AC-5.7 / 5.9 Show All in the app menu; Cmd+Q, Dock Quit, log out end by the same exit road | look + startup.log | Show All present; same `exit:` lines | OPEN |

## 37. WP6 mail core and data safety (coder, `feature/v107-wp6`): W6.7 Search on the server, W6.2 filter option text, W6.6 / W6.3 Settings hints, W6.14 link warning, W6.8 saved folder name, W6.13 previews, W6.15 / W6.16 native

Nothing here was run on a Mac or Linux. Windows (Chromium, dev preview with the mock backend `#serversearch`): `scripts/test-server-search-ui.mjs`, `scripts/test-link-check.mjs`, `scripts/test-folder-name.mjs`, `scripts/test-junk-folder.mjs`, `scripts/test-list-limit-footer.mjs`. The rows below are the visible changes and the engine features the code relies on.

Engine features relied on (macOS 11+ WKWebView, WebKitGTK 2.40+):
- `new URL(...).hostname` converts an international host name to its `xn--` form (WHATWG URL / IDNA). `src/linkCheck.ts` reads the label from it; if an engine hands back the Unicode form instead, the check still works on the Unicode label (and the dialog then names the Unicode host). Probe P-idna below.
- Unicode property escapes in regular expressions: `\p{L}`, `\p{N}`, `\p{Script=Latin}`, `\p{Script=Cyrillic}`, `\p{Script=Greek}` with the `u` flag (WebKit 11.1+, macOS 10.13+; WebKitGTK 2.20+).
- `overflow-wrap: anywhere` with the older `word-break: break-word` written before it as the fallback (`overflow-wrap: anywhere` is WebKit 15.4+; macOS 11 and 12.0 to 12.2 WebViews may lack it). Used by `.ml-srv-err` and `.ask p`.
- Flex layout with `gap` (`.ml-srv`: WebKit 14.1 / macOS 11.3+, WebKitGTK 2.30+; where `gap` is missing the children sit 0 px apart but each has its own padding, so the layout stays readable), `position: sticky` is NOT used. No `:has()`, no `clamp()`, no `dvh`, no `color-mix`, no `inert` in this section.

### 37.A W6.7 "Search on the server" below the results (`.ml-srv`, `src/components/ServerSearch.tsx`)

Kit needs: a Mac session / Linux VM with a QA stub mailbox (`E:\hey-mail\e2e-v107-wp6\`, switch `/cfg` `serversearch`), more mail on the stub than downloaded (limit 50), a search (Ctrl+F) for a word that is on the server only.

Visible: in the footer of the message list, a small button (idle), a spinner line with Cancel (running), then a heading "On the server" with rows that look and behave like list rows, a note when more than 200 were found (`capped`), "Nothing more found" (`none`), the per-mailbox error line (`failed`, long server text), and the "Pinned and snoozed" note (`localOnly`).

Probe P-srv (main window, the bridge `eval`): `(()=>{const q=document.querySelector('.ml-srv');if(!q)return JSON.stringify(null);const b=q.querySelector('button'),r=q.getBoundingClientRect(),rows=[...q.querySelectorAll('.ml-row')],loc=[...document.querySelectorAll('.ml-row')].find(x=>!x.closest('.ml-srv')),h=x=>x?Math.round(x.getBoundingClientRect().height*10)/10:null,e=q.querySelector('.ml-srv-err');return JSON.stringify({state:q.dataset.serverSearch,w:Math.round(r.width),h:Math.round(r.height),overflowX:q.scrollWidth>q.clientWidth+1,btnH:h(b),btnLines:b?Math.round(b.getBoundingClientRect().height/parseFloat(getComputedStyle(b).lineHeight||'16')):null,rows:rows.length,rowH:rows.slice(0,3).map(h),localRowH:h(loc),errOverflow:e?e.scrollWidth>e.clientWidth+1:null,spin:(()=>{const s=q.querySelector('.spin');return s?getComputedStyle(s).animationName:null})(),font:getComputedStyle(q).fontFamily})})()`

PASS (numbers): `overflowX` false in every state; `btnH` between 24 and 36 and `btnLines` <= 2; when running, `spin` is not `none` and `h` differs from the idle `h` by at most 6 (no jump of the list); `rowH` each within 1 of `localRowH`; `errOverflow` false for a 300-character error text with no spaces; at the narrowest list width (drag the splitter to the minimum, about 280 px) `w` equals the list width and `overflowX` false; texts in de, ja and ru (the longest `capped`, `localOnly`) wrap to at most 4 lines.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-37.01 | Mac, Linux | the idle button under the results of a search, 960 x 560 and 1280 x 800, light and dark, de / ja / ru; the tooltip (hint) on hover and the screen reader description | P-srv | `overflowX` false, `btnH` 24 to 36, `btnLines` <= 2 | OPEN |
| WK-37.02 | Mac, Linux | running: spinner turns, Cancel works with Enter and Space and mouse, the list does not jump | P-srv | `spin` not `none`, `abs(h - idleH)` <= 6 | OPEN |
| WK-37.03 | Mac, Linux | results: heading + rows, arrow keys move between the rows and back to the local ones, a click opens the message in the pane and a double click in a window | P-srv | `rowH` within 1 of `localRowH`; focus ring visible (record outline width >= 2) | OPEN |
| WK-37.04 | Mac, Linux | `capped`, `none`, `localOnly`, `failed` with a 300-character server text at 280 px list width, de and ru | P-srv | `overflowX` false, `errOverflow` false, <= 4 lines each | OPEN |

### 37.B W6.2 the filter option "Move to Junk (no Junk folder)" in Settings > Filters

Visible: the option text of the select for a mailbox without Junk (vi / es / fr / ru use the short "(no folder)" form; fr is the longest, 50 characters). The option is disabled for a new rule and stays selectable for a rule that already has it.

Probe P-junkopt (Settings window, the filter editor open on a mailbox without Junk): `(()=>{const s=[...document.querySelectorAll('select')].find(x=>[...x.options].some(o=>o.value==='junk'));if(!s)return JSON.stringify(null);const o=[...s.options].find(o=>o.value==='junk'),r=s.getBoundingClientRect(),p=s.closest('.settings-body,.modal-body')||document.body,pr=p.getBoundingClientRect();return JSON.stringify({text:o.textContent,disabled:o.disabled,selW:Math.round(r.width),inside:r.right<=pr.right+1&&r.left>=pr.left-1,textW:(()=>{const c=document.createElement('canvas').getContext('2d');c.font=getComputedStyle(s).font;return Math.round(c.measureText(o.textContent).width)})()})})()`

PASS (numbers): `inside` true at 960 x 560 and 1280 x 800; the closed select shows its text without clipping when the option is chosen (`textW` <= `selW` - 28, the arrow and padding), otherwise the open list (native menu) shows the whole text; record `textW` per language.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-37.05 | Mac, Linux | the select closed and open, fr / de / ja / ru / vi, 960 x 560 | P-junkopt | `inside` true, text complete when open, `disabled` true for a new rule | OPEN |

### 37.C W6.6 / W6.3 the longer hints in Settings > Reading (push hint, download limit hint)

Visible: `settings.reading.pushHint` and `settings.reading.maxDownloadHint` are longer than before (up to about 330 characters in ru / de / fr).

Probe P-hint: `(()=>{const out={};for(const k of ['pushHint','maxDownloadHint']){const h=[...document.querySelectorAll('.hint,.muted.small,.setting-hint')].find(x=>x.textContent.length>120&&(k==='pushHint'?/IDLE|push|Push/.test(x.textContent):/server|Server|Serveur|сервер|サーバー|máy chủ/.test(x.textContent)));if(h){const r=h.getBoundingClientRect(),lh=parseFloat(getComputedStyle(h).lineHeight)||16;out[k]={lines:Math.round(r.height/lh),clipped:h.scrollWidth>h.clientWidth+1||h.scrollHeight>h.clientHeight+1,w:Math.round(r.width)}}}return JSON.stringify(out)})()`

PASS (numbers): `clipped` false, `lines` <= 8 at 960 x 560 in ru and de, the hint stays inside the settings body (`w` <= body width).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-37.06 | Mac, Linux | the two hints, ru / de / fr / ja, light and dark, 960 x 560 and 1280 x 800 | P-hint | `clipped` false, `lines` <= 8 | OPEN |

### 37.D W6.14 the link warning (`src/linkCheck.ts`, two new bodies, `.ask p` wrapping)

Visible: the question "This link may not go where it says" with a new body for a look-alike address (names the `xn--` host) and for a link with a user name. The `.ask p` rule now breaks a long unbroken word (a 60-character `xn--` host) instead of overflowing the 440 px box.

Probe P-idna (any window, the bridge `eval`; the engine's own URL parser): `JSON.stringify({apple:new URL('https://\u0430pple.test/').hostname,ru:new URL('https://\u043f\u0440\u0438\u043c\u0435\u0440.\u0440\u0444/').hostname,user:(()=>{const u=new URL('https://bank.test@evil.test/');return [u.username,u.hostname]})(),props:(()=>{try{return /\p{Script=Cyrillic}/u.test('\u0430')&&/\p{Script=Greek}/u.test('\u03bf')&&/\p{L}/u.test('x')}catch(e){return String(e)}})()})`

PASS (numbers): `apple` = `xn--pple-43d.test`, `ru` = `xn--e1afmkfd.xn--p1ai`, `user` = `["bank.test","evil.test"]`, `props` true. If `apple` or `ru` come back in Unicode, record it (the check still warns; the dialog then shows the Unicode host).

Probe P-ask (while the question is open): `(()=>{const a=document.querySelector('.ask');if(!a)return JSON.stringify(null);const p=a.querySelector('p'),r=a.getBoundingClientRect();return JSON.stringify({w:Math.round(r.width),h:Math.round(r.height),overflowX:a.scrollWidth>a.clientWidth+1||p.scrollWidth>p.clientWidth+1,inView:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,lines:Math.round(p.getBoundingClientRect().height/(parseFloat(getComputedStyle(p).lineHeight)||20)),text:p.textContent})})()`

PASS (numbers): `overflowX` false, `inView` true at 960 x 560, `lines` <= 6, `w` <= 440 (or 92 vw); the `text` contains the host in its `xn--` form for the look-alike case and no other path or secret; Cancel opens nothing.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-37.07 | Mac, Linux | P-idna in the main window | P-idna | values as above | OPEN |
| WK-37.08 | Mac, Linux | kit mail with 10 links (spec AC-6.14.1), click each in the reading pane, then the same through the context menu "Open link" and in a reader window; the expected result per link is in the kit | P-ask | warnings exactly for links 3, 4, 5, 6; none for the others | OPEN |
| WK-37.09 | Mac, Linux | the look-alike and the hidden-user bodies in all 8 languages at 960 x 560, with a 60-character `xn--` host | P-ask | `overflowX` false, `inView` true, `lines` <= 6 | OPEN |

### 37.E W6.8 the saved folder name (button tooltip, toast, strip)

Visible change on Mac / Linux: POSIX paths. Set Settings > Reading > Download folder to `/Users/<you>/v107 saves` (Linux `/home/<you>/v107 saves`), save an attachment, then Save all.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-37.10 | Mac, Linux | the attachment button tooltip, the toast "Saved a.txt to ..." and the Save all strip with the folder above; the default folder (no setting) says "Downloads" | read the toast / strip text (`document.querySelector('.toast,.att-strip').textContent`) | the text contains `v107 saves` and not `/Users` or `/home`; default "Downloads" | OPEN |

### 37.F W6.13 previews (no visible layout change)

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-37.11 | Mac | a kit mail whose first line is "Xem thư này trên trình duyệt" in NFD (the macOS Mail / Telex way), the notification text and the list preview | `document.querySelector('.ml-row .preview').textContent` (the preview line must be on in Settings) and the notification | starts with the real content, not with the boilerplate; the real content keeps its diacritics (compare code points) | OPEN |

### 37.G W6.15 / W6.16 native (Mac, Linux; no layout change)

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-37.12 | Mac, Linux | open attachments named `install.command`, `x.AppImage`, `a.webloc` (Linux also `y.deb`, `a.bash`, `a.flatpakref`): the same "can run programs" question as `.exe` on Windows; Cancel opens nothing; with "warn before opening" off it opens | none (native dialog) | the question appears for each name; 0 files opened on Cancel | OPEN |
| WK-37.13 | Linux | files `KEY.ASC`, `key.asc`, `Key.Gpg` in a folder: Settings > Encryption (PGP) > Import > Choose file lists `KEY.ASC` and `key.asc` (`Key.Gpg` may need "All files": record it); Calendar > Import lists `INVITE.ICS` | none (GTK dialog) | `KEY.ASC`, `key.asc`, `INVITE.ICS` listed in the filtered view | OPEN |

#### 35.C fix35 (coder, `feature/v107-fix35`): the message frame is written, not navigated (D-103, Mac QA fix33: +38 MB of WebContent in 20 selections of the 2 MB mail in the MAIN window)

What changed: `ReadingPane.tsx` no longer gives the frame a `srcdoc` attribute. `src/mailFrame.ts` writes the document into the frame's own empty document (`document.open(); write(head); write(mail); write(tail); close()`), in three pieces so the one concatenated string of the mail is never made, before the first paint (a layout effect). One frame element per open mail (the pane is keyed by the conversation), removed with it. `window.__mailFrame` (all builds) reports `{created, removed, writes, fallbacks, live, historyLength, frameHistoryLength}`; read it through the bridge `/eval`. What Chromium shows too is pinned by `scripts/test-mail-frame-history.mjs` (20 selections: one iframe, `created - removed = 1`, `history.length`, the frame's `history.length` and the navigation entries constant, no `srcdoc` / `src` attribute). The engine-specific part, the memory of the WebContent process, is the Mac row below.

Engine features relied on: `document.open()` / `write()` / `close()` on a same-origin frame (`allow-same-origin` is in the sandbox on every engine; on WebKit the sandbox also has `allow-scripts`, as before) keeps the frame's `Document` object and replaces its root element (the code forgets what it knew about the old root: `hooked`, the dark sheet is keyed by the root); a written document inherits the page's Content-Security-Policy like a `srcdoc` one and carries its own `<meta http-equiv="Content-Security-Policy">`; `document.readyState` of a written document is `complete` as soon as it is parsed (Chromium; the pictures load afterwards and the code measures again on each picture's `load` / `error` and with a ResizeObserver, as it did). If a WebKit leaves `readyState` at `loading` for a while, the watcher polls every 15 ms for 10 s before it hooks the document (as before).

Probe P-mailframe (main window, the bridge `/eval`): `JSON.stringify({ mail: window.__mailFrame, frames: document.querySelectorAll('iframe').length, attrs: (() => { const f = document.querySelector('.msg-frame'); return f ? [f.hasAttribute('srcdoc'), f.hasAttribute('src')] : null; })(), rs: document.querySelector('.msg-frame')?.contentDocument?.readyState })`

Memory reading (Mac): `footprint <pid of the main page's com.apple.WebKit.WebContent>` (or Activity Monitor "Real Memory" is not enough; use `vmmap -summary <pid> | grep "Physical footprint"`) after the main window has been idle 20 s with one short mail open (A), then select the 2 MB mail and a short mail alternately 20 times (a key press or a click, 1 s apart, no reader window anywhere, the list not scrolled), wait 10 s with the short mail open (B).

PASS (numbers): `(B - A) / 20` < 0.3 MB per selection (the report: 270 -> 308 MB, 1.9 MB per selection, before); `frames` = 1, `mail.live` = 1, `mail.created - mail.removed` = 1, `mail.fallbacks` = 0 after the last selection; `attrs` = `[false, false]`; `mail.historyLength` and `mail.frameHistoryLength` equal after selection 1 and after selection 20; the mail is shown (text visible) and a link click, the picture placeholder click, the dark / original button, Find in page (Cmd+F) and Print still work on the last one.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-35.36 | Mac | the footprint of the main page's WebContent over 20 alternating selections of the 2 MB mail and a short mail, no reader window | vmmap / footprint before and 10 s after + P-mailframe | < 0.3 MB per selection; frames = 1; created - removed = 1; history lengths constant | OPEN |
| WK-35.37 | Mac, Linux | the same with the 1 MB plain-text mail and the 500 KB mail in the rotation, and a reader window opened and closed 5 times in the middle | footprint + P-mailframe | no growth beyond 0.3 MB per selection; the reader window's frame is its own (`__mailFrame` of that window: created - removed = 1) | OPEN |
| WK-35.38 | Mac, Linux | behaviour of the written frame on WebKit: first paint of a dark mail in the Light theme (no white frame, no flash of the original colours), links open (and the look-alike / hidden-user warnings ask), "Load content" and blocked pictures, the height follows the content (no inner scroll bar), selection and Cmd+C inside the mail, Find in page, Print | P-mailframe, `scripts/lib/dark-frame-probe.mjs` (WK-F7.01) | `cls` has `hm-dark` and no `hm-pend` within 3 s; `rs` is `complete` or `interactive`; no horizontal scroll bar; `fallbacks` = 0 | OPEN |

## 38. WP7 calendar (coder, `feature/v107-wp7b`): W7.1 repeating events (the question, the dialog notes), W7.4 CalDAV (connect dialog, status line, invitations line), W7.5 move, New calendar and the calendar colour

Nothing here was run on a Mac or Linux. Windows (Chromium, dev preview with the mock backend, real mouse and key events through the test bridge of the harness): `scripts/test-calendar-series-ui.mjs` (W7.1, 8 languages, light and dark, 960 x 560 and 1280 x 800), `scripts/test-caldav-dialog.mjs` (W7.4, ports 5140), `scripts/test-calendar-move-ui.mjs` (W7.5, port 5160), `scripts/test-event-popover-actions.mjs` (the popover footer with the Move button). The rows below are the visible changes and the engine features the code relies on. The mock states: `#calsync=ok&calsyncms=ok` (a Google and an Outlook mailbox with synced calendars), `#calsyncdav=ok` (the custom-domain mailbox connected to a CalDAV server, `#davsched` = the server sends invitations itself), the fixed days of October 2030 are added by the tests (`window.__mockAddEvent`).

Engine features relied on (macOS 11+ WKWebView, WebKitGTK 2.40+):
- CSS grid with `minmax(0, 1fr)` and `grid-column: 1 / -1` (`.ev-form`, `.dav-form`; WebKit 10.1+). `<select>` and `<input type="color">` are the native controls of the engine: the options list and the colour picker are drawn by the system (WebKitGTK shows a GTK colour chooser, WKWebView the macOS colour panel); only their closed look is measured.
- Flex layout with `gap` and `flex-wrap` (`.cal-colors`, the footer rows `.ev-acts`: gap needs WebKit 14.1 / macOS 11.3+, WebKitGTK 2.30+; without it the swatches touch but nothing breaks).
- `overflow-wrap: anywhere` with `word-break: break-word` written before it as the fallback (WebKit 15.4+ for `anywhere`; macOS 11 and 12.0 to 12.2 WebViews may lack it). Used by `.dav-fixed`, `.dav-who` (a long host name) and the existing `.ask p`.
- `window.addEventListener("keydown", fn, true)` (capture phase) so that Esc closes the CalDAV and New calendar dialogs only, not Settings below them (`src/components/nestedEsc.ts`); `createPortal` to `document.body` for the same dialogs.
- Keyboard focus by Tab: WKWebView follows the system setting "Use keyboard navigation to move focus between controls" (System Settings > Keyboard; off by default, buttons are then skipped by Tab, pop-up lists and text fields are not). Run the keyboard rows with it on; WebKitGTK tabs to buttons without a setting.
- No `:has()`, no `clamp()`, no `dvh`, no `color-mix` (beyond the ones already in the stylesheet), no `inert` in the new CSS or code. The test scripts use `:has()` in their Chromium-side selectors only.

### 38.A W7.1 the question and the dialog notes (`src/calendarSeries.ts`, `Calendar.tsx`)

Visible: double-click, Ctrl/Cmd+Enter or Edit on an event of a series asks which part (This occurrence / This and following / The whole series / Cancel) in the `.ask` box, with the service sentence for Google and Outlook; the dialog title says "Edit occurrence" / "Edit this and following events" / "Edit series" with `.ev-scope-note` under it; Repeat is hidden for one occurrence and disabled with a sentence for an Outlook rule the app cannot change; the popover has the line for a changed occurrence; the delete question carries the same choices.

Probe P-q (main window): `(()=>{const a=document.querySelector(".ask");if(!a)return JSON.stringify(null);const bs=[...a.querySelectorAll(".ask-actions button")],r=e=>{const b=e.getBoundingClientRect();return{l:Math.round(b.left),t:Math.round(b.top),r:Math.round(b.right),b:Math.round(b.bottom)}};return JSON.stringify({title:a.querySelector("h3").textContent,buttons:bs.map(b=>b.textContent),rects:bs.map(r),box:r(a),overflowX:a.scrollWidth-a.clientWidth,vw:innerWidth,vh:innerHeight,focusFirst:document.activeElement===bs[0]})})()`

Probe P-dlg (the dialog of an event): `(()=>{const m=document.querySelector(".modal");if(!m)return JSON.stringify(null);const b=m.getBoundingClientRect(),n=m.querySelector(".ev-scope-note"),rep=m.querySelector("#ev-repeat,select[aria-label]");return JSON.stringify({title:m.querySelector(".modal-head b").textContent,note:n?n.textContent:null,noteH:n?Math.round(n.getBoundingClientRect().height):null,box:{l:Math.round(b.left),t:Math.round(b.top),r:Math.round(b.right),b:Math.round(b.bottom)},overflowX:m.scrollWidth-m.clientWidth,titleClip:(()=>{const t=m.querySelector(".modal-head b");return t.scrollWidth-t.clientWidth})(),vw:innerWidth,vh:innerHeight})})()`

PASS (numbers): P-q `overflowX` <= 1; `box` inside `vw` x `vh`; at 960 x 560 the four buttons may take two rows but no button is clipped (`r - l` >= 60, text whole), `focusFirst` true (This occurrence has the focus); P-dlg `box` inside the window, `titleClip` <= 1 (the title may end in an ellipsis in the longest languages: record `titleClip`), `noteH` <= 3 lines (<= 60 px at 13 px type).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-38.01 | Mac, Linux | the question on a repeating event (double-click), 960 x 560 and 1280 x 800, light and dark, de / ru / vi / ja | P-q | `overflowX` <= 1, `box` inside, no clipped button, `focusFirst` true | OPEN |
| WK-38.02 | Mac, Linux | Edit occurrence / Edit this and following events / Edit series: title and note, Repeat hidden or disabled | P-dlg | `box` inside, `titleClip` recorded, `noteH` <= 60 | OPEN |
| WK-38.03 | Mac, Linux | keyboard only: Ctrl/Cmd+Enter on a chip opens the question, Tab walks the choices, Esc cancels and the focus is back on the chip | P-q | `focusFirst` true when it opens; after Esc `document.activeElement` is the chip (`.ev-chip`) | OPEN |

### 38.B W7.4 the CalDAV connect dialog, the status line and the line under the switch (`src/components/CalDavDialog.tsx`, `SettingsDialog.tsx`)

Kit needs: the QA exe or the dev preview with `#calsyncdav=auth` (state "access ended" with the button "Enter password again…"), the custom-domain mailbox (a password mailbox on a host that is not Gmail or Outlook). In the real app the dialog also works against `E:\hey-mail\test-builds\v107-wp7bcde\calendar-kit` (`node kit.mjs up`, the fake CalDAV server on 127.0.0.1:5232, user qa1, password app-secret).

Visible: Settings > mailbox > Calendar shows "Sync calendar with a CalDAV server" and the button "Set up…"; the dialog (width 480) has a service list, the address (a fixed muted text for iCloud and Fastmail), the user name, the password and, for a password mailbox, "Use this mailbox’s password"; the help line of the service; for Nextcloud and Other the certificate box with its warning; one error sentence under the fields; after a refused password the status sentence and "Enter password again…" open the same dialog with only the password.

Probe P-dav (with the dialog open): `(()=>{const f=document.querySelector(".dav-form");if(!f)return JSON.stringify(null);const m=f.closest(".modal"),r=e=>{const b=e.getBoundingClientRect();return{l:Math.round(b.left),t:Math.round(b.top),r:Math.round(b.right),b:Math.round(b.bottom)}},bs=[...m.querySelectorAll(".row-inline .btn")];return JSON.stringify({box:r(m),overflowX:m.scrollWidth-m.clientWidth,buttons:bs.map(b=>b.textContent),sameRow:bs.length===2&&Math.abs(r(bs[0]).t-r(bs[1]).t)<2,btnH:bs.map(b=>Math.round(b.getBoundingClientRect().height)),fixedW:f.querySelector(".dav-fixed")?Math.round(f.querySelector(".dav-fixed").getBoundingClientRect().width):null,labelClip:[...f.querySelectorAll(":scope>label")].map(l=>l.scrollWidth-l.clientWidth),help:[...f.querySelectorAll(":scope>.muted")].map(e=>e.textContent.length),vw:innerWidth,vh:innerHeight,err:m.querySelector(".field-err")?.textContent??null,focus:document.activeElement.id||document.activeElement.tagName})})()`

PASS (numbers): `box` inside `vw` x `vh` at 960 x 560 (all four services, with the certificate warning shown, with an error sentence of 150 characters); `overflowX` <= 1; `sameRow` true; every `btnH` >= 24; `labelClip` all <= 1; `fixedW` <= the width of the input column (`box.r - box.l - 130`); the focus starts on `dav-service` (`dav-pw` in password mode); Esc closes the dialog and leaves Settings open.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-38.04 | Mac, Linux | the dialog for each service, light and dark, de / ru / fr / vi / ja at 960 x 560; the help line and the warning wrap whole | P-dav | `box` inside, `overflowX` <= 1, `sameRow`, `btnH` >= 24, `labelClip` <= 1 | OPEN |
| WK-38.05 | Mac, Linux | a refused password: the sentence under the fields, the typed values stay, Connect usable again; pending state: Connect reads "Connecting…" and the fields are off within 150 ms | P-dav | `err` equals the dictionary sentence; after the click `document.querySelector(".dav-form .btn.primary").getAttribute("aria-busy")` is "true" within 150 ms | OPEN |
| WK-38.06 | Mac, Linux | keyboard: Tab order Service, Address, User name, Password, check boxes, Cancel, Connect; Enter in a field connects; Esc closes only this dialog | P-dav | the order of `document.activeElement.id` / tag over 8 Tab presses; after Esc `.settings` still exists | OPEN |
| WK-38.07 | Mac, Linux | "Enter password again…" after an access-ended state, and the line `{username} · {host}` under the switch (a long host wraps, never widens Settings) | P-dav | `.dav-who` `scrollWidth` <= `clientWidth` + 1; the dialog has no service, address or user name field enabled | OPEN |

### 38.C W7.4 who sends the invitations (the line under the Invite field of the event dialog)

Visible: for a CalDAV calendar the line reads "{server} sends the invitations from {address}." where the server sends them itself, "Hey Look! sends the invitations from {address}." where it does not (the "Send from" choice stays out, as for Google and Outlook); the delete question of an event with guests then offers "Send cancellation" as for My events.

Probe P-inv (event dialog of a CalDAV calendar): `(()=>{const l=[...document.querySelectorAll(".ev-form .muted.small")].find(e=>/@/.test(e.textContent)&&!e.closest(".ev-invite"));if(!l)return JSON.stringify(null);const r=l.getBoundingClientRect(),m=l.closest(".modal").getBoundingClientRect();return JSON.stringify({text:l.textContent,lines:Math.round(r.height/parseFloat(getComputedStyle(l).lineHeight)),inside:r.left>=m.left&&r.right<=m.right,overflowX:l.scrollWidth-l.clientWidth})})()`

PASS (numbers): `inside` true, `overflowX` <= 1, `lines` <= 3 (ru / vi with a 40-character address).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-38.08 | Mac, Linux | the line in en / de / ru / vi / ja with a long mailbox address at 960 x 560 | P-inv | `inside` true, `lines` <= 3 | OPEN |

### 38.D W7.5 "Move to another calendar…" (the popover button and the dialog: `Calendar.tsx`, `src/components/MoveDialog.tsx`)

Visible: the popover of an event of the user has a fifth action, an icon-only button (folder with an arrow; its name and tooltip are "Move to another calendar…") right after Duplicate; it opens a dialog "Move “{summary}”" with the list "Move to" (the calendars of the same mailbox, or every writable synced calendar for My events), the note "The whole series is moved." for a series, and — where the service cannot move an event with guests (Outlook, a CalDAV server that sends invitations, My events with guests) — the sentence "An event with guests can’t be moved to another calendar here. You can move it in {service}." instead of the list and no Move button.

Probe P-move (with the popover open, then with the dialog open): `(()=>{const p=document.querySelector(".ev-pop"),mm=document.querySelector(".modal");const r=e=>{const b=e.getBoundingClientRect();return{l:Math.round(b.left),t:Math.round(b.top),r:Math.round(b.right),b:Math.round(b.bottom)}};if(p&&!mm){const bs=[...p.querySelectorAll(".ev-foot .ev-actions button")].map(b=>({n:(b.getAttribute("aria-label")||b.textContent).trim(),rect:r(b),clip:b.scrollWidth-b.clientWidth,svg:!!b.querySelector("svg")}));return JSON.stringify({pop:r(p),bs,vw:innerWidth,vh:innerHeight})}if(!mm)return JSON.stringify(null);const bt=[...mm.querySelectorAll(".row-inline .btn")],s=mm.querySelector("#mv-to");return JSON.stringify({box:r(mm),overflowX:mm.scrollWidth-mm.clientWidth,title:mm.querySelector(".modal-head b").textContent,select:s?[...s.options].map(o=>o.textContent):null,notice:mm.querySelector(".notice")?.textContent??null,sameRow:bt.length===2&&Math.abs(r(bt[0]).t-r(bt[1]).t)<2,vw:innerWidth,vh:innerHeight,focus:document.activeElement.id||document.activeElement.textContent})})()`

PASS (numbers): popover: the Move button is whole (`clip` <= 1, `svg` true), inside `pop`, the action buttons take at most two lines (the centres differ by at most 12 px per line) with Delete last at the right end, at 946 x 480 and 946 x 552 and 1266 x 712 in en / fr / de / ru; dialog: `box` inside `vw` x `vh`, `overflowX` <= 1, `sameRow` true, the focus starts on `mv-to`, the title ends in an ellipsis rather than overflowing (`overflowX` <= 1); the system pop-up of `#mv-to` lists every option whole.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-38.09 | Mac, Linux | the popover footer with the icon-only Move button, 946 x 480 / 946 x 552 / 1266 x 712, light and dark, en / fr / de / ru | P-move | Move `clip` <= 1, <= 2 lines, Delete last, popover inside the window | OPEN |
| WK-38.10 | Mac, Linux | the Move dialog with a list, with the series note, with the guests sentence; de / ru / vi / ja at 960 x 560 | P-move | `box` inside, `overflowX` <= 1, `sameRow` (list cases) | OPEN |
| WK-38.11 | Mac, Linux | keyboard: Space on the Move button opens the dialog, the arrow keys change the choice, Tab reaches Cancel then Move, Enter moves; Esc cancels and the focus is back on the event | P-move | `focus` = `mv-to` on open; after Esc `document.activeElement` is the event chip | OPEN |
| WK-38.12 | Mac, Linux | a slow move: Move shows its pending state (`aria-busy`, the choice disabled) within 150 ms | P-move | `document.querySelector(".modal .btn[aria-busy=true]")` exists 150 ms after the press | OPEN |

### 38.E W7.5 the colour of a calendar and New calendar (`SettingsDialog.tsx`, `CalColorChoice.tsx`, `NewCalendarDialog.tsx`)

Visible: in Settings > mailbox > Calendar the coloured dot of each calendar is a button (24 px round hit area; its name is "Color of {calendar}") that opens a row under its calendar: "Color from {service}" first, the mailbox swatches, a custom colour input; the chosen colour shows at once in the dot, the sidebar list and the chips and is kept; the button "New calendar…" (Outlook, CalDAV; none for Google yet) opens a dialog "New calendar in {service}" with the name, the colour choice and Create.

Probe P-col (Settings open, one dot opened): `(()=>{const c=document.querySelector(".cal-colors");if(!c)return JSON.stringify(null);const s=document.querySelector(".settings-body, .modal-body").getBoundingClientRect(),cr=c.getBoundingClientRect(),first=c.querySelector("button[role=radio]"),d=document.querySelector(".dot-btn").getBoundingClientRect(),sw=[...c.querySelectorAll(".swatch")].map(e=>Math.round(e.getBoundingClientRect().width));return JSON.stringify({rowRight:Math.round(cr.right),bodyRight:Math.round(s.right),firstClip:first.scrollWidth-first.clientWidth,firstText:first.textContent,dot:Math.round(d.width)+"x"+Math.round(d.height),swatchW:sw,checked:[...c.querySelectorAll("[aria-checked=true]")].length,lines:Math.round(cr.height/28)})})()`

PASS (numbers): `rowRight` <= `bodyRight` + 1, `firstClip` <= 1, `dot` 24x24, every `swatchW` 26, exactly one `checked`, `lines` <= 3 at 960 x 560; the New calendar dialog (probe P-dav works on it with `.dav-form`): `box` inside, `overflowX` <= 1, two buttons on one row, the name field focused.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-38.13 | Mac, Linux | the colour row under a calendar, light and dark, de / ru / vi at 960 x 560; the native colour picker opens from the custom swatch | P-col | as above | OPEN |
| WK-38.14 | Mac, Linux | the dot button: focus ring visible (outline >= 2 px or a box-shadow), Space / Enter open the row, Esc is not swallowed (Settings stays) | P-col | `getComputedStyle(document.activeElement).outlineWidth` or box-shadow non-empty | OPEN |
| WK-38.15 | Mac, Linux | New calendar: the dialog, a refusal sentence in the dialog with the name kept, Create after a name, Esc closes only this dialog | P-dav | `box` inside, `overflowX` <= 1, `.settings` still exists after Esc | OPEN |

## 39. WP13g (coder, `feature/v107-wp13g-mailbg`, W13.15, DEC-025): the app theme decides the mail background

What changed that is visible: in the Light app theme the mail (reading pane, reader window, the composer's "Preview as recipient") is always on the original (white where the sender gave no colour), whatever `mailCanvas` is stored; the sun / moon button there sets a session choice (nothing stored); every switch of the app theme (Settings, command bar, the OS under System) clears the session choice and the composer's preview choice and the surfaces follow within 1 s. The Dark app is unchanged (the button stores). No CSS, layout, font or text was added or changed: the only paint that moves is the frame's own background (class `hm-dark` on the frame's `<html>`, `hm-pend`, and the background style of the `iframe.msg-frame` element: all existing, D-052 / fix25 / fix32) and the composer's `--pv-*` variables.

Engine features relied on (all already in use before this change): `matchMedia('(prefers-color-scheme: dark)')` with `addEventListener('change')` (WebKit 14 = macOS 11 and later; on Linux the backend answer `os-color-scheme` replaces it, osTheme.ts), `MutationObserver` on `data-theme` (the probe only), CSS custom properties, `color-scheme`, `@media screen` / `print`, `visibility`, `requestAnimationFrame` (the probe only). New: none (no clamp(), :has(), inert, color-mix, dvh, scroll-padding). No fallbacks are needed for this change.

Probes (DOM only, run in the page through the test bridge `/eval` of the window that is looked at: `main`, `reader-N`, `compose-N`; the expressions are printed by `node scripts/lib/mail-canvas-probe.mjs` and `node scripts/lib/mail-canvas-probe.mjs watch 3000`; the same file serves CDP):
- P-state: `mailCanvasProbe()` -> `{ theme, themeAttr, osDark, mailCanvas, session, pressed, frame: { cls, hmBg, bodyBg, bodyVis, frameBg, painted, rect, dpr } | null, composer: { cls, bg } | null }`. `painted` is the colour the empty parts of the mail show (the body's, else the frame element's).
- P-watch: `mailCanvasWatch(ms)` starts a sampler (one sample per animation frame) and answers after `ms` with `{ frames, span, osAt, themeAt, colours: [{ c, from, to, n }, ...] (runs in order of appearance), hidden, samples }`. Start it (bridge `/eval` with `timeoutMs` above `ms`), then switch in the same second, by hand or from another request.
- P-pixel (Mac, real pixels at 2x): `GET /snapshot?window=main` (PNG of the web content, 2x on a Retina Mac), then `node scripts/lib/mail-canvas-probe.mjs pixel snap.png <x*dpr> <y*dpr>` with a point inside `frame.rect` that has no mail content (bottom right corner: `rect.x + rect.w - 16`, `rect.y + min(rect.h, innerHeight - rect.y) - 16`). Linux has no `/snapshot` (HTTP 501): there the P-state / P-watch DOM numbers and a screenshot by hand are the evidence.
- Fixtures: any HTML mail without colours of its own (a paragraph and a list) for the white / dark rows, and a newsletter with its own dark design (dark wrapper `#121212`, light text) for WK-39.07.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-39.01 | Mac, Linux | Fresh profile (new data folder), theme System with the OS light: the plain HTML mail in the pane; then Settings > Appearance > Light; open it again in a reader window (double-click) | P-state in `main` and `reader-N`; P-pixel on Mac | `frame.cls` = "" (no `hm-dark`), `bodyVis` = visible, `hmBg` = `#ffffff`, `painted` = [255,255,255]; Mac pixel = 255,255,255 +-2 at 2x; `pressed` = "false"; `mailCanvas` = "original" | OPEN |
| WK-39.02 | Mac, Linux | Stored dark in the Dark app, then switch the app to Light (Settings, and Ctrl+K / Cmd+K): the pane, a reader window and a composer with the preview on dark, all open at once | P-watch(3000) in `main`, `reader-N`, `compose-N` started before the switch; P-state after | In every window: `colours` = exactly two runs, the dark one first (about 27,28,32; composer `--pv-bg` 27,28,32) then white (255,255,255), no third colour; the white run starts <= 1000 ms after the setting changed (`themeAt`); `hidden` = 0 for the switch to Light; afterwards `mailCanvas` = "dark" (unchanged), `session` = null | OPEN |
| WK-39.03 | Mac, Linux | The reverse: Light -> Dark with the stored dark: pane, reader window, composer | P-watch(3000) | Runs in order: white, then dark; no third colour; the dark run starts <= 1000 ms after `themeAt`; `hidden` may be > 0 only while `frame.cls` has `hm-pend` and the frame element's own background is dark (`frameBg` = rgb(27, 28, 32)), and `colours` shows no white after the first dark run | OPEN |
| WK-39.04 | Mac, Linux | Real OS switch with the theme System (AC-13.15.5): stored dark, then flip the OS appearance (macOS: System Settings > Appearance Light / Dark; Linux: `gsettings set org.gnome.desktop.interface color-scheme prefer-dark` / `default`, or the KDE / portal switch). Pane and a reader window open, and a composer on its start value | P-watch(6000) started, then the OS switch; P-state after each | `osAt` or `themeAt` is set (the app noticed); the colour runs are white -> dark on the way to a dark OS and dark -> white on the way back, two runs each; the new run starts <= 1000 ms after `osAt` / `themeAt`; the composer's `cls` is `pv-dark` on the dark OS (stored dark) and `pv-light` on the light OS | OPEN |
| WK-39.05 | Mac, Linux | Light app, press the sun / moon button (session choice): dark; open another mail in the pane (still dark); open a reader window now (dark at open); quit and start the app (original) | P-state before / after each step | After the press: `session` = "dark", `mailCanvas` unchanged, `pressed` = "true", `painted` about [27,28,32]; the new reader window shows `painted` about [27,28,32] within 1000 ms of its first frame; after the restart `session` = null, `painted` = [255,255,255]; the stored `mailCanvas` is what it was before the press | OPEN |
| WK-39.06 | Mac, Linux | Dark app, stored original: button -> dark (stored); switch to Light -> original; back to Dark -> dark | P-watch(3000) around each switch, P-state | `mailCanvas` = "dark" after the press and after both switches; runs: dark -> white -> dark; no third colour | OPEN |
| WK-39.07 | Mac, Linux | Light app, the newsletter with its own dark design | P-state; P-pixel on Mac inside the dark wrapper | `frame.cls` = "" (not recoloured), the wrapper's computed background `rgb(18, 18, 18)` and text `rgb(238, 238, 238)` unchanged, no `data-hm` attribute in the frame; Mac pixel inside the wrapper about 18,18,18 +-3 | OPEN |
| WK-39.08 | Mac | Print preview (Cmd+P, W5.3) in each of: Light/original, Light/session dark, Dark/original, Dark/dark | the system print sheet's preview (the printed document is `printDoc.ts`, always light) | The preview is white with dark text in all four; the pane after cancelling is unchanged (`painted` as before) | OPEN |
| WK-39.09 | Mac, Linux | Open a mail in the Dark app with the stored dark right after a switch Light -> Dark (fix32 rule), and a reader window opened in the Dark app | P-watch(2000) started before the open, `dark-frame-probe.mjs` (WK-F7.01) | No white run after a dark one in the Dark app; `cls` has `hm-dark` and no `hm-pend` within 3 s | OPEN |
| WK-39.10 | Mac, Linux | The theme setting chosen again with the value it has (Settings > Light while Light), and a preference that is not the theme (density) while the session choice is dark | P-state | `session` stays "dark" (no theme switch happened); choosing System while Light with the OS light clears it (the setting changed) | OPEN |

## 41. fix38 (coder, `feature/v107-fix38`): "Opening message…" is one surface over the whole body area

What changed that is visible: while a mail opens (reading pane and reader window, small or heavy) the status block "Opening message…" fills the WHOLE body area under the header as one surface, in the colour the mail will have there (white for the original canvas, `rgb(27, 28, 32)` for the dark canvas; WP13g decides which one the app theme shows), with the text and the ring in colours that read on it. Before, a 34em box (476 px) of the app colour sat in the middle of the area with 76 px of the mail or the pane showing on each side (`.reader-state` later in App.css gave back the `max-width` / `margin` that `.rp-opening` had removed): a small dark card in a light pane, or the opposite. The composer's shell of an answer (Preview as recipient) already sits on the editor's own surface, which has the preview colour; checked, unchanged.

Engine features relied on: `position: absolute` with `top/right/bottom/left: 0` and `box-sizing: border-box` (no `inset`, which macOS 11 lacks), a class pair `on-light` / `on-dark` chosen by the page from the same rule as the frame (`useCanvasDark`, openStatus.tsx), `getBoundingClientRect`, `requestAnimationFrame`. No `clamp()`, `:has()`, `color-mix` or `dvh`.

Probe (DOM only, run through the test bridge `/eval` of `main` or `reader-N`; the expressions are printed by `node scripts/lib/open-surface-probe.mjs`): START before the open (select a mail, or open the reader window), READ 1.5 s after the mail is on screen. READ answers `{ frames, withStatus, maxRectDiff, colours, texts, small, bodyBefore, bodyAfter }`.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-41.01 | Mac, Linux | Light app, stored canvas dark (the Mac QA profile): open the 2 MB fixture (scripts/lib/reply-fixtures.mjs) in the pane at a pane width of about 630 px and at about 940 px | START / READ in `main` | `withStatus` >= 3, `maxRectDiff` <= 1, `small` = 0, `colours` = [[255,255,255]] (one colour), `bodyBefore` and `bodyAfter` equal within 1 px; looking at it: one white surface over the whole body area, the text grey, no box with an edge | OPEN |
| WK-41.02 | Mac, Linux | Dark app, stored canvas dark: the same open | START / READ in `main` | `colours` = [[27,28,32]] within 4 levels, the rest as WK-41.01; the text light grey (contrast >= 3 on the surface) | OPEN |
| WK-41.03 | Mac, Linux | Dark app, stored canvas original: the same open | START / READ in `main` | `colours` = [[255,255,255]]: the surface is the colour the mail will have (white) over the whole area, not the dark of the app; no small card | OPEN |
| WK-41.04 | Mac, Linux | Reader window (double-click a mail), Light and Dark app with the stored canvas dark; a small mail and the 2 MB one | START in the reader window right after it opens (poll every 20 ms if it is too late), READ | the first status frame has `maxRectDiff` <= 1 and the colour of the mode; the reader window's first state before the conversation arrives (ring on the app colour, no header yet) is unchanged | OPEN |
| WK-41.05 | Mac, Linux | The timing rules of W13.6 with the new surface: a quick open never shows it, once shown it stays >= 300 ms, 20 s safety end; no white or dark flash when the frame replaces it | the W13.6 probe `scripts/lib/open-mail-probe.mjs` (WK section 31) and `scripts/lib/dark-frame-probe.mjs` (WK-F7.01) | statusMs 90-220 for a 500 ms read, shown >= 290 ms, `frameMs` unchanged vs section 31, no third colour in the dark-frame probe | OPEN |
| WK-41.06 | Mac, Linux | Composer: Forward a mail with a slow server, Light and Dark app, preview on dark | eyes + `getComputedStyle(document.querySelector('.cp-editor')).backgroundColor` | the status sits centred on one surface that fills the editor box; its colour is the preview colour (white or `rgb(27, 28, 32)`) | OPEN |

## 42. fix39 (coder, `feature/v107-fix39`, D-103): the conversation arrives as one raw buffer

What changed that is visible: nothing (the mail looks and behaves the same). What changed underneath: the page reads a conversation with `get_thread_packed` (one `tauri::ipc::Response`: metadata JSON without bodies + the bodies as UTF-8 bytes, read by `src/threadPack.ts`) instead of `get_thread` (one JSON string with the 2 MB HTML inside). The JSON command stays for the comparison loop.

Engine features relied on: `fetch` of the `ipc://` custom protocol answering `application/octet-stream` and `response.arrayBuffer()` (Tauri's own invoke), `TextDecoder('utf-8', { ignoreBOM: true })`, `DataView`. Nothing newer than WebKit 14.

Probes (through the test bridge `/eval` of `main`; footprint with `footprint -p <WebContent pid>` or `vmmap --summary`, "WebKit Malloc" dirty): LOOP-JSON = `for (let i=0;i<80;i++) (await window.__TAURI_INTERNALS__.invoke('get_thread', { threadId: <2 MB mail>, scope: null, light: null })).length`; LOOP-PACKED = the same with `'get_thread_packed'` and `.byteLength`. Read the dirty size after 0, 20, 40, 80 calls and 10 s after the last.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-42.01 | Mac | Main page WebContent, 2 MB mail, LOOP-JSON then (fresh app) LOOP-PACKED | footprint / vmmap before and 10 s after each loop | record both; PASS for the fix: LOOP-PACKED grows by < 10 MB dirty over 80 calls (LOOP-JSON grew about 66 MB: +0.8 MB per call); if both grow the same, the retention is in the response body path in general (upstream-wry-window-cycle.md, second section) | OPEN |
| WK-42.02 | Mac | Reader series with the 2 MB mail (open + close a reader window 20 times, AC-4.1.3) and with a small mail | footprint of the main WebContent before / after, 10 s idle | the +90 MB per 20 cycles of the 2 MB mail drops to < 20 MB; the small mail stays about +6 MB or less | OPEN |
| WK-42.03 | Mac, Linux | Open a 2 MB mail in the pane and a reader window, Show original, Print (Mac), Reply (quote), the blocked pictures, a link in the mail | eyes | all as before (identical rendered output); the pane's first paint is not later than before (`scripts/lib/open-mail-probe.mjs`, `frameMs` within 10 %) | OPEN |

## 40. WP5f-mac (coder, `feature/v107-macmenu`, W5.11, DEC-026, D-104): Settings…, Print…, Help in the menu bar; local network reason; notification permission in every window

What changed that is visible: (a) the app menu has "Settings…" (Cmd+,) after About with a separator of its own; (b) File has "Print…" (Cmd+P) after Close Window behind a separator, on only while the window with the focus is the main window or a reader window that shows a printable message (not Confidential, no dialog in front); (c) Help has "Hey Look! Help" (help.html of the app language in the default browser); the three follow the app language at once; (d) the macOS question "find devices on your local network" (first print) shows the reason text; the 7 translations are `Contents/Resources/<lang>.lproj/InfoPlist.strings`. Not visible: every window asks the notification plugin once at load (`notification:allow-is-permission-granted`, capability `notification.json`, macOS and Linux only), so the console shows no "not allowed" rejection. Side effect of the lproj folders to look at: macOS now sees 8 localisations of the bundle, so system-made UI of the app (the print panel, the system items of the Edit menu such as Start Dictation…) may follow the macOS language instead of staying English.

Engine / OS features relied on: muda menu items through tauri (`MenuItem::set_enabled` / `set_text` on the main thread, accelerators `CmdOrCtrl+,` and `CmdOrCtrl+P`), the Help submenu registered with the system (`set_as_help_menu_for_nsapp`, its search field stays), `NSLocalNetworkUsageDescription` in Info.plist (macOS 11+; the prompt appears from macOS 12 or later when the print panel looks for printers), `bundle.macOS.files` placing lproj files in `Contents/Resources`. Nothing newer than WebKit 14.

Probes (the native menu is not visible to the page; the menu is read through System Events, the page's report through the debug log and an invoke wrapper):
- P-menu: `osascript -e 'tell application "System Events" to tell process "<app name>" to get {name, enabled} of every menu item of menu 1 of menu bar item <N> of menu bar 1'` with N = 2 (app menu), 3 (File), the last (Help); a separator reads as `missing value`.
- P-report (main or reader window, bridge `/eval`): `(()=>{const o=window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);window.__ms=[];window.__TAURI_INTERNALS__.invoke=(c,...r)=>{if(c==='mac_menu_state')window.__ms.push({can:r[0]?.canPrint,at:Math.round(performance.now())});return o(c,...r)};return 'wrapped'})()`, read `window.__ms`.
- P-log: `startup.log` lines `menu: Settings… chosen in the app menu`, `menu: Print… chosen in the app menu: <label> prints`, and `menu: Print… chosen with nothing to print: ignored` (must not appear: the item is off).
- P-console (bridge `/console`): no `not allowed` in any window after start.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-40.01 | Mac (en) | App menu | P-menu N=2 | items in order: About Hey Look!, separator, Settings…, separator, Services, separator, Hide Hey Look!, Hide Others, Show All, separator, Quit Hey Look!; Settings… has Cmd+, (key shown in the menu) | OPEN |
| WK-40.02 | Mac (de, ja) | The same after Settings > language | P-menu N=2, 3, last | de: "Einstellungen …", "Drucken …", "Hey Look!-Hilfe"; ja: "設定…", "プリント…", "Hey Look! ヘルプ"; compare with the real macOS wording of both and record any difference (AC-5.11.5 asks this) | OPEN |
| WK-40.03 | Mac (all 8) | Language switch with the menu bar visible (no restart) | P-menu | the three texts change within 1 s of the switch; vi "Cài đặt…", "In…", "Trợ giúp Hey Look!"; fr "Réglages…", "Imprimer…", "Aide Hey Look!"; zh-Hans "设置…", "打印…", "Hey Look!帮助"; es "Ajustes…", "Imprimir…", "Ayuda de Hey Look!"; ru "Настройки…", "Напечатать…", "Справка Hey Look!" | OPEN |
| WK-40.04 | Mac | Cmd+, from the main window, from a reader window, and with the main window hidden to the tray | P-log, eyes | Settings opens each time (the main window is shown and in front first; Settings as the gear opens it: dialog, or the Settings window kind) | OPEN |
| WK-40.05 | Mac | File > Print… with a mail open in the main window | P-menu N=3, P-report, P-log | enabled; Cmd+P and the menu item each open the macOS print panel ONCE (no second panel: the page takes no Cmd+P); the document is the W5.3 one | OPEN |
| WK-40.06 | Mac | The same item with: nothing selected, a Confidential mail, a compose window focused, the Settings window focused, a dialog open over the main window | P-menu N=3, P-report | disabled in all five (`enabled` false); Cmd+P does nothing; `P-log` has no "Print… chosen" line; P-report: after a selection change the report is within 200 ms (`at` of the report - time of the click <= 200) and there is one report per change | OPEN |
| WK-40.07 | Mac | A reader window with its mail, with the main window open behind with another mail | P-menu N=3 on each focus change (click between the two windows) | Print is on in each window that shows a printable mail and follows the focus within 200 ms; in the reader it prints the reader's mail (P-log names `reader-N`) | OPEN |
| WK-40.08 | Mac | Help > Hey Look! Help (en and de) | default browser | https://heylook.namthai.site/help.html and https://heylook.namthai.site/de/help.html open; the Help menu still has the system search field at the top | OPEN |
| WK-40.09 | Mac | First print on a Mac that never answered the local network question (new QA identity: new bundle data / `tccutil reset` is not available for it, so use a fresh user or a new bundle identifier build) | eyes, screenshot | the macOS prompt shows the reason text in the language of macOS (de, ja if the lproj folders worked, otherwise English: record which); then "Don't Allow": does the print panel still print to an already configured printer and to PDF? (decides whether the README / help sentence about "Don't Allow" is written) | OPEN |
| WK-40.10 | Mac | The built bundle | `plutil -p "Hey Look!.app/Contents/Info.plist"`, `ls "Hey Look!.app/Contents/Resources/"*.lproj`, `plutil -lint` on each InfoPlist.strings | `NSLocalNetworkUsageDescription` = the English text, no `NSBonjourServices`; 7 lproj folders (vi fr zh-Hans es ja de ru) each with a valid InfoPlist.strings; if Tauri did not place them, say so (the English plist is then the only text) | OPEN |
| WK-40.11 | Mac, Linux | Console of every window kind after start (main, reader, compose, Settings, search, Scheduled, event) | P-console | no `is_permission_granted not allowed`; Linux: the same | OPEN |
| WK-40.12 | Windows, Linux | Menus | eyes | no Settings / Print / Help item appears anywhere (no native menu bar item is added); Windows: the build has no notification capability for the plugin (it is not loaded there) | OPEN |

## 45. WP10c site texts (coder, `feature/v107-wp10cde`): the 1.0.7 limits, the home ledger, the help question about the local network

What changed that is visible (text only, no CSS, no markup class, 8 languages): features.html `#calendar` second item (h3 "Sync with Google, Microsoft and CalDAV" and its sentence), `#limits` items 2 to 5 (the "macOS and Linux" item is now "Linux"; "PDF attachments" became "Folders"; "Mail, search and writing" became "Mail and writing"; the Calendar item), index.html honest ledger (first Partial item, third "Not yet" item) and the calendar demo note (`p.k-note` and `story.cal_note`), help.html `#push`, `#lim`, `#leaves` (a clause) and one NEW question `#macos-print` after `#macos` (summary + one paragraph). The strings are longer or shorter than before in some languages; no layout rule changed.

Engine features relied on: none new. The pages already use what WP10h / WP10i added (`.fg-list` with `repeat(auto-fill, minmax(min(100%, max(319px, calc(50% - 1px))), 1fr))`, per-cell borders). The new help question uses the existing `details.hq` markup.

Probe (run on features.html, index.html and help.html of a language with `/eval` of the test bridge, or in the browser console of Safari / Epiphany; the pages are static files, so any WebKit with the file served from `docs/` works): 
`(()=>{const q=s=>[...document.querySelectorAll(s)];const m=e=>{const b=e.getBoundingClientRect();return{w:Math.round(b.width),h:Math.round(b.height)}};return JSON.stringify({page:location.pathname,sideways:document.documentElement.scrollWidth-innerWidth,clipped:q('h3,summary,li,p,td,th').filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.textContent.slice(0,40)),limits:q('#limits .fg-list > li').map(e=>({t:e.querySelector('h3').textContent,...m(e)})),ledger:q('#honest li').map(e=>({t:e.textContent.slice(0,30),...m(e)})),print:(()=>{const d=document.getElementById('macos-print');if(!d)return null;const s=d.querySelector('summary');return{summary:m(s),lines:Math.round(s.getBoundingClientRect().height/parseFloat(getComputedStyle(s).lineHeight))}})()})})()`

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-45.01 | Mac (Safari), Linux (Epiphany or the app's WebKitGTK) | features.html in en, de, ru, ja, vi at 375, 700 and 1280 px, light and dark | probe | `sideways` <= 0, `clipped` empty, `limits` has 6 items; at 700 and 1280 px the items sit in 3 rows of 2 cells with equal cell widths (each `w` within 2 px of the others in its row), at 375 px one column; no item is taller than 3x the shortest item of its row (the Calendar item is the shortest, the Linux item the longest) | OPEN |
| WK-45.02 | Mac, Linux | index.html #honest in de, ru, ja, vi at 375 and 1280 px | probe | `sideways` <= 0, `clipped` empty, 5 ledger items, none wraps to more than 3 lines (`h` <= 3 x line height + 8 px) | OPEN |
| WK-45.03 | Mac, Linux | help.html in de, ru, ja, vi at 375 and 1280 px: open `#macos-print` (click its summary), type "local" or the language's word for it in the filter box | probe, eyes | `print.lines` <= 3 at 375 px; the answer opens and closes; the filter finds it; `clipped` empty; Install group still shows 4 questions | OPEN |
| WK-45.04 | Mac, Linux | The calendar step of the home tour (index.html, press Accept in the scene) in ja, de, ru at 375 px | eyes, probe | the note under the invitation shows the new sentence (Google, Microsoft or CalDAV) without clipping; `clipped` empty | OPEN |
| WK-45.05 | Mac, Linux | Fonts | `getComputedStyle(document.body).fontFamily` and `document.fonts.check('16px ' + family)` recorded for the run | record the family actually used per language (Hiragino / Noto Sans CJK for ja and zh, San Francisco / Cantarell / DejaVu for Latin and Cyrillic); the rows above are only valid with it recorded | OPEN |

## 46. fix42 (coder, `feature/v107-fix42`, D-103 root cause): the dark walk of a mail runs once per mail, in one kept hidden frame

What changed (no visible change is intended; the look must be identical): `src/darkMail.ts` `setMailDark(doc, dark, base, mail)`. Mac QA root cause: reading the computed style of every element of a document (the dark walk, `buildDarkSheet`, about 4,400 elements for the 2 MB fixture) keeps about 5.7 MB of native style data per document on WebKit, after the frame is removed; clearing the document or navigating the frame away does not give it back. Now (1) the result of a walk (the sheet text and the rule number of every element in tree order, strings and numbers only) is kept for the last 8 mails and the same mail in a new frame is dressed from it, no style read; (2) a walk that has to be made runs in ONE hidden frame (`position:fixed; left:-20000px; visibility:hidden`, the sandbox of the message frame, a CSP that loads nothing, the width of the message frame) that stays for the life of the page and is written again for each mail; the result is copied into the message frame by tree position. If the hidden frame cannot be used, the message frame is walked as before.

Engine features relied on: `getComputedStyle` in a frame that is laid out but invisible (the media queries of the mail see the width of the message frame), `document.open / write / close` on the frame's own document, `Int32Array`. No CSS, no new API.

Probes (bridge `/eval` in the main window or a reader window):
- P-stats: `JSON.stringify(window.__darkMail)` gives `{walks, cached, scratch, computed, inScratch, inFrame, rules, cache}`; `window.__darkMailClear()` forgets the cached walks; `window.__darkMailScratch = false` makes the next walk run in the message frame itself (the old way, for the comparison).
- P-look: `(()=>{const d=document.querySelector('.msg-frame').contentDocument;const s=[...d.querySelectorAll('style')].map(x=>x.textContent).find(t=>t.includes('@layer hm'))??'';return JSON.stringify({len:s.length,rules:s.split('[data-hm=').length-1,tagged:d.querySelectorAll('[data-hm]').length,tags:[...d.querySelectorAll('[data-hm]')].map(e=>e.getAttribute('data-hm')).join(',').length})})()`.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-42b.01 | Mac (Dark app theme, mailCanvas dark; QA profile follows OS Dark) | The Mac QA loop: select the 2 MB mail and a second big mail alternately, 40 pairs, after 2 warm-up pairs | footprint / WebContent of the main page before and after (vmmap / `footprint`), P-stats | the growth per pair is under 0.2 MB (was 4.7 MB per selection); `inFrame` stays 0; `walks` stops growing after the first visit of each mail (at most 2 per mail: the mail is written again when its pictures are resolved) | OPEN |
| WK-42b.02 | Mac | The same loop, but 30 DIFFERENT big mails once each | footprint of the main page's WebContent | the growth is the one hidden frame's (a few MB in all, not 5 MB per mail); if it still grows per new mail the hidden frame keeps style data too: report the number | OPEN |
| WK-42b.03 | Mac, Linux | The look: the 2 MB mail, the newsletter fixtures and a mail with coloured cards in Dark, first visit (walk in the hidden frame) and second visit (from the cache) | P-look on both visits, screenshots | identical `len`, `rules`, `tagged`, `tags` on both visits and identical to a run with `window.__darkMailScratch = false` after `__darkMailClear()`; screenshots equal | OPEN |
| WK-42b.04 | Mac, Linux | The reader window and a mail with `@media (max-width)` colour rules at two pane widths | eyes, P-look | the dark mail reads as before in both (the walk sees the width of the message frame at the time of the walk, as before) | OPEN |

## 47. WP9f (coder, `feature/v107-wp10cde`): W9.7 theme tokens without color-mix(), W9.6 Linux snapshot, W9.4 token file protection

What changed: (a) W9.7 `src/colorFallback.ts`: when `CSS.supports("color", "color-mix(in srgb, red 50%, blue)")` is false (WebKit before Safari 16.2), `applyColorFallback()` (called by `applyPrefs`, which also runs when the OS theme changes, and by the Appearance preview) sets the custom properties of App.css that use color-mix() as plain #rrggbb colours on the root (light: `--accent-hover`, `--accent-soft`, `--top-ring`; dark: `--accent`, `--accent-hover`, `--accent-soft`) and on `.ap-preview` (`--accent`, `--accent-soft`, `--top`). Nothing happens on an engine with color-mix(). (b) W9.6 the test bridge `/snapshot` on Linux (debug builds only): `webkit_web_view_get_snapshot` of the visible region, cairo ARGB32 premultiplied to RGBA, PNG with the `png` crate. (c) W9.4 (Windows, debug builds only): `test-bridge.json` gets an access list with one entry (the current user), no inherited entries, before the token is written.

Engine features relied on: `CSS.supports()` with a colour function (the probe itself), `matchMedia("(prefers-color-scheme: dark)")`, `document.documentElement.style.setProperty` for custom properties; Linux: WebKitGTK `webkit_web_view_get_snapshot` (2.40 has it) and cairo image surfaces.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-47.01 | Mac (current macOS), Linux | no visual change in Light and Dark: ribbon, primary button, top bar, Settings > Appearance preview, link colour, focus ring | screenshots before / after on the same build | identical pixels (the fallback does not run on an engine with color-mix(); `needsColorFallback` is false: `CSS.supports('color','color-mix(in srgb, red 50%, blue)')` returns true) | OPEN |
| WK-47.02 | Mac (macOS 11 or 12 with Safari < 16.2, if a machine or VM exists; else NOT RUN, known gap) | Dark theme, default accent and one preset | `getComputedStyle(document.documentElement).getPropertyValue('--accent-hover')` and the colour of a primary button | `--accent-hover` is `#rrggbb`; the primary button, links and the focus ring show the accent (not the text colour / transparent) | OPEN |
| WK-47.03 | Linux VM (ARM KDE), debug kit with the bridge | `node bridge.mjs snapshot main out.png`, Light and Dark | `file out.png` | `PNG image data, <w> x <h>` with the window's size in device pixels; the picture shows the app as on screen; a second snapshot of a pop-out window works too | OPEN |
| WK-47.04 | Windows | `icacls "<data>\test-bridge.json"` with the debug kit and `HEYLOOK_TEST_BRIDGE=0` | icacls | exactly one line `<PC>\<user>:(F)`, no `(I)` entries, no BUILTIN\Users, no Everyone; after Quit from the tray the file is gone; after a kill it stays and is rewritten with the same list at the next start | OPEN |

## 43. WP13f-3 (coder, `feature/v107-wp13f3`, DEC-023, D-067 timing, D-096): Reply, Reply all and Forward are filled in place

What changed that is visible: the message that opened at once as a shell is now filled INTO that shell (the same compose pane or window and the same editor take the recipients, the quote, the signature and the attachments in one render and one transaction) instead of a second compose being mounted over it. Nothing is meant to look different, except (1) it is complete sooner (about 200 ms less in a debug build: no second React tree, no second editor), (2) a Reply all whose message has Cc recipients, and a Forward with an Auto Bcc, have their Cc and Bcc rows in the shell from the first frame (before: the shell had the Cc / Bcc links and the rows appeared at the fill), (3) the frame that stands in for the pane while the editor chunk loads also has the Cc / Bcc links row now (one row, the height of the real one), (4) Ctrl/Cmd+Z right after the fill does nothing (the fill is not in the undo history). The editor made for the shell is not editable and not on screen until the fill; at the fill it becomes editable and the caret goes where a fresh mount puts it (top of the body; a Forward has no recipient: the To field takes the focus).

Engine features relied on: ProseMirror transactions on a view whose DOM is moved from a detached element into the pane by tiptap's `EditorContent` (the same move a fresh mount makes), `contenteditable` switched by `editor.setEditable(true)` (ProseMirror sets the attribute), `requestAnimationFrame` + `view.focus()` for the caret (tiptap's `focus('start')`), `inert` (existing since W13.13, with its pointer-events fallback). No CSS, no new API, no feature that needs a fallback on macOS 11+ / WebKitGTK 2.40+.

Probes (bridge `/eval` or the script; the script runs three bridge calls and prints JSON):
- P-reply (AC-13.13.14): `node scripts/lib/reply-open-probe.mjs <data folder | test-bridge.json | port:token> main Reply 450` with a 20 KB message open in the reading pane (`Reply all`, `Forward` for the others; the last argument is the limit of `filledMs`, 450 for the 20 KB mail, leave it out for the 2 MB mail). It prints `{ shellMs, statusMs, statusStarved, statusNullOk, filledMs, gapMax, rowsMovedPx, rowsAdded, rowLabels, same: { instance, pane, editor, view }, canUndoAtFill, fillKind, checks: { shell, status, filled, rows, gap, sameObjects, noUndo }, pass }` and exits 1 when a check fails.
- P-state (a compose WINDOW, which the press creates, so the recorder cannot be installed before it): press Reply with Shift (or with Settings > Composing "Open in a separate window" on), find the window with `GET /windows` (`kind` compose), then `node scripts/lib/reply-open-probe.mjs <bridge> <compose label> state`. It prints `{ preparing, fillKind, instance, rows: [{label, y, h}], canUndo, editable, signatureRegions, quote, recipients, font }`.
- P-undo (AC-13.13.17, Cmd+Z on the Mac): after the fill, in the pane or the window: `/eval` `(()=>{const e=document.querySelector('.compose-pane').__editor;return JSON.stringify({doc:JSON.stringify(e.getJSON()).length,canUndo:e.can().undo(),ce:e.view.dom.getAttribute('contenteditable')})})()`, then `POST /key {"window":"<label>","key":"z","meta":true}` (Mac) or `"ctrl":true` (Linux), then the same `/eval` again: `doc` identical, `canUndo` false, `ce` "true". Then `POST /type` "abc" into the body and the same key: `doc` is back to the first number.
- P-focus (the caret after the fill): `/eval` `(()=>{const a=document.activeElement;return JSON.stringify({inEditor:!!a&&!!a.closest&&!!a.closest('.cp-editor'),inTo:!!a&&!!a.closest&&!!a.closest('.cf-field.rcpt'),tag:a&&a.tagName})})()`.
- P-font (the fonts of the filled message, de and ja): `/eval` `(()=>{const f=s=>{const e=document.querySelector(s);return e?getComputedStyle(e).fontFamily:null};const ed=document.querySelector('.cp-editor .tiptap');return JSON.stringify({editor:f('.cp-editor .tiptap'),quote:f('.cp-editor .quote-block'),sig:f('.cp-editor .sig-block .sig-body'),size:ed&&getComputedStyle(ed).fontSize,ok:ed&&document.fonts.check('16px '+getComputedStyle(ed).fontFamily)})})()`.
- P-rows (the Cc / Bcc rows in the shell; run while it prepares, e.g. with the stub delay, then again after the fill): `/eval` `(()=>{const p=document.querySelector('.compose-pane');return JSON.stringify({preparing:p.classList.contains('preparing'),rows:[...p.querySelectorAll('.cp-fields .cf-field, .cp-fields .cf-links')].map(f=>{const r=f.getBoundingClientRect();return [f.querySelector('label')?f.querySelector('label').textContent.trim():'links',Math.round(r.top*10)/10,Math.round(r.height*10)/10]})})})()`.

PASS (numbers), Mac and Linux DEBUG builds (React debug is about 3x slower than the release build; AC-13.13.14):
- P-reply: `shellMs` <= 200; `statusMs` <= 250, or null with `statusNullOk` true (the status is due 140 ms after the press; when the main thread was busy at that moment, `statusStarved` true, it cannot be drawn and the message was complete when the thread came free: D-096, not a missing status); `filledMs` <= 450 for the 20 KB mail, not null for the 2 MB mail; `rowsAdded` 0 and `rowsMovedPx` <= 1 (the OpenPGP strip is not a row; it may appear at the fill and move only what is below the rows); `gapMax` < 250 (WebKit has no long-task API; `longTaskMax` is null there); `same` all four true; `canUndoAtFill` false; `fillKind` "in-place"; `statusGoneMs - statusMs` >= 300 whenever the status was shown.
- P-state in a compose window: `fillKind` "in-place", `preparing` false, `canUndo` false, `editable` true, `signatureRegions` 1, `quote` true; `rows[].label` the same list as in the shell ("From", "To", "Cc", "Bcc", "Subject" for a Reply all with Cc recipients; "From", "To", "links", "Subject" for a Reply).
- P-undo: as above. P-focus: Reply and Reply all `inEditor` true; Forward `inTo` true. P-font: the family actually used per language is recorded (Hiragino / Noto Sans CJK for ja, San Francisco / Cantarell / DejaVu for Latin); `ok` true; the same family on `quote` and `editor` as on a fresh compose of the same language.
- P-rows: the labels in the shell are the labels after the fill; every `top` and `height` equal +- 1 px between the two calls.

Windows (Chromium, the dev preview with the mock backend) ran these, with the same pass criteria where they apply: `node scripts/test-reply-feedback.mjs --require-browser` (identity of the Compose and the editor, Ctrl+Z, drafts and recovery, the Cc rows, the fallback, the window), `node scripts/test-answer-geometry.mjs --require-browser` (every box +- 1 px, including Reply all with Cc and a Forward with an Auto Bcc), `node scripts/test-reply-golden.mjs --require-browser` (the message handed to the outbox is equal to the one a fresh mount gives). The Mac and Linux rows below are not run by the coder.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-43.01 | Mac, Linux (debug kit) | Reply on the 20 KB mail in the pane, 1280 x 800, light and dark, 3 presses (a fresh compose each time) | P-reply with 450 | as above, all three presses | OPEN |
| WK-43.02 | Mac, Linux | Reply on the 2 MB mail (stub delay 300 ms), 5 presses | P-reply | `shellMs` <= 200, `statusNullOk` true on all five, `filledMs` not null, `gapMax` < 250 | OPEN |
| WK-43.03 | Mac, Linux | Reply all on a message with 2 Cc recipients (the stub fixture), and a Forward with 3 attachments | P-reply, P-rows | Reply all: `rowLabels` ["From","To","Cc","Bcc","Subject"] in the shell and after, `rowsAdded` 0; Forward: "Getting the attachments…", `rowsAdded` 0 | OPEN |
| WK-43.04 | Mac, Linux | A compose window (Shift+Reply, Shift+Reply all, Shift+Forward) | P-state on the window, P-rows, the window appears <= 600 ms | `fillKind` "in-place", rows as in WK-43.03, `canUndo` false | OPEN |
| WK-43.05 | Mac (Cmd+Z), Linux (Ctrl+Z) | Undo right after the fill and after typing, pane and window | P-undo | as above | OPEN |
| WK-43.06 | Mac, Linux | The caret after the fill: Reply, Reply all, Forward; type a letter at once | P-focus, `/type` | Reply and Reply all: the letter lands in the first line of the body above the signature; Forward: in the To field | OPEN |
| WK-43.07 | Mac, Linux | de and ja: the fonts of the filled message (the quote header, the body, the signature) | P-font | family recorded; `ok` true; equal to a fresh compose of the same language | OPEN |
| WK-43.08 | Mac, Linux | Close an untouched filled reply (Discard), and kill the app during the shell: no question, no draft in Drafts, no recovery offer at the next start; type one letter, wait 10 s, kill: the recovery offer has the letter | Drafts list, the start screen | as stated | OPEN |

## 44. WP8e (coder, `feature/v107-wp8`, W8.12): Search in Settings

What changed that is visible: a box at the top of the Settings navigation (sticky; `Search` icon 14 px, a clear button once there is text; 13 px text, 32 px high, `type="text"`); while it holds text the results (`div role="option"` rows: the label with the matched part in weight 650, at most 2 lines, a place line with an ellipsis) take the place of the navigation entries; Enter or a click on a result shows the page, scrolls the target to the middle of `.settings-body`, lights it (`.set-hit`: fill `--accent-soft`, 4 px inset bar, 2 px outline, 2.4 s, faded in the last 0.6 s unless reduced motion) and focuses its first control; the same light now also marks the deep link `focus=loadRemote` (the old `.flash` is gone). Ctrl+F (Cmd+F on a Mac) and `/` (outside a field) go to the box. All new CSS is in `src/settingsSearch.css`, loaded with the Settings chunk.

Engine features relied on: `position: sticky` (WebKit 13 = macOS 10.15, WebKitGTK 2.30), `-webkit-line-clamp` with `-webkit-box` (all WebKit), `:placeholder-shown` (all WebKit; it takes the clear button's padding in only once there is text), `outline` + `outline-offset` + `box-shadow: inset` (the outline stays in Windows high contrast; on WebKit before Safari 16.4 / WebKitGTK 2.42 the outline is a rectangle that ignores `border-radius`: harmless), `@keyframes` on `outline-color`, `@media (prefers-reduced-motion: no-preference)` for the fade (reduced motion = a static highlight that a timer removes at 2.4 s), `scroll-padding-top` on the navigation (Safari 14.1+; older engines ignore it, the arrow keys use the manual arithmetic in `SettingsSearch.tsx`), RegExp Unicode property escapes `\p{L}` / `\p{M}` / `\p{Script=Han}` and `String.prototype.normalize` (Safari 11.1+, WebKitGTK 2.20+) for the folding, `ResizeObserver` (Safari 13.1+) for the 800 ms re-centring, `MutationObserver` (the test only). Not used: `scrollIntoView({ behavior })` (the scroll is `scrollTop` arithmetic, so no `behavior` value that WebKit 14 might refuse), `:has()`, `inert`, `clamp()`, `dvh`, `color-mix()` (only the existing tokens `--bg2 --bg3 --border --accent --accent-soft --accent-text --muted`).

Probes (DOM only, through the test bridge `/eval` of the Settings window, or the Settings dialog of `main`; the expressions are printed by `node scripts/lib/settings-search-probe.mjs` (state) and `node scripts/lib/settings-search-probe.mjs hit [id]` (the lit setting); both answer a JSON string):
- P-state: `box` { value, focused, type, role, expanded, placeholderPx (the placeholder measured in the box's own font), roomPx, fits, fontFamily, fontSize, ring { outlineStyle, boxShadow, borderColor }, clearVisible, nativeCancel }, `nav` { sticky, top, scrollTop }, `options` [{ label, place, lines, clamped, bold, boldWeight, placeEllipsis, width, scrollWidth, active }], `none`, `live`.
- P-hit: { id, hit, outline { style, width, color }, bar (box-shadow), background, animation, centreOffsetPx, scrollTop, focus { inside, tag, id } }.
- P-regex (any console): `JSON.stringify([/\p{L}/u.test('é'), /\p{Script=Han}/u.test('送'), /\p{M}/u.test('́'), 'Chữ'.normalize('NFD').length, 'ｶﾞ'.normalize('NFKC') === 'ガ'])` -> `[true,true,true,5,true]`.
- Fixtures: the throw-away profile with 2 mailboxes (one Gmail-type, one IMAP); the languages are switched in Settings > General (paste the queries, no input method).

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-44.01 | Mac, Linux | Open Settings, click in the box, then Tab out and back; light and dark | P-state `box.ring`, `box.fontSize` | focused: `boxShadow` is the 3 px ring (not `none`), `borderColor` = the accent; `fontSize` = 13px; `height` = 32; the ring is not cut by the column (the wrapper has 10 px side padding) | OPEN |
| WK-44.02 | Mac, Linux | 960x560, language de (longest placeholder "Einstellungen durchsuchen"), also fr and ru; the box empty | P-state `box.fits`, `placeholderPx`, `roomPx`, `fontFamily` | `fits` = true in all 8 languages with at least 8 px to spare (`roomPx - placeholderPx >= 8`); the computed font family is recorded in the row | OPEN |
| WK-44.03 | Mac, Linux | Type a few letters | P-state `box.type`, `box.clearVisible`; count `.set-clear` | `type` = "text"; exactly one clear button (ours, `.set-clear`) and no native WebKit cancel button (no second "x" in the field); Esc clears the text and Settings stays open | OPEN |
| WK-44.04 | Mac, Linux | Type `undo send`, press Enter | P-hit (right after Enter, and 2.6 s later) | `outline.style` = "solid", `outline.width` = 2px, `bar` contains "inset" and "4px", `background` is the accent-soft tint; with motion `animation` = "set-hit-fade"; after 2.6 s the probe finds no `.set-hit`; `centreOffsetPx` within +-24 (or the page is scrolled to its edge); `focus.inside` = true | OPEN |
| WK-44.05 | Mac, Linux | Type `a`; at 960x560 in ru and de: the results | P-state `options[].lines`, `clamped`, `placeEllipsis`, `width`/`scrollWidth` | every `lines` <= 2; a label that needs more is `clamped` with the text cut by the clamp (`scrollWidth - width <= 1`, no overflow); a long place line shows an ellipsis and its full text is in the tooltip | OPEN |
| WK-44.06 | Mac, Linux | Type `delai` in fr / `reply` in en | P-state `options[0].bold`, `boldWeight` | the matched part is in a `<b>` (e.g. "Délai"), computed weight 650; it is visibly bolder than the rest (on a system font with only regular and bold faces WebKit paints 700, which is still bolder: check by eye and record the family) | OPEN |
| WK-44.07 | Mac, Linux | Many mailboxes (add 6 stub accounts) so the navigation scrolls; scroll it 120 px with the wheel / trackpad, then type | P-state `nav.sticky`, `nav.top` | `sticky` = "sticky"; `top` = 0 while `scrollTop` > 0 (the box does not move); the results start under the box and the first one is not hidden by it | OPEN |
| WK-44.08 | Mac | Cmd+F with the focus on a switch, on a button and in the signature editor; `/` on a button and in a text field | P-state `box.focused`, `value` | Cmd+F: `focused` = true with the text selected, no system find bar; `/` on a button: focused; `/` in a field: typed into the field | OPEN |
| WK-44.09 | Linux | Ctrl+F and `/` as above; Esc, Esc, Esc | P-state | as WK-44.08; Esc (text) clears, Esc (empty) gives the focus back, the third Esc closes Settings | OPEN |
| WK-44.10 | Mac, Linux | Reduce motion on (macOS: Accessibility > Display > Reduce motion; Linux/KDE: animation speed instant): Enter on a result; then the "Open settings" link of the remote-pictures banner | P-hit | `animation` = "none" with the outline and bar still painted for about 2.4 s, then gone; the banner link lights `#set-loadRemote` | OPEN |
| WK-44.11 | Mac, Linux | Jump to a setting near the bottom of a long page (Composing > Mini toolbar) and to one on a page that loads a list (Encryption > Remember passphrases) | P-hit twice, 1 s apart | the second reading equals the first (within 2 px) or is the centred one: the 800 ms re-centring keeps the target in view when the page above it grows; `focus.inside` = true | OPEN |
| WK-44.12 | Mac, Linux | Folding in the engine: P-regex in the console of the Settings window; then type `chu ky` (vi), `delai` (fr), `grosse` (de), `учетн` (ru), `ぶろっく` (ja), `ＡＩ` (en) | P-regex; P-state `options` | P-regex answers `[true,true,true,5,true]`; each query lists the setting named in AC-8.12.14 | OPEN |
| WK-44.13 | Mac, Linux | Light and dark, the blue accent and a custom accent: the active option (arrow keys) and the chosen option after a jump | P-state `options[].active`; screenshot | the active option has the 3 px inset bar and the `--bg3` fill; the bar is visible in a greyscale screenshot; contrast of label and place line >= 4.5:1 | OPEN |

## 48. fix44 (coder, `feature/v107-fix44`, D-103 owner): a dark mail is written with its dark rules in it; its frame never has its elements listed

What changed (no visible change is intended): `src/darkMail.ts` `taggedMailDocument(mail, base)` and `setMailDark`, `src/components/ReadingPane.tsx` (the write effect, the link titles). Mac QA A/B on fix42: the walk ran only twice in 40 pairs, and the leak was `elementsOf(doc)` (`[documentElement, ...body.querySelectorAll("*")]`) in `setMailDark` on the MESSAGE frame: a NodeList and a JS wrapper for each of ~4,400 elements keeps native memory per document alive after the frame is removed (WebKit / WKWebView, WebKitGTK). Now the hidden frame's walk (it already sets `data-hm` on its own elements) is serialized as one string (`<!doctype html>` + `documentElement.outerHTML`, with the sheet as `<style id="hm-dark-sheet">` and the mail's own CSP put back in the meta) and the message frame is written from THAT string; `setMailDark` then only finds the sheet by its id and switches the class on the root. The string is cached per mail (last 8 mails, at most 8 million characters). Link titles ("show the real target") are set on `mouseover` of the link instead of by a loop over every link. Left on purpose: the pictures of a mail are still listed (logo chip check, `doc.images` for the load listeners; a handful, counted in `frameWrappers`); a mail that was written plain and is switched to Dark afterwards (theme switch with the mail open) still takes the old per-element path once per switch (`frameWrappers` grows by its element count); the scratch frame itself still lists elements once per NEW mail (not per selection).

Engine features relied on: `outerHTML` serialization and re-parse of the sanitized mail (the sanitizer's output is already a serialization, so the round trip is stable; `<pre>` / `<textarea>` with a leading newline and namespaces are the usual suspects: eyes on a mail with `<pre>`), `getElementById` in a frame document, `document.open / write / close`. No CSS, no new API.

Probes (bridge `/eval`): P-stats `JSON.stringify(window.__darkMail)` now also has `tagged` (selections written from the tagged text) and `frameWrappers` (elements of a message frame our dark code listed or wrapped). P-baked `(()=>{const d=document.querySelector('.msg-frame').contentDocument;return JSON.stringify({sheet:!!d.getElementById('hm-dark-sheet'),tagged:d.querySelectorAll('[data-hm]').length,csp:d.querySelector('meta[http-equiv="Content-Security-Policy"]').content.slice(0,60),doctype:!!d.doctype})})()`. P-look of section 46 is unchanged.

| ID | Platform | Look at | Probe | PASS (numbers) | Status |
|---|---|---|---|---|---|
| WK-44b.01 | Mac, Linux | The 40-pair Dark loop of the Mac QA (2 MB mail and a short one, fresh app, OS Dark, stored dark, 12 s idle before the reading), also in a reader window | footprint of the main page's WebContent before / after, P-stats | growth per pair under 0.2 MB (fix42: +196 MB in 40 pairs); `inFrame` = 0; `tagged` grows by one per selection; `frameWrappers` grows by at most the number of pictures in the two mails per selection (not by 4,400) | OPEN |
| WK-44b.02 | Mac, Linux | The look: the 2 MB mail, a newsletter with cards, a mail with `<pre>`, first visit and second visit in Dark | P-look, P-baked, screenshots | the same `len`, `rules`, `tagged`, `tags` as section 46 (WK-42b.03); P-baked: `sheet` true, `csp` starts with `default-src 'none'; img-src`, `doctype` true; screenshots equal to fix42 | OPEN |
| WK-44b.03 | Mac, Linux | Hover a link in a mail | `document.querySelector('.msg-frame').contentDocument.querySelector('a[href]').title` before and after the pointer is over it | empty (or the mail's own) before, equal to the `href` after; the tooltip shows the real target | OPEN |
| WK-44b.04 | Mac, Linux | Theme switch with a mail open (Light to Dark and back) | P-stats | the mail recolours in place (no reload, scroll position kept); `frameWrappers` grows once by the element count at the first switch to Dark of a plain-written mail (known remainder) | OPEN |

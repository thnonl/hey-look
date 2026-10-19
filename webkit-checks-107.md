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

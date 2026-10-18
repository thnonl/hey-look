# Hey Look! test bridge (debug builds only)

A remote control for QA: run JavaScript in a window, click / type / press keys by selector, read the console, list the windows and take a
picture of a window. It exists because WKWebView (macOS) has no remote debugging port; the Windows QA gets the same things from CDP.

Source: `src-tauri/src/testbridge/`. The client is `scripts/test-bridge-client.mjs`; the checks are `scripts/test-test-bridge.mjs`
(add `--exe=<debug build>` for a real run) and `cargo test --lib testbridge`.

## Safety rules (what the code guarantees)

* **Debug builds only.** The module is `#[cfg(debug_assertions)]`. A release build (the installers, the owner's installed app) has no bridge, no
  bridge string and no command for it. The release workflow searches the built app for `HEYLOOK_TEST_BRIDGE` and fails if it finds it.
* **Off by default.** It runs only when the environment variable `HEYLOOK_TEST_BRIDGE` is a port number (`0` = pick a free port). Anything else
  (empty, `1abc`, `true`, `65536` ...) = off, and an off bridge writes nothing to the log.
* **Loopback only.** Listens on `127.0.0.1` (never `0.0.0.0`, never `::`). Every request needs the token and a `Host` of `127.0.0.1:<port>` or
  `localhost:<port>`; a request with an `Origin` of a web page is refused; there are no CORS headers; bodies are limited to 1 MB; one request at a
  time per window.
* **A random token per run** (32 bytes from the operating system, 64 hex characters), written to `test-bridge.json` in the data folder
  (`{"port","token","pid","started"}`, mode 0600 on macOS / Linux, created at start, removed when the app ends cleanly) and, as one line, to `startup.log`:
  `test bridge: listening on 127.0.0.1:<port>, token <64 hex>`. The line is kept when `startup.log` reaches its size cap and starts over (it is written
  again at the top); before this, a long session could lose it.
* **No command for the page.** Scripts go in through the web view's own script call and the answers come back through its completion handler.
  No file system access, no shell, no Rust commands: only the endpoints below.
* QA debug builds have their own identifier (for example `thnonl.heylook.qa.bridge`) and data folder (`HEYLOOK_DATA_DIR`), so a run never touches
  the installed app's data, and the installed release app cannot be driven.

## Start

```
# Windows (PowerShell)
$env:HEYLOOK_TEST_BRIDGE = "0"; $env:HEYLOOK_DATA_DIR = "C:\qa\data"; & ".\hey-look.exe"
# macOS / Linux
HEYLOOK_TEST_BRIDGE=0 HEYLOOK_DATA_DIR=$HOME/qa-data ./hey-look      # macOS: open the binary inside the .app: ".../Hey Look!.app/Contents/MacOS/hey-look"
```

Read the port and token from `test-bridge.json` in the data folder (every start writes a new token and a new file):

```
cat "$HEYLOOK_DATA_DIR/test-bridge.json"
# {"port":53211,"token":"3f9a...(64 hex)","pid":4242,"started":"2026-10-18T10:00:00+00:00"}
```

The same line is in `startup.log` (and on stderr): `grep "test bridge: listening" "$HEYLOOK_DATA_DIR/startup.log" | tail -1`. The client (`connection(dir)`)
tries `test-bridge.json`, then `startup.log`, then `stderr.log`. A `test-bridge.json` that is left after a crash points at a process that is gone: check `pid`.

On macOS the data folder is the one named by `HEYLOOK_DATA_DIR`; without it a debug build refuses the real data and uses a test folder (it prints
which on stderr). Always set it.

## Protocol

HTTP/1.1, JSON. Every request: `Authorization: Bearer <token>` (or `X-Bridge-Token: <token>`). `window` is a label: `main`, `reader-1`,
`compose-2` ... (`GET /windows` lists them; default `main`). Answers: `{"ok":true,...}` or `{"ok":false,"error":"..."}`. A script that throws, or
does not finish in time, is HTTP 200 with `ok:false`; a refused request is 4xx/5xx with `{"ok":false,"error":...}`.

| Request | Answer |
|---|---|
| `GET /windows` | `[{label,title,visible,focused,x,y,width,height,logicalX,logicalY,logicalWidth,logicalHeight,scale,kind}]` (`kind`: main, compose, reader; x/y/width/height are physical pixels of the outer frame; `logical*` = physical / `scale`, the size in the points / CSS pixels the person thinks in: 1920 x 1120 physical at scale 2 is 960 x 560) |
| `POST /eval {window, js, timeoutMs?:5000, awaitPromise?:true}` | `{ok:true,value}`. `js` is **one expression** (`document.title`; one line, no `;`, no `return`) **or the body of an async function** (use `return`). **A script of several statements (`const a = ...; a.length`, a `;` anywhere, a new line) is a function body and must `return` its value: without `return` the answer is `value: null`.** Promises are awaited. `value` is JSON (DOM nodes become `[div#id.class]`, cycles `[Circular]`, `undefined` `null`), at most 1 MB. `timeoutMs` 100..60000. `awaitPromise:false` runs a plain function (no `await`) and does not wait. |
| `POST /click {window, selector? \| x,y?, index?, button?:"left", double?:false}` | `{ok:true,target:{tag,id,class,text},x,y,overlay}`. Scrolls the element into view, takes its centre, uses `elementFromPoint` there (an overlay that covers it is hit and reported: `overlay:true`), sends pointerdown, mousedown (moves the focus like a real press), pointerup, mouseup, click (`right`: contextmenu; `double`: a second round and dblclick). In editable text the caret goes where the press was. `x,y` are CSS pixels of the viewport. `index` picks the n-th match of the selector. A native `<select>` popup cannot be opened by script: use `/type` with the option. |
| `POST /type {window, text, selector?, clear?}` | `{ok:true,target,via:"value"\|"execCommand"}`. Types at the caret of the focused element (or of `selector`, which is focused first). `input` / `textarea`: the native value setter plus `beforeinput` / `input` events, so React sees it. contenteditable (the editor of the compose window): `document.execCommand('insertText')` (new lines: `insertParagraph`), so ProseMirror registers it. `select`: picks the option whose value or text is `text`, then fires input and change. `clear:true` replaces the content. |
| `POST /key {window, key, ctrl?, shift?, alt?, meta?}` | `{ok:true,target,defaultPrevented,emulated}`. keydown, keypress (printable keys and Enter), keyup on `document.activeElement`. `key`: `Enter Tab Escape Backspace Delete Space ArrowUp ArrowDown ArrowLeft ArrowRight Home End PageUp PageDown F1-F12` or one character. Synthetic key events have no browser default action, so a few are emulated and named in `emulated`: Tab / Shift+Tab move the focus, Enter or Space click a button / link / checkbox, Enter submits a form from an input and adds a new line in a textarea or editor, Backspace / Delete delete, a printable character is typed. |
| `GET /console?window=main&since=0` | `{ok:true,last,entries:[{n,t,level,text}]}`: the last 500 `console.log/info/warn/error/debug` entries and `window.onerror` / `unhandledrejection` of the page since its last load (entry numbers only go up; pass the `last` you saw as `since`). |
| `GET /snapshot?window=main` | `image/png` of the window's web content. macOS: `WKWebView takeSnapshot`; Windows: `CapturePreview`. Linux: HTTP 501 with the reason. A hidden or minimised window may give an error or a blank picture. |

Notes:

* The page's content security policy forbids `eval`; the bridge pastes your script into the text it runs, so `eval(...)` / `new Function(...)`
  **inside your script** will fail with the page's CSP error (everything else works).
* Scripts run in the page's main world: `window.__TAURI_INTERNALS__.invoke('command', {...})` works for the commands that window may call.
* A syntax error in `js` shows up as `ok:false` ("the script failed before it could answer ..." on Windows, the WebKit message on macOS).
* The window must have loaded a page. A pop-out is created hidden and shown when its page is ready; eval works on hidden windows.

## Example session (curl)

```
PORT=53211; TOKEN=3f9a...
H="Authorization: Bearer $TOKEN"
curl -s -H "$H" http://127.0.0.1:$PORT/windows
curl -s -H "$H" -d '{"window":"main","js":"document.title"}' http://127.0.0.1:$PORT/eval
curl -s -H "$H" -d '{"window":"main","js":"return document.documentElement.lang"}' http://127.0.0.1:$PORT/eval
curl -s -H "$H" -d '{"window":"main","selector":"button[aria-label=\"Compose\"]"}' http://127.0.0.1:$PORT/click
curl -s -H "$H" "http://127.0.0.1:$PORT/console?window=main&since=0"
curl -s -H "$H" "http://127.0.0.1:$PORT/snapshot?window=main" -o main.png
```

## Example session (Python 3)

```python
import json, re, urllib.request
info = json.load(open("/path/to/data/test-bridge.json"))     # {"port", "token", "pid", "started"}
port, token = info["port"], info["token"]
def call(method, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=70) as r:
        data = r.read()
        return data if r.headers.get_content_type() == "image/png" else json.loads(data)
print(call("GET", "/windows"))
print(call("POST", "/eval", {"window": "main", "js": "document.title"}))
print(call("POST", "/click", {"window": "main", "selector": "button[aria-label='Compose']"}))
open("main.png", "wb").write(call("GET", "/snapshot?window=main"))
```

## Example session (Node, `test-bridge-client.mjs`)

```js
import { connection, bridge } from "./scripts/test-bridge-client.mjs";
const b = bridge(connection("/path/to/data"));           // the data folder: test-bridge.json, else startup.log, else stderr.log
console.log(await b.list());
console.log(await b.evalIn("main", "document.title"));
await b.click("main", "button[aria-label='Compose']");              // opens a compose pop-out (a real click on the real button)
const w = (await b.list()).find((x) => x.kind === "compose");
await b.type(w.label, "Hello", "input[aria-label='Subject']");
await b.click(w.label, "[contenteditable=true]");
await b.type(w.label, "first line\nsecond line");
await b.key(w.label, "Tab");
await b.snapshot(w.label, "compose.png");
console.log((await b.console(w.label)).entries);
```

Command line: `node scripts/test-bridge-client.mjs <data folder> list`, `... eval main "document.title"`, `... click main "#send"`, `... type main "text" "input"`,
`... key main Enter`, `... console main 0`, `... snapshot main out.png`.

## Mac QA: steps

1. Get the DEBUG build for macOS (a test build of the release workflow with a test version is a debug build; a normal release is not and has no
   bridge). It must have its own identifier so the single-instance plug-in does not hand the start to an installed Hey Look!.
2. `export HEYLOOK_DATA_DIR=$HOME/qa-data HEYLOOK_TEST_BRIDGE=0` and start the binary from the terminal:
   `"/path/Hey Look!.app/Contents/MacOS/hey-look"` (a binary started by `open` does not get the shell's variables).
3. `cat $HEYLOOK_DATA_DIR/test-bridge.json` gives the port and the token (`startup.log` has the same as a line).
4. Use curl / Python / `test-bridge-client.mjs` as above. Prefer `click` by selector to clicking by screen coordinates; use `eval` to read what is on the
   screen (`document.body.innerText`, `getComputedStyle`, the language `document.documentElement.lang`), `snapshot` for a picture,
   `console` for page errors.
5. Report anything the bridge could not do (macOS code was only type-checked off a Mac): `snapshot` of a hidden window, `eval` errors, a
   popover that does not react to the synthetic events.

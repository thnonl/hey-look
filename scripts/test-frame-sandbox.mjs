// Checks src/frameSandbox.ts. Run: node --experimental-strip-types scripts/test-frame-sandbox.mjs
import assert from "node:assert/strict";
import { frameCsp, frameSandbox, isWebKit } from "../src/frameSandbox.ts";

const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const linux = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
assert.equal(frameSandbox(edge), "allow-same-origin allow-modals", "Chromium keeps scripts forbidden");
assert.match(frameSandbox(mac), /allow-scripts/, "WebKit needs it for the click hooks");
assert.match(frameSandbox(linux), /allow-scripts/);
assert.equal(frameSandbox(""), "allow-same-origin allow-modals");
// the engine test the PDF frame (src/pdfFrame.ts) shares: Chromium (WebView2) is not WebKit, Safari's engine is
assert.equal(isWebKit(edge), false);
assert.equal(isWebKit(mac), true);
assert.equal(isWebKit(linux), true);
assert.equal(isWebKit(""), false);
// the CSP always bans scripts, so allow-scripts runs nothing
assert.ok(frameCsp("default-src 'none'; img-src data:").endsWith("script-src 'none'"));
console.log("frame-sandbox: all checks passed");

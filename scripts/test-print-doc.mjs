// 1.0.7 W5.3 (REQ-5.3.1, REQ-5.3.2, REQ-5.3.5, REQ-5.3.6, AC-5.3.4 static part), no browser. Run: node --experimental-strip-types scripts/test-print-doc.mjs
// The document that macOS prints (src/printDoc.ts): the message as the frame shows it, always light, with a CSP that forbids scripts, without the rules that only the frame needs and
// without any app CSS; the wiring in the pages (menus, Cmd+P, confidential mail) and the three places of the command.
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildPrintDoc, printCsp } from "../src/printDoc.ts";
import { MAIL_FRAME_CSS, MAIL_FRAME_SPIN_CSS } from "../src/mailFrameCss.ts";

let n = 0;
const check = (label, fn) => {
  try {
    fn();
  } catch (e) {
    e.message = `${label}: ${e.message}`;
    throw e;
  }
  n++;
};
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const CSP_BLOCKED = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'";
const CSP_ALLOWED = "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:; script-src 'none'";
const N1 = `<div><style>body{background:#fff}@media (prefers-color-scheme: dark){body{background:#000;color:#eee}}</style><p>Hello <b>world</b></p>` +
  `<picture><source media="(prefers-color-scheme: dark)" srcset="data:image/png;base64,AAAA"><img src="data:image/png;base64,BBBB"></picture>` +
  `<button class="hl-ph">Show pictures</button></div>`;

check("the document is a full page with the message, the subject as title (escaped) and a UTF-8 charset", () => {
  const d = buildPrintDoc({ html: N1, csp: CSP_BLOCKED, subject: "Q3 <report> & plans" });
  assert.ok(d.startsWith("<!doctype html><html><head><meta charset=\"utf-8\">"));
  assert.ok(d.includes("<title>Q3 &lt;report&gt; &amp; plans</title>"));
  assert.ok(d.includes("<p>Hello <b>world</b></p>") && d.includes("Show pictures"), "blocked pictures print as their placeholders");
  assert.ok(d.endsWith("</body></html>"));
});

check("the CSP keeps the frame's own rules and forbids scripts, connections and forms (AC-5.3.8: a blocked picture makes no request)", () => {
  const d = buildPrintDoc({ html: N1, csp: CSP_BLOCKED, subject: "s" });
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(d);
  assert.ok(meta, "a CSP meta");
  const csp = meta[1];
  assert.ok(csp.includes("default-src 'none'") && csp.includes("img-src data:") && !csp.includes("https:"), csp);
  assert.ok(csp.includes("script-src 'none'") && csp.includes("connect-src 'none'") && csp.includes("form-action 'none'"), csp);
  assert.equal((csp.match(/script-src/g) ?? []).length, 1, "script-src once");
  // a frame CSP that allows pictures keeps that (pictures as currently allowed), still no script
  const a = printCsp(CSP_ALLOWED);
  assert.ok(a.includes("img-src data: https: http:") && a.includes("script-src 'none'"), a);
  // whatever the input says about scripts, the result forbids them
  assert.ok(printCsp("default-src 'none'; script-src 'unsafe-inline'; connect-src https:").includes("script-src 'none'"));
  assert.ok(!printCsp("default-src 'none'; script-src 'unsafe-inline'; connect-src https:").includes("unsafe-inline"));
  assert.ok(!printCsp("default-src 'none'; script-src 'unsafe-inline'; connect-src https:").includes("https:"));
  assert.ok(printCsp("").includes("script-src 'none'"));
});

check("the presentation is always light (REQ-5.3.2, AC-5.3.4) and the mail's own dark-scheme rules mean light", () => {
  const d = buildPrintDoc({ html: N1, csp: CSP_BLOCKED, subject: "s" });
  assert.ok(d.includes("--hm-bg:#ffffff") && d.includes("--hm-fg:#242424") && !d.includes("hm-dark") && !d.includes("hm-pend"), "light variables, no dark class");
  assert.ok(!/@media[^{]*prefers-color-scheme/i.test(d), "no prefers-color-scheme query is left");
  assert.ok(!/<source[^>]*media="\(prefers-color-scheme/i.test(d), "the picture source has a constant condition");
});

check("a loading or failed picture box prints as a quiet box (UX-1, BUG-2)", () => {
  const d = buildPrintDoc({ html: '<span class="hl-bp hl-bpx" data-state="loading"><span class="hl-bp-ico"><span class="hl-spin"></span></span><span class="hl-bp-main">Showing picture…</span></span>', csp: CSP_BLOCKED, subject: "s" });
  for (const rule of [".hl-bp[data-state] .hl-bp-main", ".hl-bp[data-state] .hl-bp-sr{display:none!important}", ".hl-bp[data-state] .hl-bp-ico{visibility:hidden}", ".hl-bp[data-state].bad{border-color:#9aa3af"]) assert.ok(d.includes(rule), rule);
  assert.ok(!d.includes("@keyframes hlspin"), "the spinner animation is not in the print");
});

check("no rule that only the frame needs, and no app CSS (REQ-5.3.2)", () => {
  const d = buildPrintDoc({ html: "<p>x</p>", csp: CSP_BLOCKED, subject: "s" });
  assert.ok(!d.includes("html,body{overflow:hidden!important"), "the trailing overflow:hidden rule of the frame is not in the print");
  assert.ok(!d.includes("min-height:0!important"), "no frame height rule");
  assert.ok(!d.includes("hl-spin") && !d.includes(MAIL_FRAME_SPIN_CSS.trim().slice(0, 20)), "no picture spinner");
  assert.ok(d.includes(MAIL_FRAME_CSS), "the same mail rules as the frame");
  for (const appRule of [".rp-", ".fp-", ".ml-row", ".modal", ".icon-btn", ".toolbar", "--bg2", "--accent"]) assert.ok(!d.includes(appRule), `app CSS ${appRule} in the print`);
  assert.ok(!d.includes("<script") && !d.includes("<link") && !d.includes("<base"), "nothing that loads");
  assert.equal((d.match(/<style>/g) ?? []).length, 1, "one style of ours (the mail's own styles come with its html)");
});

check("the print document is no bigger than the mail plus a fixed frame of a few KB", () => {
  const d = buildPrintDoc({ html: "", csp: CSP_BLOCKED, subject: "" });
  assert.ok(d.length < 4400, String(d.length)); // (4000 before the quiet box of a loading picture, 1.0.12)
});

check("the frame uses the shared CSS (one place for the mail rules)", () => {
  const rp = read("src/components/ReadingPane.tsx");
  assert.ok(rp.includes("${MAIL_FRAME_CSS}") && rp.includes("${MAIL_FRAME_SPIN_CSS}") && !rp.includes("body{font:14px/1.5"), "the frame takes the rules from mailFrameCss.ts");
  assert.ok(!/from "\.\//.test(read("src/mailFrameCss.ts")), "mailFrameCss.ts imports nothing");
});

check("REQ-5.3.1 / 5.3.5: Print is in both More menus on every system, disabled for confidential mail, and macOS goes through the backend", () => {
  const rp = read("src/components/ReadingPane.tsx");
  assert.ok(!rp.includes('osNow() === "macos" ? [] : [{ label: t("reading.msg.print")'), "no more hidden entry on macOS (pane)");
  assert.ok(rp.includes('disabled: conf || printing, onClick: () => void (osNow() === "macos" ? printFrameNative(frameRef.current'), "pane: disabled when confidential, native on macOS");
  assert.ok(rp.includes("setPrintSource(frameRef.current"), "the frame says what it was built from");
  const rv = read("src/popout/ReaderView.tsx");
  assert.ok(!rv.includes('osNow() === "macos" ? [] : [{ label: t("reading.msg.print")'), "no more hidden entry on macOS (reader)");
  assert.ok(rv.includes('{ label: t("reading.msg.print"), disabled: conf || printing, onClick: printLast }'));
  assert.ok(rv.includes('case "print": return conf ? undefined : printLast();'), "Ctrl+P does nothing for confidential mail");
  assert.ok(rv.includes('if (osNow() === "macos") return void printOpenMessage();'), "macOS prints through the backend");
  // W5.11: on macOS Cmd+P is the File > Print… item of the menu bar; the page takes no second Cmd+P (no double print)
  const key = read("src/popout/readerLogic.ts");
  assert.ok(key.includes('!ctx.mac && cmd && !e.altKey && !e.shiftKey && k.toLowerCase() === "p") return "print";'), "Ctrl+P is a reader key, not on macOS");
});

check("REQ-5.3.6: the command is in the three places, and in the reader's capability (not in the other pop-outs)", () => {
  assert.ok(/printHtml:\s*\(html: string, title: string\) => invoke<void>\("print_html", \{ html, title \}\)/.test(read("src/api.ts")));
  const lib = read("src-tauri/src/lib.rs");
  assert.ok(lib.includes("async fn print_html(") && /invoke_handler[\s\S]*?\bprint_html,/.test(lib));
  assert.ok(read("src-tauri/build.rs").includes('"print_html"'));
  const caps = (f) => JSON.parse(read(`src-tauri/capabilities/${f}.json`)).permissions;
  assert.ok(caps("default").includes("allow-print-html") && caps("popout").includes("allow-print-html"));
  for (const f of ["settings", "event", "search", "scheduled"]) assert.ok(!caps(f).includes("allow-print-html"), `${f} window must not print`);
});

check("REQ-5.3.4: the failure is a toast of the window that asked, in 8 languages", () => {
  const nat = read("src/printNative.ts");
  assert.ok(nat.includes('toast(t("reading.msg.printFailed"))') && nat.includes("usePrinting.getState().on"), "toast, and one print at a time on the page too");
  const texts = { en: "src/i18n/ns/reading.ts" };
  for (const l of ["vi", "fr", "zh-Hans", "es", "ja", "de", "ru"]) texts[l] = `src/i18n/locales/${l}/reading.ts`;
  for (const [l, f] of Object.entries(texts)) assert.ok(/"reading\.msg\.printFailed": "[^"]{8,}"/.test(read(f)), `${l}: printFailed`);
});

console.log(`ok - test-print-doc (${n} checks)`);

#!/usr/bin/env node
// The test server of Unsubscribe (scripts/lib/unsub-server.mjs, 1.0.7 fix18, D-065) does what the QA rows of DEC-021 rely on, in each of its four modes,
// measured with node's own HTTPS client:
//   trusted     a client that trusts the server's CA gets 200 (and 500 when asked) for the POST of RFC 8058 and the page for a GET; the request is recorded with
//               its method, content type and body `List-Unsubscribe=One-Click`
//   selfsigned  a client that does not trust it fails the handshake (DEPTH_ZERO_SELF_SIGNED_CERT) and no request is recorded
//   closed      the connection is refused at once (ECONNREFUSED)
//   blackhole   the connection is accepted and the request is never answered (the client's own timeout ends it)
// and the command line prints its ready line and one line per request.
//   node scripts/test-unsub-server.mjs [--require-openssl]
// The TLS modes need the `openssl` command; without it they are skipped, unless --require-openssl (CI) is given.
import https from "node:https";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { haveOpenssl, MODES, startUnsubServer } from "./lib/unsub-server.mjs";

const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };
const requireOpenssl = process.argv.includes("--require-openssl");

/** One request; resolves { status, body } or { error: code } or { timeout: true } after `ms`. */
function request(url, { method = "POST", ca, ms = 4000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({ method, host: u.hostname, port: u.port, path: u.pathname, ca, headers: { "Content-Type": "application/x-www-form-urlencoded" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(ms, () => { resolve({ timeout: true }); req.destroy(); });
    req.on("error", (e) => resolve({ error: e.code ?? String(e.message) }));
    if (method === "POST") req.write("List-Unsubscribe=One-Click");
    req.end();
  });
}

ok(JSON.stringify(MODES) === JSON.stringify(["trusted", "selfsigned", "closed", "blackhole"]), `the four modes (${MODES})`);

// closed: always testable
{
  const s = await startUnsubServer({ mode: "closed" });
  const r = await request(s.url);
  ok(r.error === "ECONNREFUSED", `closed: connection refused (${JSON.stringify(r)})`);
  ok(s.requests.length === 0, "closed: no request recorded");
  await s.close();
}
// blackhole: the connect works, nothing answers
{
  const s = await startUnsubServer({ mode: "blackhole" });
  const t0 = Date.now();
  const r = await request(s.url, { ms: 1200 });
  ok(r.timeout === true, `blackhole: no answer, the client's timeout ends it (${JSON.stringify(r)})`);
  ok(Date.now() - t0 >= 1100, `blackhole: it held for the whole timeout (${Date.now() - t0} ms)`);
  ok(s.connections >= 1, `blackhole: the TCP connection was accepted (${s.connections})`);
  await s.close();
}

if (!haveOpenssl()) {
  const msg = "the openssl command is not available: the trusted and selfsigned modes were not tested";
  if (requireOpenssl) failures.push(msg);
  else console.log(`NOTE: ${msg}`);
} else {
  // trusted: CA known
  {
    const s = await startUnsubServer({ mode: "trusted", status: 200 });
    const ca = readFileSync(s.caPath);
    const post = await request(s.url, { ca });
    ok(post.status === 200 && post.body === "ok", `trusted: POST answered 200 (${JSON.stringify(post)})`);
    ok(s.requests.length === 1, `trusted: one request recorded (${s.requests.length})`);
    const q = s.requests[0] ?? {};
    ok(q.method === "POST" && q.path === "/u/test-token-0001" && q.body === "List-Unsubscribe=One-Click" && /x-www-form-urlencoded/.test(q.contentType), `trusted: the POST of RFC 8058 was recorded (${JSON.stringify(q)})`);
    const get = await request(s.url, { method: "GET", ca });
    ok(get.status === 200 && /<h1>Unsubscribe<\/h1>/.test(get.body), `trusted: a GET shows the page (${JSON.stringify(get)})`);
    ok(s.requests.length === 2 && s.requests[1].method === "GET", "trusted: the GET was recorded too (a page opened by the browser)");
    // a client that does not know the CA is refused as for any untrusted certificate
    const stranger = await request(s.url);
    ok(["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(stranger.error), `trusted: without the CA the certificate is not accepted (${JSON.stringify(stranger)})`);
    await s.close();
  }
  // trusted, answering 500
  {
    const s = await startUnsubServer({ mode: "trusted", status: 500 });
    const r = await request(s.url, { ca: readFileSync(s.caPath) });
    ok(r.status === 500, `trusted --status=500: POST answered 500 (${JSON.stringify(r)})`);
    await s.close();
  }
  // selfsigned: the handshake fails, nothing is recorded
  {
    const s = await startUnsubServer({ mode: "selfsigned" });
    const r = await request(s.url);
    ok(r.error === "DEPTH_ZERO_SELF_SIGNED_CERT", `selfsigned: the handshake fails (${JSON.stringify(r)})`);
    await new Promise((res) => setTimeout(res, 100));
    ok(s.requests.length === 0, `selfsigned: no request recorded (${s.requests.length})`);
    ok(s.tlsErrors >= 1, `selfsigned: the refused handshake was counted (${s.tlsErrors})`);
    await s.close();
  }
  // the command line
  {
    const child = spawn(process.execPath, ["scripts/lib/unsub-server.mjs", "--mode=trusted", "--status=200"], { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "inherit"] });
    const lines = [];
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (l) => { try { lines.push(JSON.parse(l)); } catch { /* not ours */ } });
    const until = async (f, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
    try {
      ok(await until(() => lines.some((l) => l.ready)), "cli: the ready line is printed");
      const ready = lines.find((l) => l.ready);
      if (ready) {
        ok(ready.mode === "trusted" && /^https:\/\/127\.0\.0\.1:\d+\/u\//.test(ready.url) && ready.caPath, `cli: ready line has mode, url and caPath (${JSON.stringify(ready)})`);
        const r = await request(ready.url, { ca: readFileSync(ready.caPath) });
        ok(r.status === 200, `cli: the POST is answered (${JSON.stringify(r)})`);
        ok(await until(() => lines.some((l) => l.request?.method === "POST")), "cli: one line per request");
      }
    } finally {
      child.kill(); // (our own child, by handle)
    }
  }
}

if (failures.length) {
  console.error(`FAILED (${failures.length}):\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.log("test-unsub-server: ok");

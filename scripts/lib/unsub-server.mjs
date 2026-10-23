#!/usr/bin/env node
// The test server of Unsubscribe (1.0.7 fix18, D-065, DEC-021). One server, four modes, for the One-Click POST of the app (RFC 8058) and for the page the
// browser opens when the POST fails:
//
//   trusted     HTTPS with a certificate signed by a throw-away CA (the CA file is `caPath`: a client that trusts it, or an OS user store that was told to,
//               gets the answer). A POST answers `status` (default 200), a GET answers a small HTML page. Every request is recorded.
//   selfsigned  HTTPS with a self-signed certificate: the TLS handshake of a client that does not trust it fails, no request is ever recorded
//               (`tlsErrors` counts the refused handshakes).
//   closed      nothing listens on the port (it was free a moment ago): the connection is refused at once.
//   blackhole   the TCP connection is accepted and nothing is ever answered (the connect works, the TLS hello gets no reply): the client's own
//               timeout ends it. (A true black-hole address such as 10.255.255.1 depends on the network; this works anywhere.)
//
// As a module:   const s = await startUnsubServer({ mode: "trusted", status: 200 });  s.url  s.requests  await s.close()
// From a shell:  node scripts/lib/unsub-server.mjs --mode=trusted [--status=200] [--port=0] [--host=127.0.0.1]
//   prints one JSON line {"ready":true,"mode":...,"url":...,"port":...,"caPath":...} and then one {"request":{...}} line per request, until it is stopped.
//
// The certificates are made with the `openssl` command when the server starts (EC P-256, valid for 2 days, in a new folder under the system temp
// folder; nothing is stored in the repository). `haveOpenssl()` says whether the command exists.
import https from "node:https";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MODES = ["trusted", "selfsigned", "closed", "blackhole"];

export function haveOpenssl() {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const openssl = (args, cwd) => execFileSync("openssl", args, { cwd, stdio: "pipe" });
const KEY = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
const SAN = "subjectAltName=DNS:localhost,IP:127.0.0.1";

/** A CA, a server certificate signed by it, and a self-signed one; returns the file names in `dir`. */
function makeCerts(dir) {
  openssl(["req", "-x509", ...KEY, "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=Hey Look test CA", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"], dir);
  openssl(["req", "-new", ...KEY, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=localhost"], dir);
  writeFileSync(path.join(dir, "leaf.ext"), `${SAN}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
  openssl(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "leaf.ext"], dir);
  openssl(["req", "-x509", ...KEY, "-keyout", "self.key", "-out", "self.pem", "-subj", "/CN=localhost", "-days", "2", "-addext", SAN], dir);
}

const PAGE = "<!doctype html><meta charset=utf-8><title>Unsubscribe</title><h1>Unsubscribe</h1><p>This is the test page of the unsubscribe link.</p>";

export async function startUnsubServer({ mode = "trusted", status = 200, host = "127.0.0.1", port = 0, dir } = {}) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}" (${MODES.join(", ")})`);
  const requests = [];
  const out = { mode, host, port: 0, url: "", caPath: "", requests, tlsErrors: 0, connections: 0, close: async () => {}, on: null };
  const record = (r) => { requests.push(r); out.on?.(r); };

  if (mode === "closed") {
    // a port that is free now: bind to 0, read it, let go
    const probe = net.createServer();
    await new Promise((res) => probe.listen(port, host, res));
    out.port = probe.address().port;
    await new Promise((res) => probe.close(res));
  } else if (mode === "blackhole") {
    const sockets = new Set();
    const srv = net.createServer((s) => {
      out.connections++;
      sockets.add(s);
      s.on("error", () => {});
      s.on("close", () => sockets.delete(s));
      // (nothing is read, nothing is written)
    });
    await new Promise((res) => srv.listen(port, host, res));
    out.port = srv.address().port;
    out.close = () => new Promise((res) => { for (const s of sockets) s.destroy(); srv.close(() => res()); });
  } else {
    const certDir = dir ?? mkdtempSync(path.join(os.tmpdir(), "heylook-unsub-"));
    if (!dir) makeCerts(certDir);
    const [key, cert] = mode === "trusted" ? ["leaf.key", "leaf.pem"] : ["self.key", "self.pem"];
    out.caPath = path.join(certDir, "ca.pem");
    const srv = https.createServer({ key: readFileSync(path.join(certDir, key)), cert: readFileSync(path.join(certDir, cert)) }, (req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        record({ method: req.method, path: req.url, contentType: req.headers["content-type"] ?? "", userAgent: req.headers["user-agent"] ?? "", body: Buffer.concat(chunks).toString("utf8"), at: Date.now() });
        if (req.method === "POST") {
          res.writeHead(status, { "Content-Type": "text/plain", "Content-Length": "2" });
          res.end("ok");
        } else {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(PAGE);
        }
      });
    });
    srv.on("tlsClientError", () => { out.tlsErrors++; });
    await new Promise((res) => srv.listen(port, host, res));
    out.port = srv.address().port;
    out.close = () => new Promise((res) => { srv.closeAllConnections?.(); srv.close(() => res()); });
  }
  out.url = `https://${host}:${out.port}/u/test-token-0001`;
  return out;
}

// ---- the command line
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
  if (process.argv.includes("--help")) {
    console.log("node scripts/lib/unsub-server.mjs --mode=trusted|selfsigned|closed|blackhole [--status=200] [--port=0] [--host=127.0.0.1]");
    process.exit(0);
  }
  if (!haveOpenssl() && !["closed", "blackhole"].includes(arg("mode", "trusted"))) {
    console.error("the openssl command is needed for the TLS modes");
    process.exit(2);
  }
  const s = await startUnsubServer({ mode: arg("mode", "trusted"), status: Number(arg("status", "200")), port: Number(arg("port", "0")), host: arg("host", "127.0.0.1") });
  s.on = (r) => console.log(JSON.stringify({ request: r }));
  console.log(JSON.stringify({ ready: true, mode: s.mode, url: s.url, port: s.port, caPath: s.caPath }));
  setInterval(() => {}, 1 << 30); // (the "closed" mode has nothing that keeps the process alive)
}

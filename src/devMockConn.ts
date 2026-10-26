// "Test connection" in the dev preview (src/devMock.ts): the answers of the backend (src-tauri/src/conntest.rs) for scenarios chosen by the host or the password
// that is typed, so the whole form can be driven without a mail server (scripts/test-conn-test-ui.mjs).
//   host        nx.test dns | refused.test | unreach.test | blackhole.test (a timeout after `conntime`, default 20 s) | secure.test | selfsigned.test (certUntrusted unless
//               "trust" is on) | mismatch.test (certName, names imap.example.org, example.org) | expired.test | busy.test | listfail.test (IMAP login ok, LIST fails)
//               | smtp-as-imap.test (as the IMAP host: it answers like SMTP) | imap-as-smtp.test (as the SMTP host) | noauth.test (as the SMTP host) | slow.test (IMAP 3 s, SMTP 1 s)
//               | outlook.office365.com / smtp.office365.com with any password: microsoftPassword
//   password    wrong auth on both | apppw appPassword (IMAP) | toomany tooMany (IMAP) | msft microsoftPassword | smtpoff smtpAuthOff (SMTP) | imapoff | weblogin
//               | smtpwrong IMAP works, the shared SMTP login is refused | unknown unknown (with the password in the text, scrubbed like the backend does) | gmailnormal auth on Gmail hosts
//   anything else works: 12 folders.
// Hash: `conncooldown=<s>` the pause after three failed sign-ins (default 60), `conntime=<ms>` the time of blackhole.test (default 20000).
import { cooldown, type ConnTestReport, type PartReport } from "./connHints";

const hash = () => new URLSearchParams(window.location.hash.slice(1));
const secs = Number(hash().get("conncooldown"));
if (secs > 0) cooldown.seconds = secs;

interface Input { imapHost: string; imapPort: number; imapSsl: boolean; smtpHost: string; smtpPort: number; smtpSecurity: string; tlsInsecure: boolean }

const report = (part: "imap" | "smtp", inp: Input, over: Partial<PartReport>): PartReport => ({
  status: "error", kind: "unknown", host: part === "imap" ? inp.imapHost.trim() : inp.smtpHost.trim(), port: part === "imap" ? inp.imapPort : inp.smtpPort,
  security: part === "imap" ? (inp.imapSsl ? "ssl" : "starttls") : inp.smtpSecurity, certNames: [], detail: "", ms: 0, ...over,
});

/** How long the answer of a part takes in the mock, and what it is. */
function answer(part: "imap" | "smtp", inp: Input, pw: string): { ms: number; r: PartReport } {
  const host = (part === "imap" ? inp.imapHost : inp.smtpHost).trim().toLowerCase();
  const err = (kind: string, detail: string, extra: Partial<PartReport> = {}, ms = 400) => ({ ms, r: report(part, inp, { kind, detail, ...extra }) });
  const base = part === "imap" ? 500 : 300;
  const timeoutMs = Number(hash().get("conntime")) || 20000;
  if (host === "slow.test") return { ms: part === "imap" ? 3000 : 1000, r: report(part, inp, { status: "ok", kind: "ok", folders: part === "imap" ? 12 : undefined }) };
  switch (host) {
    case "nx.test": return err("dns", `cannot resolve ${host}: no such host`);
    case "refused.test": return err("refused", `connect to ${host}:${part === "imap" ? inp.imapPort : inp.smtpPort}: connection refused (os error 10061)`);
    case "unreach.test": return err("unreachable", "connect: network is unreachable");
    case "blackhole.test": return err("timeout", `no answer within 20 s`, {}, timeoutMs);
    case "secure.test": return err("secure", "TLS handshake: wrong version number");
    case "selfsigned.test": if (!inp.tlsInsecure) return err("certUntrusted", "TLS handshake: certificate verify failed: self-signed certificate"); break;
    case "mismatch.test": if (!inp.tlsInsecure) return err("certName", "TLS handshake: certificate verify failed: Hostname mismatch", { certNames: ["imap.example.org", "example.org"] }); break;
    case "expired.test": if (!inp.tlsInsecure) return err("certExpired", "TLS handshake: certificate has expired"); break;
    case "busy.test": return err("busy", "greeting: * BYE too busy");
    case "listfail.test": if (part === "imap") return { ms: base, r: report(part, inp, { status: "warn", kind: "listFailed", detail: "LIST: NO [SERVERBUG] list failed" }) }; break;
    case "smtp-as-imap.test": if (part === "imap") return err("notImap", "greeting: 220 mail.example.test ESMTP ready", { sees: "smtp" }); break;
    case "imap-as-smtp.test": if (part === "smtp") return err("notSmtp", "greeting: * OK IMAP4rev1 ready", { sees: "imap" }); break;
    case "noauth.test": if (part === "smtp") return err("noAuth", "SMTP: No compatible authentication mechanism was found"); break;
    case "outlook.office365.com": case "smtp.office365.com": return err("microsoftPassword", "LOGIN: NO LOGIN failed.");
  }
  switch (pw) {
    case "wrong": return err("auth", `${part === "imap" ? "LOGIN: NO [AUTHENTICATIONFAILED] Invalid credentials" : "SMTP: permanent error (535): 5.7.8 Username and Password not accepted"}`);
    case "gmailnormal": if (/gmail/.test(host)) return err("auth", "LOGIN: NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)"); break;
    case "apppw": if (part === "imap") return err("appPassword", "LOGIN: NO [ALERT] Application-specific password required"); break;
    case "toomany": if (part === "imap") return err("tooMany", "LOGIN: NO [UNAVAILABLE] Too many login failures"); break;
    case "msft": if (part === "imap") return err("microsoftPassword", "LOGIN: NO LOGIN failed."); break;
    case "smtpoff": if (part === "smtp") return err("smtpAuthOff", "SMTP: permanent error (535): 5.7.139 SmtpClientAuthentication is disabled for the Tenant"); break;
    case "imapoff": if (part === "imap") return err("imapOff", "LOGIN: NO [ALERT] Your account is not enabled for IMAP use."); break;
    case "weblogin": if (part === "imap") return err("webLogin", "LOGIN: NO [WEBALERT https://accounts.example.test/signin] Web login required"); break;
    case "smtpwrong": if (part === "smtp") return err("auth", "SMTP: permanent error (535): 5.7.8 Username and Password not accepted"); break;
    case "unknown": return err("unknown", `SMTP: response error: incomplete response •••• (the password was scrubbed)\nsecond line \\x01`);
  }
  return { ms: base, r: report(part, inp, { status: "ok", kind: "ok", folders: part === "imap" ? 12 : undefined }) };
}

/** The mock of `test_connection`: one part, or both. A cancel (`cancel_test_connection`) is the page's: it drops what comes late. */
export function mockTestConnection(a: Record<string, unknown>): Promise<ConnTestReport> {
  const inp = a.input as Input;
  const pw = String(a.passwordValue ?? "");
  const spw = String(a.smtpPassword ?? "") || pw;
  const part = a.part === "imap" || a.part === "smtp" ? a.part : null;
  const run = (p: "imap" | "smtp") => {
    const { ms, r } = answer(p, inp, p === "smtp" ? spw : pw);
    return new Promise<PartReport>((res) => setTimeout(() => res({ ...r, ms }), ms));
  };
  return Promise.all([part !== "smtp" ? run("imap") : null, part !== "imap" ? run("smtp") : null]).then(([imap, smtp]) => ({ imap, smtp }));
}

/** The error of a refused "Add account" in the mock (password `wrong`): the same coded error the backend sends. */
export function mockAccountCheckError(a: Record<string, unknown>): string | null {
  const inp = a.input as Input;
  if (a.passwordValue !== "wrong") return null;
  const r = report("imap", inp, { kind: "auth", detail: "LOGIN: NO [AUTHENTICATIONFAILED] Invalid credentials" });
  const esc = (v: string) => v.replace(/%/g, "%25").replace(/\|/g, "%7C").replace(/:/g, "%3A").replace(/\n/g, "%0A");
  const p = { part: "imap", kind: r.kind, host: r.host, port: String(r.port), sec: r.security, sees: "", names: "", detail: r.detail };
  return `ACCOUNT_CHECK|${Object.entries(p).map(([k, v]) => `${k}=${esc(v)}`).join("|")}: Incoming (IMAP): Sign-in failed. Check the username and password.`;
}

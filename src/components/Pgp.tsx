import {
  BadgeCheck, Copy, FileKey, FileWarning, HardDriveDownload, Info, KeyRound, LoaderCircle, Lock, LockKeyhole, LockOpen, ShieldAlert, ShieldCheck,
  ShieldQuestionMark, ShieldX, TriangleAlert, Trash2, Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorCode, KeyAlgo, KeyInspect, MessageFull, MessageSecurity, PgpKey, SigInfo } from "../api";
import { friendlyError, UnlockReason, useStore } from "../store";
import { fmtDay, fmtFpr, fmtFull, passphraseStrength, shortKey, userName } from "../util";
import { Modal, Switch, useOutside } from "./ui";

// ---------------------------------------------------------------- helpers

const REASON_TITLE: Record<UnlockReason, string> = {
  sign: "Unlock your key to sign",
  decrypt: "Unlock your key to decrypt",
  draft: "Unlock your key to open the draft",
  schedule: "Unlock your key to schedule the message",
};

export const keyName = (k: Pick<PgpKey, "userIds" | "keyId">) => k.userIds[0] ?? `Key ${shortKey(k.keyId)}`;

/** Spoken form of a fingerprint for screen readers: groups of four, spaced. */
const Fpr = ({ fpr, className = "fpr" }: { fpr: string; className?: string }) => (
  <span className={className} aria-label={fmtFpr(fpr)}>{fmtFpr(fpr)}</span>
);

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const showToast = useStore((s) => s.showToast);
  return (
    <button className="link small" onClick={() => void navigator.clipboard.writeText(text).then(() => showToast("Copied", undefined, "success"))}>
      {label}
    </button>
  );
}

/** Ask for the passphrase of a key (unlocks it for the session). Resolves true when it was unlocked. */
export const askUnlock = (fingerprint: string, reason: UnlockReason, label?: string) => useStore.getState().askPassphrase({ fingerprint, reason, label });

// ---------------------------------------------------------------- passphrase prompt (store-driven, like AskHost)

function PassphraseDialog() {
  const p = useStore((s) => s.passphrase)!;
  const resolve = useStore((s) => s.resolvePassphrase);
  const remember = useStore((s) => s.prefs.pgpRemember);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [keep, setKeep] = useState(remember === "session");
  const [wait, setWait] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const unlock = async () => {
    if (!pw || busy || wait > 0) return;
    setBusy(true);
    setErr("");
    try {
      await api.pgpUnlock(p.fingerprint, pw, keep);
      resolve(true);
    } catch (e) {
      const code = errorCode(e);
      if (code === "PGP_LOCKED_OUT") {
        setErr("Too many attempts. Wait 30 seconds.");
        setWait(30);
      } else if (code === "PGP_BAD_PASSPHRASE") setErr("Wrong passphrase. Try again.");
      else setErr(friendlyError(e));
      setPw("");
    } finally {
      setBusy(false);
    }
  };
  // keep the cursor in the field after a wrong try (the input is disabled-free, but focus can be lost on re-render)
  useEffect(() => {
    if (!busy) input.current?.focus();
  }, [busy, err]);

  return (
    <div className="modal-back ask-back" onMouseDown={() => resolve(false)}>
      <div
        className="ask"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pp-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") resolve(false);
          if (e.key === "Enter") void unlock();
        }}
      >
        <h3 id="pp-title">{REASON_TITLE[p.reason]}</h3>
        <p className="muted" style={{ marginBottom: 10 }}>Key {shortKey(p.fingerprint)}{p.label ? ` · ${p.label}` : ""}</p>
        <input
          ref={input}
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          aria-label="Passphrase"
          aria-invalid={!!err}
          aria-describedby={err ? "pp-err" : undefined}
          style={{ width: "100%" }}
          autoComplete="off"
        />
        {err && <div className="field-err" id="pp-err" style={{ marginTop: 6 }}><TriangleAlert size={13} />{err}</div>}
        <div style={{ marginTop: 10 }}>
          <Switch checked={keep} onChange={setKeep} label={remember === "session" ? "Remember until Hey Look! quits" : "Keep unlocked for a few minutes"} />
        </div>
        <div className="ask-actions">
          <button className="btn" onClick={() => resolve(false)}>Cancel</button>
          <button className="btn primary" disabled={!pw || busy || wait > 0} aria-busy={busy} onClick={() => void unlock()}>
            {busy ? <><LoaderCircle size={14} className="spin" /> Unlocking…</> : wait > 0 ? `Wait ${wait}s` : "Unlock"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Renders the passphrase prompt when a feature asked for one. Mount once, next to AskHost. */
export function PassphraseHost() {
  const p = useStore((s) => s.passphrase);
  return p ? <PassphraseDialog key={`${p.fingerprint}:${p.reason}`} /> : null;
}

// ---------------------------------------------------------------- generate

const EXPIRY: [string, number | null][] = [["In 2 years", 730], ["In 1 year", 365], ["In 5 years", 1825], ["Never", null]];

export function GenerateKeyDialog({ accountId, back }: { accountId?: string; back?: string }) {
  const { accounts, setDialog, showToast, bumpKeys, prefs, choose } = useStore();
  const closeDlg = () => setDialog(back ? { type: "settings", tab: back } : null);
  const [acct, setAcct] = useState(accountId || accounts[0]?.id || "");
  const [algo, setAlgo] = useState<KeyAlgo>("cv25519");
  const [days, setDays] = useState<number | null>(730);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [remember, setRemember] = useState(prefs.pgpRemember === "session");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<PgpKey | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const strength = passphraseStrength(pw);
  const labels = ["", "too short or weak", "okay", "good", "strong"];

  const generate = async () => {
    if (pw.length < 8) return setErr("Use at least 8 characters.");
    if (pw !== pw2) return setErr("Passphrases don’t match.");
    setErr("");
    setBusy(true);
    try {
      const k = await api.pgpGenerateKey(acct, algo, days, pw, remember ? "session" : "never");
      setKey(k);
      bumpKeys();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const backup = async () => {
    if (!key) return;
    try {
      const path = await api.pgpExportSecret(key.fingerprint);
      if (path) {
        setSaved(path);
        showToast("Backup saved. Keep it somewhere safe.", undefined, "success");
      }
    } catch (e) {
      showToast(`Couldn’t save the backup: ${friendlyError(e)}`, undefined, "error");
    }
  };

  const close = async () => {
    if (key && !saved) {
      const choice = await choose({
        title: "Close without a backup?",
        body: "If this computer is lost, mail encrypted to this key can’t be read.",
        choices: [{ id: "backup", label: "Back up now", kind: "primary" }, { id: "close", label: "Close anyway" }],
      });
      if (choice === "backup") return void backup();
    }
    closeDlg();
  };

  return (
    <Modal title="Generate a key" onClose={() => void close()}>
      <div className="steps" aria-label="Steps">
        <span className={key ? "" : "on"}>1 Details</span><span>›</span><span className={key ? "on" : ""}>2 Back up</span>
      </div>
      {!key ? (
        <div className="form" style={{ marginTop: 0 }}>
          <label htmlFor="gk-for">For</label>
          <select id="gk-for" value={acct} onChange={(e) => setAcct(e.target.value)} disabled={busy}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>)}
          </select>
          <label>Key type</label>
          <div className="seg" role="radiogroup" aria-label="Key type" style={{ margin: 0 }}>
            <button role="radio" aria-checked={algo === "cv25519"} className={algo === "cv25519" ? "on" : ""} disabled={busy} onClick={() => setAlgo("cv25519")}>Modern (Curve25519)</button>
            <button role="radio" aria-checked={algo === "rsa3072"} className={algo === "rsa3072" ? "on" : ""} disabled={busy} onClick={() => setAlgo("rsa3072")}>Compatible (RSA 3072)</button>
          </div>
          <label htmlFor="gk-exp">Expires</label>
          <select id="gk-exp" value={String(days)} onChange={(e) => setDays(e.target.value === "null" ? null : Number(e.target.value))} disabled={busy}>
            {EXPIRY.map(([l, d]) => <option key={l} value={String(d)}>{l}</option>)}
          </select>
          <label htmlFor="gk-pw">Passphrase</label>
          <input id="gk-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} disabled={busy} autoComplete="new-password" autoFocus />
          <div className={`meter s${strength}`} role="img" aria-label={`Passphrase strength: ${labels[strength] || "none"}`}><i /><i /><i /><i /></div>
          <label htmlFor="gk-pw2">Repeat passphrase</label>
          <input id="gk-pw2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} disabled={busy} autoComplete="new-password" onKeyDown={(e) => e.key === "Enter" && void generate()} />
          <Switch checked={remember} onChange={setRemember} label="Remember passphrase until Hey Look! quits" />
          <div className="note"><Info size={14} /><span>The secret key is stored on this computer, locked with your passphrase. If you lose it or forget the passphrase, mail encrypted to it can’t be read. You’ll save a backup next.</span></div>
          {err && <div className="field-err" role="alert"><TriangleAlert size={13} />{err}</div>}
          <div className="ask-actions">
            <button className="btn" onClick={closeDlg} disabled={busy}>Cancel</button>
            <button className="btn primary" onClick={() => void generate()} disabled={busy} aria-busy={busy}>
              {busy ? <><LoaderCircle size={14} className="spin" /> Generating…</> : "Generate"}
            </button>
          </div>
        </div>
      ) : (
        <div className="form" style={{ marginTop: 0 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span className="key-ico"><ShieldCheck size={18} /></span>
            <div>
              <b>Your key is ready.</b>
              <div className="muted small">{keyName(key)} · {key.algo}</div>
            </div>
          </div>
          <dl className="kv">
            <dt>Fingerprint</dt><dd><Fpr fpr={key.fingerprint} /> <CopyButton text={fmtFpr(key.fingerprint)} /></dd>
            {key.expires && <><dt>Expires</dt><dd>{fmtDay(key.expires)}</dd></>}
          </dl>
          <div className="note"><Info size={14} /><span>Save a backup now. It stays locked with your passphrase, so it is safe to keep on a USB stick or in a password manager.</span></div>
          {saved && <div className="notice good">Backup saved to {saved}</div>}
          <div className="ask-actions">
            <button className="btn" onClick={() => void backup()}><HardDriveDownload size={14} /> {saved ? "Save another copy…" : "Save backup…"}</button>
            <button className="btn primary" onClick={() => void close()}>Done</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- import

export function ImportKeyDialog({ armored: initial, paste, back }: { armored?: string; paste?: boolean; back?: string }) {
  const { setDialog, showToast, bumpKeys } = useStore();
  const closeDlg = () => setDialog(back ? { type: "settings", tab: back } : null);
  const [text, setText] = useState(initial ?? "");
  const [path, setPath] = useState<string | null>(null);
  const [hot, setHot] = useState(false);
  const [info, setInfo] = useState<KeyInspect | null>(null);
  const [err, setErr] = useState("");
  const [pw, setPw] = useState("");
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const src = useMemo(() => (path ? { path } : text.trim() ? { armored: text } : null), [path, text]);
  useEffect(() => {
    const n = ++seq.current;
    setInfo(null);
    setErr("");
    if (!src) return;
    const t = setTimeout(() => {
      api.pgpInspectKey(src).then((r) => n === seq.current && setInfo(r)).catch((e) => n === seq.current && setErr(friendlyError(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [src]);

  const pick = async () => {
    try {
      const p = await api.pgpPickKeyFile();
      if (p) {
        setPath(p);
        setText("");
      }
    } catch (e) {
      setErr(friendlyError(e));
    }
  };

  const onDrop = async (f: File | undefined) => {
    setHot(false);
    if (!f) return;
    const t = await f.text();
    if (t.includes("-----BEGIN PGP")) {
      setText(t);
      setPath(null);
    } else setErr("This file is not in text (.asc) form. Use “choose a file” for binary key files.");
  };

  const secret = !!info?.isSecret;
  const protectedKey = info ? info.keys.every((k) => k.protected) : true;
  const importIt = async () => {
    if (!src || !info) return;
    setBusy(true);
    setErr("");
    try {
      const keys = await api.pgpImportKey(src, secret ? pw : null, !secret && verified);
      bumpKeys();
      closeDlg();
      showToast(keys.length === 1 ? `Imported key for ${userName(keyName(keys[0]))}` : `Imported ${keys.length} keys`, undefined, "success");
    } catch (e) {
      const code = errorCode(e);
      setErr(code === "PGP_BAD_PASSPHRASE" ? "Wrong passphrase for this secret key." : friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const needsPw = secret;
  const newPw = secret && !protectedKey;
  return (
    <Modal title="Import a key" onClose={closeDlg}>
      <div
        className={`dropzone ${hot ? "hot" : ""}`}
        onDragOver={(e) => (e.preventDefault(), setHot(true))}
        onDragLeave={() => setHot(false)}
        onDrop={(e) => (e.preventDefault(), void onDrop(e.dataTransfer.files[0]))}
      >
        <Upload size={22} aria-hidden />
        <b>Drop a .asc key file</b>
        <span className="small">or <button className="link" onClick={() => void pick()}>choose a file</button> · or paste an armored key below</span>
        {path && <span className="small mono ellipsis" style={{ maxWidth: "100%" }}>{path}</span>}
      </div>
      <textarea
        rows={4}
        className="mono"
        style={{ marginTop: 10, width: "100%" }}
        aria-label="Armored key"
        placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
        autoFocus={paste}
        value={text}
        onChange={(e) => (setText(e.target.value), setPath(null))}
        spellCheck={false}
      />
      {err && <div className="field-err" role="alert" style={{ marginTop: 8 }}><TriangleAlert size={13} />{err}</div>}
      {info?.keys.map((k) => (
        <div className="set-card" key={k.fingerprint}>
          <div className="set-card-head">
            <span className={`key-ico ${k.hasSecret ? "" : "pub"}`}><KeyRound size={16} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <b className="ellipsis">{keyName(k)}</b>
              <div className="fpr muted" aria-label={fmtFpr(k.fingerprint)}>{fmtFpr(k.fingerprint).replace(/(\S+ \S+ \S+ \S+ \S+) /, "$1\n")}</div>
            </div>
            <span className="pill">{k.hasSecret ? "Secret key" : "Public key"}</span>
          </div>
          {k.revoked && <div className="notice bad">This key was revoked by its owner. Don’t use it to encrypt.</div>}
          {!k.revoked && k.expired && k.expires && <div className="notice">This key expired on {fmtDay(k.expires)}. You can import it to read old mail, but it can’t be used to encrypt.</div>}
          {info.alreadyKnown.includes(k.fingerprint) && <div className="notice info">You already have this key. Importing will update its user IDs and expiry.</div>}
        </div>
      ))}
      {info && needsPw && (
        <div className="form" style={{ marginTop: 4 }}>
          <label htmlFor="ik-pw">{newPw ? "This key has no passphrase. Choose one to store it safely" : "Enter the passphrase of this key"}</label>
          <input id="ik-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" />
        </div>
      )}
      {info && !secret && (
        <>
          <div className="note" style={{ marginTop: 8 }}><Info size={14} /><span>Compare the fingerprint with the owner (in person or by phone) before marking it verified.</span></div>
          <div style={{ marginTop: 8 }}><Switch checked={verified} onChange={setVerified} label="I compared the fingerprint — mark as verified" /></div>
        </>
      )}
      <div className="ask-actions">
        <button className="btn" onClick={closeDlg}>Cancel</button>
        <button className="btn primary" disabled={!info || busy || (needsPw && !pw)} aria-busy={busy} onClick={() => void importIt()}>
          {busy ? <><LoaderCircle size={14} className="spin" /> Importing…</> : "Import key"}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- key details

export function KeyDetailsDialog({ fingerprint, back }: { fingerprint: string; back?: string }) {
  const { setDialog, showToast, confirm, accounts, bumpKeys, keysRev } = useStore();
  const closeDlg = () => setDialog(back ? { type: "settings", tab: back } : null);
  const [keys, setKeys] = useState<PgpKey[] | null>(null);
  const [form, setForm] = useState<null | "passphrase" | "expiry">(null);
  const [old, setOld] = useState("");
  const [fresh, setFresh] = useState("");
  const [days, setDays] = useState<number | null>(730);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.pgpListKeys().then(setKeys).catch(() => setKeys([])), []);
  useEffect(() => void load(), [load, keysRev]);
  const k = keys?.find((x) => x.fingerprint === fingerprint);

  if (!keys) return <Modal title="Key details" onClose={closeDlg}><div className="sk" style={{ height: 120 }} aria-busy /></Modal>;
  if (!k) return <Modal title="Key details" onClose={closeDlg}><div className="muted">This key is no longer in your key list.</div></Modal>;

  const usedBy = k.defaultFor.map((id) => accounts.find((a) => a.id === id)?.email).filter(Boolean);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(errorCode(e) === "PGP_BAD_PASSPHRASE" ? "Wrong passphrase. Try again." : friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    const name = userName(keyName(k));
    const ok = k.hasSecret
      ? await confirm({ title: `Delete your key ${shortKey(k.fingerprint)}?`, body: "You won’t be able to read mail encrypted to it unless you have a backup.", confirmLabel: "Delete", danger: true })
      : await confirm({ title: `Remove ${name}’s public key?`, body: "You won’t be able to encrypt to them until you import it again.", confirmLabel: "Remove", danger: true });
    if (!ok) return;
    await run(async () => {
      await api.pgpDeleteKey(k.fingerprint, true);
      bumpKeys();
      closeDlg();
      showToast(k.hasSecret ? "Key deleted" : `Removed ${name}’s public key`, undefined, "success");
    });
  };

  return (
    <Modal title="Key details" onClose={closeDlg}>
      <dl className="kv">
        <dt>User IDs</dt><dd>{k.userIds.length ? k.userIds.map((u) => <div key={u}>{u}</div>) : <span className="muted">None</span>}</dd>
        <dt>Fingerprint</dt><dd><Fpr fpr={k.fingerprint} /> <CopyButton text={fmtFpr(k.fingerprint)} /></dd>
        <dt>Algorithm</dt><dd>{k.algo}</dd>
        <dt>Created</dt><dd>{fmtDay(k.created)}</dd>
        <dt>Expires</dt>
        <dd>
          {k.expires ? fmtDay(k.expires) : "Never"} {k.expired && <span className="pill warn">Expired</span>} {k.revoked && <span className="pill bad">Revoked</span>}{" "}
          {k.hasSecret && <button className="link small" onClick={() => (setForm(form === "expiry" ? null : "expiry"), setErr(""))}>Change…</button>}
        </dd>
        {k.hasSecret ? (
          <><dt>Used by</dt><dd>{usedBy.length ? usedBy.map((e) => <div key={e}>{e} (default)</div>) : <span className="muted">No mailbox uses it yet</span>}</dd></>
        ) : (
          <><dt>Trust</dt>
            <dd>
              <Switch
                checked={k.verified}
                onChange={(v) => void run(async () => (await api.pgpSetVerified(k.fingerprint, v), bumpKeys()))}
                label={k.verified ? "Verified by you" : "Not verified"}
              />
            </dd></>
        )}
        <dt>Source</dt><dd>{{ generated: "Generated here", file: "Imported from a file", paste: "Pasted", email: "Found in an email" }[k.source] ?? k.source}</dd>
      </dl>

      {form === "expiry" && (
        <div className="form" style={{ marginTop: 10 }}>
          <label htmlFor="kd-exp">New expiry</label>
          <select id="kd-exp" value={String(days)} onChange={(e) => setDays(e.target.value === "null" ? null : Number(e.target.value))}>
            {EXPIRY.map(([l, d]) => <option key={l} value={String(d)}>{l}</option>)}
          </select>
          <label htmlFor="kd-old">Passphrase</label>
          <input id="kd-old" type="password" value={old} onChange={(e) => setOld(e.target.value)} autoComplete="off" />
          <div className="row-inline" style={{ justifyContent: "flex-end" }}>
            <button className="btn small" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn primary small" disabled={!old || busy} onClick={() => void run(async () => (await api.pgpSetExpiry(k.fingerprint, old, days), setOld(""), setForm(null), bumpKeys(), showToast("Expiry updated", undefined, "success")))}>Save</button>
          </div>
        </div>
      )}
      {form === "passphrase" && (
        <div className="form" style={{ marginTop: 10 }}>
          <label htmlFor="kd-pold">Current passphrase</label>
          <input id="kd-pold" type="password" value={old} onChange={(e) => setOld(e.target.value)} autoComplete="off" />
          <label htmlFor="kd-pnew">New passphrase</label>
          <input id="kd-pnew" type="password" value={fresh} onChange={(e) => setFresh(e.target.value)} autoComplete="new-password" />
          <div className="row-inline" style={{ justifyContent: "flex-end" }}>
            <button className="btn small" onClick={() => setForm(null)}>Cancel</button>
            <button
              className="btn primary small"
              disabled={!old || fresh.length < 8 || busy}
              onClick={() => void run(async () => (await api.pgpChangePassphrase(k.fingerprint, old, fresh), setOld(""), setFresh(""), setForm(null), bumpKeys(), showToast("Passphrase changed", undefined, "success")))}
            >
              Change passphrase
            </button>
          </div>
          {fresh && fresh.length < 8 && <div className="field-err"><TriangleAlert size={13} />Use at least 8 characters.</div>}
        </div>
      )}
      {err && <div className="field-err" role="alert" style={{ marginTop: 8 }}><TriangleAlert size={13} />{err}</div>}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
        <button className="btn small" onClick={() => void api.pgpExportPublic(k.fingerprint).then((p) => p && showToast(`Saved to ${p}`, undefined, "success")).catch((e) => showToast(friendlyError(e), undefined, "error"))}>
          <HardDriveDownload size={13} /> Export public key…
        </button>
        <button className="btn small" onClick={() => void api.pgpPublicArmored(k.fingerprint).then((a) => navigator.clipboard.writeText(a)).then(() => showToast("Public key copied", undefined, "success")).catch((e) => showToast(friendlyError(e), undefined, "error"))}>
          <Copy size={13} /> Copy public key
        </button>
        {k.hasSecret && (
          <>
            <button className="btn small" onClick={() => void api.pgpExportSecret(k.fingerprint).then((p) => p && showToast(`Backup saved to ${p}`, undefined, "success")).catch((e) => showToast(friendlyError(e), undefined, "error"))}>
              <FileKey size={13} /> Back up secret key…
            </button>
            <button className="btn small" onClick={() => (setForm(form === "passphrase" ? null : "passphrase"), setErr(""))}>Change passphrase…</button>
          </>
        )}
        <button className="btn small danger" onClick={() => void del()}><Trash2 size={13} /> Delete…</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- reading pane: badges and cards

function sigBadge(s: SigInfo): { cls: string; icon: React.ReactNode; text: string; title: string } {
  const who = s.signer || "";
  switch (s.status) {
    case "valid":
      if (!s.matchesFrom) return { cls: "warn", icon: <ShieldAlert size={12} />, text: `Signed by ${who || "someone else"}, not the sender`, title: "The signature is valid, but the key does not belong to the sender’s address." };
      return s.verified
        ? { cls: "good", icon: <ShieldCheck size={12} />, text: `Signed by ${who} · Verified`, title: "The signature is valid and you verified this key." }
        : { cls: "accent", icon: <BadgeCheck size={12} />, text: "Signed · Valid, key not verified", title: "The signature is valid. You haven’t verified that this key belongs to the sender." };
    case "unknown_key":
      return { cls: "warn", icon: <ShieldQuestionMark size={12} />, text: "Signed · Unknown key", title: "This message is signed with a key you don’t have, so the signature can’t be checked." };
    case "expired_key":
      return { cls: "warn", icon: <ShieldAlert size={12} />, text: "Signed · Key expired", title: "The signing key has expired." };
    case "revoked_key":
      return { cls: "warn", icon: <ShieldAlert size={12} />, text: "Signed · Key revoked", title: "The owner revoked this key. Don’t trust the signature." };
    default:
      return { cls: "bad", icon: <ShieldX size={12} />, text: "Signature invalid", title: "The signature does not match. The message may have been changed after it was signed." };
  }
}

function SecPopover({ m, sec, onClose }: { m: MessageFull; sec: MessageSecurity; onClose: () => void }) {
  const setDialog = useStore((s) => s.setDialog);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, onClose, true);
  const s = sec.signature;
  const known = !!s?.fingerprint;
  return (
    <div className="popover sec-pop" role="dialog" aria-label="Security details" ref={ref}>
      {s && (
        <>
          <h4>{s.status === "valid" ? <ShieldCheck size={15} className="good-ico" /> : s.status === "invalid" ? <ShieldX size={15} className="bad-ico" /> : <ShieldAlert size={15} className="warn-ico" />}
            {s.status === "valid" ? "Signature is valid" : s.status === "invalid" ? "Signature is not valid" : s.status === "unknown_key" ? "Signed with an unknown key" : s.status === "expired_key" ? "Signed with an expired key" : "Signed with a revoked key"}
          </h4>
          <dl className="kv">
            {s.signer && <><dt>Signed by</dt><dd>{s.signer}</dd></>}
            <dt>Key</dt><dd className="fpr">{s.fingerprint ? fmtFpr(s.fingerprint) : shortKey(s.keyId)}</dd>
            {known && <><dt>Key trust</dt><dd>{s.verified ? <span className="pill good">Verified by you</span> : <span className="pill">Not verified</span>}</dd></>}
            {s.signedAt && <><dt>Signed at</dt><dd>{fmtFull(s.signedAt)}</dd></>}
            {!s.matchesFrom && <><dt>Sender</dt><dd>{m.fromEmail} (not on the key)</dd></>}
          </dl>
        </>
      )}
      {sec.encrypted && (
        <dl className="kv">
          <dt>Encrypted for</dt><dd>{sec.encryptedFor.length ? sec.encryptedFor.map((k) => shortKey(k)).join(", ") : "Hidden recipients"}</dd>
          <dt>Format</dt><dd>{sec.signature?.inline || sec.partial ? "Inline PGP" : "PGP/MIME"} · AES-256</dd>
        </dl>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        {known && <button className="btn small" onClick={() => (onClose(), setDialog({ type: "pgp-key", fingerprint: s!.fingerprint! }))}>Show key</button>}
        {!m.confidential && <button className="btn small" onClick={() => (onClose(), setDialog({ type: "original", messageId: m.id }))}>Show original</button>}
      </div>
    </div>
  );
}

/** Badges for the security state of one message, with a details popover. Renders nothing for ordinary mail. */
export function SecBadges({ m }: { m: MessageFull }) {
  const sec = m.security;
  const [open, setOpen] = useState(false);
  const setDialog = useStore((s) => s.setDialog);
  if (!sec) return null;
  const decrypted = sec.encrypted && sec.decryption === "ok";
  const sig = sec.signature ? sigBadge(sec.signature) : null;
  const keyAtt = m.attachments.find(isKeyAttachment);
  return (
    <>
      <div className="sec-badges">
        {decrypted && (
          sec.partial
            ? <button className="pill warn" aria-haspopup="dialog" aria-expanded={open} title="Only part of this message was encrypted. Text outside the encrypted part could have been added by someone else." onClick={() => setOpen((o) => !o)}><LockOpen size={12} /> Partly encrypted</button>
            : <button className="pill good" aria-haspopup="dialog" aria-expanded={open} title="This message was encrypted. Only you and the other recipients can read it." onClick={() => setOpen((o) => !o)}><Lock size={12} /> Encrypted</button>
        )}
        {sig && (
          <button className={`pill ${sig.cls}`} aria-haspopup="dialog" aria-expanded={open} title={sig.title} onClick={() => setOpen((o) => !o)}>
            {sig.icon} {sig.text}
          </button>
        )}
        {open && <SecPopover m={m} sec={sec} onClose={() => setOpen(false)} />}
      </div>
      {sec.signature?.status === "invalid" && (
        <div className="notice bad" role="alert">
          The signature doesn’t match this message. It may have been changed after {sec.signature.signer || "the sender"} signed it, or it wasn’t sent by them. Be careful with links and attachments.{" "}
          <button className="link" onClick={() => setOpen(true)}>Details</button>
        </div>
      )}
      {sec.signature?.status === "unknown_key" && (
        <div className="notice">
          Signed with key <span className="mono">{shortKey(sec.signature.keyId)}</span>, which you don’t have.{" "}
          {keyAtt && <><button className="link" onClick={() => void importKeyFromMessage(m, keyAtt.index)}>Import key from attachment</button> · </>}
          <button className="link" onClick={() => setDialog({ type: "pgp-import" })}>Import from file…</button>
        </div>
      )}
    </>
  );
}

/** Shown instead of the message body when it could not be decrypted (locked, no key, damaged). */
export function EncCard({ m }: { m: MessageFull }) {
  const sec = m.security!;
  const { setDialog, showToast, prefs, replaceMessage } = useStore();
  const [pw, setPw] = useState("");
  const [keep, setKeep] = useState(prefs.pgpRemember === "session");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  if (sec.decryption === "locked") {
    const unlock = async () => {
      if (!pw || busy) return;
      setBusy(true);
      setErr("");
      try {
        replaceMessage(await api.pgpDecryptMessage(m.id, pw, keep));
        useStore.getState().bumpKeys();
      } catch (e) {
        const c = errorCode(e);
        setErr(c === "PGP_LOCKED_OUT" ? "Too many attempts. Wait 30 seconds." : c === "PGP_BAD_PASSPHRASE" ? "Wrong passphrase. Try again." : friendlyError(e));
        setPw("");
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="enc-card" role="group" aria-label="Encrypted message">
        <div className="enc-ico"><LockKeyhole size={24} /></div>
        <b>This message is encrypted</b>
        <span className="muted small">Enter the passphrase for key {shortKey(sec.lockedKey ?? "")}{sec.lockedLabel ? ` (${sec.lockedLabel})` : ""}.</span>
        <div className="row-inline">
          <input type="password" placeholder="Passphrase" aria-label="Passphrase" aria-invalid={!!err} value={pw} autoComplete="off" onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void unlock()} />
          <button className="btn primary" disabled={!pw || busy} aria-busy={busy} onClick={() => void unlock()}>{busy ? "Unlocking…" : "Unlock"}</button>
        </div>
        {err && <div className="field-err" role="alert"><TriangleAlert size={13} />{err}</div>}
        <Switch checked={keep} onChange={setKeep} label={prefs.pgpRemember === "session" ? "Remember until Hey Look! quits" : "Keep unlocked for a few minutes"} />
      </div>
    );
  }

  if (sec.decryption === "no_key") {
    const first = sec.encryptedFor[0];
    return (
      <div className="enc-card bad" role="group" aria-label="Can’t decrypt this message">
        <div className="enc-ico"><LockKeyhole size={24} /></div>
        <b>Can’t decrypt this message</b>
        <span className="muted small">
          {first ? <>It was encrypted for key <span className="mono">{shortKey(first)}</span>, which isn’t on this computer.</> : <>It wasn’t encrypted for any key on this computer.</>} If you have a backup of that key, import it.
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => setDialog({ type: "pgp-import" })}>Import key…</button>
          {!m.confidential && <button className="btn" onClick={() => setDialog({ type: "original", messageId: m.id })}>Show original</button>}
        </div>
      </div>
    );
  }

  // damaged / unsupported
  const retry = async () => {
    try {
      replaceMessage(await api.pgpDecryptMessage(m.id));
    } catch (e) {
      showToast(friendlyError(e), undefined, "error");
    }
  };
  return (
    <div className="enc-card bad" role="group" aria-label="Damaged encrypted message">
      <div className="enc-ico"><FileWarning size={24} /></div>
      <b>This encrypted message is damaged</b>
      <span className="muted small">The PGP data could not be read ({sec.error ?? "unsupported or corrupted data"}).</span>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" onClick={() => void retry()}>Try again</button>
        {!m.confidential && <button className="btn" onClick={() => setDialog({ type: "original", messageId: m.id })}>Show original</button>}
      </div>
    </div>
  );
}

/** A public key attached to (or inside) a message, imported into the key store. Offers Undo for keys that are new. */
export async function importKeyFromMessage(m: MessageFull, index: number) {
  const st = useStore.getState();
  try {
    const before = new Set((await api.pgpListKeys()).map((k) => k.fingerprint));
    const keys = await api.pgpImportFromMessage(m.id, index);
    st.bumpKeys();
    const fresh = keys.filter((k) => !before.has(k.fingerprint));
    const name = keys[0] ? userName(keyName(keys[0])) : "the sender";
    st.showToast(
      `Added ${name}’s public key from this message`,
      fresh.length ? () => void Promise.all(fresh.map((k) => api.pgpDeleteKey(k.fingerprint, true))).then(() => useStore.getState().bumpKeys()) : undefined,
      "success",
    );
    // show the signature check again now that the key is known
    if (st.selected) void st.select(st.selected);
  } catch (e) {
    st.showToast(`Couldn’t import the key: ${friendlyError(e)}`, undefined, "error");
  }
}

export const isKeyAttachment = (a: { mime: string; name: string; size: number }) => a.mime === "application/pgp-keys" || (/\.asc$/i.test(a.name) && a.size < 60_000);

/** True when the body should be replaced by a card (not decrypted). */
export const needsCard = (m: MessageFull) => !!m.security && m.security.encrypted && m.security.decryption !== "ok" && m.security.decryption !== "none";

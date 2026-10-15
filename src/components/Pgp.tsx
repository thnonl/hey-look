import {
  BadgeCheck, Copy, FileKey, FileWarning, HardDriveDownload, Info, KeyRound, LoaderCircle, Lock, LockKeyhole, LockOpen, ShieldAlert, ShieldCheck,
  ShieldQuestionMark, ShieldX, TriangleAlert, Trash2, Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorCode, KeyAlgo, KeyInspect, MessageFull, MessageSecurity, PgpKey, SigInfo } from "../api";
import { t, type Key } from "../i18n";
import { useT } from "../i18n/react";
import { tx } from "../i18n/rich";
import { friendlyError, UnlockReason, useStore } from "../store";
import { fmtDay, fmtFpr, fmtFull, passphraseStrength, shortKey, userName } from "../util";
import { Modal, Switch, useOutside } from "./ui";

// ---------------------------------------------------------------- helpers

const REASON_TITLE: Record<UnlockReason, Key> = {
  sign: "pgp.unlock.sign",
  decrypt: "pgp.unlock.decrypt",
  draft: "pgp.unlock.draft",
  schedule: "pgp.unlock.schedule",
};

export const keyName = (k: Pick<PgpKey, "userIds" | "keyId">) => k.userIds[0] ?? t("pgp.keyName", { id: shortKey(k.keyId) });

/** Spoken form of a fingerprint for screen readers: groups of four, spaced. */
const Fpr = ({ fpr, className = "fpr" }: { fpr: string; className?: string }) => (
  <span className={className} aria-label={fmtFpr(fpr)}>{fmtFpr(fpr)}</span>
);

function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const showToast = useStore((s) => s.showToast);
  return (
    <button className="link small" onClick={() => void navigator.clipboard.writeText(text).then(() => showToast(t("pgp.copied"), undefined, "success"))}>
      {label ?? t("common.copy")}
    </button>
  );
}

/** Ask for the passphrase of a key (unlocks it for the session). Resolves true when it was unlocked. */
export const askUnlock = (fingerprint: string, reason: UnlockReason, label?: string) => useStore.getState().askPassphrase({ fingerprint, reason, label });

// ---------------------------------------------------------------- passphrase prompt (store-driven, like AskHost)

function PassphraseDialog() {
  const t = useT();
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
    const timer = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(timer);
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
        setErr(t("pgp.unlock.tooMany"));
        setWait(30);
      } else if (code === "PGP_BAD_PASSPHRASE") setErr(t("pgp.unlock.wrong"));
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
        <h3 id="pp-title">{t(REASON_TITLE[p.reason])}</h3>
        <p className="muted" style={{ marginBottom: 10 }}>{t("pgp.keyName", { id: shortKey(p.fingerprint) })}{p.label ? ` · ${p.label}` : ""}</p>
        <input
          ref={input}
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          aria-label={t("pgp.passphrase")}
          aria-invalid={!!err}
          aria-describedby={err ? "pp-err" : undefined}
          style={{ width: "100%" }}
          autoComplete="off"
        />
        {err && <div className="field-err" id="pp-err" style={{ marginTop: 6 }}><TriangleAlert size={13} />{err}</div>}
        <div style={{ marginTop: 10 }}>
          <Switch checked={keep} onChange={setKeep} label={remember === "session" ? t("pgp.unlock.rememberSession") : t("pgp.unlock.keepFew")} />
        </div>
        <div className="ask-actions">
          <button className="btn" onClick={() => resolve(false)}>{t("common.cancel")}</button>
          <button className="btn primary" disabled={!pw || busy || wait > 0} aria-busy={busy} onClick={() => void unlock()}>
            {busy ? <><LoaderCircle size={14} className="spin" /> {t("pgp.unlock.unlocking")}</> : wait > 0 ? t("pgp.unlock.wait", { n: wait }) : t("pgp.unlock.unlock")}
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

const EXPIRY: [Key, number | null][] = [["pgp.expiry.2y", 730], ["pgp.expiry.1y", 365], ["pgp.expiry.5y", 1825], ["pgp.expiry.never", null]];

const SOURCE_LABEL: Record<string, Key> = {
  generated: "pgp.details.sourceGenerated",
  file: "pgp.details.sourceFile",
  paste: "pgp.details.sourcePaste",
  email: "pgp.details.sourceEmail",
};

export function GenerateKeyDialog({ accountId, back }: { accountId?: string; back?: string }) {
  const t = useT();
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
  const strengthKeys: Key[] = ["pgp.strength.none", "pgp.strength.weak", "pgp.strength.okay", "pgp.strength.good", "pgp.strength.strong"];

  const generate = async () => {
    if (pw.length < 8) return setErr(t("pgp.gen.minLength"));
    if (pw !== pw2) return setErr(t("pgp.gen.mismatch"));
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
        showToast(t("pgp.gen.backupSaved"), undefined, "success");
      }
    } catch (e) {
      showToast(t("pgp.gen.backupFailed", { error: friendlyError(e) }), undefined, "error");
    }
  };

  const close = async () => {
    if (key && !saved) {
      const choice = await choose({
        title: t("pgp.gen.closeTitle"),
        body: t("pgp.gen.closeBody"),
        choices: [{ id: "backup", label: t("pgp.gen.backupNow"), kind: "primary" }, { id: "close", label: t("pgp.gen.closeAnyway") }],
      });
      if (choice === "backup") return void backup();
    }
    closeDlg();
  };

  return (
    <Modal title={t("pgp.gen.title")} onClose={() => void close()}>
      <div className="steps" aria-label={t("pgp.gen.steps")}>
        <span className={key ? "" : "on"}>{t("pgp.gen.step1")}</span><span>›</span><span className={key ? "on" : ""}>{t("pgp.gen.step2")}</span>
      </div>
      {!key ? (
        <div className="form" style={{ marginTop: 0 }}>
          <label htmlFor="gk-for">{t("pgp.gen.for")}</label>
          <select id="gk-for" value={acct} onChange={(e) => setAcct(e.target.value)} disabled={busy}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>)}
          </select>
          <label>{t("pgp.gen.keyType")}</label>
          <div className="seg" role="radiogroup" aria-label={t("pgp.gen.keyType")} style={{ margin: 0 }}>
            <button role="radio" aria-checked={algo === "cv25519"} className={algo === "cv25519" ? "on" : ""} disabled={busy} onClick={() => setAlgo("cv25519")}>{t("pgp.gen.modern")}</button>
            <button role="radio" aria-checked={algo === "rsa3072"} className={algo === "rsa3072" ? "on" : ""} disabled={busy} onClick={() => setAlgo("rsa3072")}>{t("pgp.gen.compatible")}</button>
          </div>
          <label htmlFor="gk-exp">{t("pgp.details.expires")}</label>
          <select id="gk-exp" value={String(days)} onChange={(e) => setDays(e.target.value === "null" ? null : Number(e.target.value))} disabled={busy}>
            {EXPIRY.map(([l, d]) => <option key={l} value={String(d)}>{t(l)}</option>)}
          </select>
          <label htmlFor="gk-pw">{t("pgp.passphrase")}</label>
          <input id="gk-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} disabled={busy} autoComplete="new-password" autoFocus />
          <div className={`meter s${strength}`} role="img" aria-label={t(strengthKeys[strength])}><i /><i /><i /><i /></div>
          <label htmlFor="gk-pw2">{t("pgp.gen.repeat")}</label>
          <input id="gk-pw2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} disabled={busy} autoComplete="new-password" onKeyDown={(e) => e.key === "Enter" && void generate()} />
          <Switch checked={remember} onChange={setRemember} label={t("pgp.gen.remember")} />
          <div className="note"><Info size={14} /><span>{t("pgp.gen.note")}</span></div>
          {err && <div className="field-err" role="alert"><TriangleAlert size={13} />{err}</div>}
          <div className="ask-actions">
            <button className="btn" onClick={closeDlg} disabled={busy}>{t("common.cancel")}</button>
            <button className="btn primary" onClick={() => void generate()} disabled={busy} aria-busy={busy}>
              {busy ? <><LoaderCircle size={14} className="spin" /> {t("pgp.gen.generating")}</> : t("pgp.gen.generate")}
            </button>
          </div>
        </div>
      ) : (
        <div className="form" style={{ marginTop: 0 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span className="key-ico"><ShieldCheck size={18} /></span>
            <div>
              <b>{t("pgp.gen.ready")}</b>
              <div className="muted small">{keyName(key)} · {key.algo}</div>
            </div>
          </div>
          <dl className="kv">
            <dt>{t("pgp.details.fingerprint")}</dt><dd><Fpr fpr={key.fingerprint} /> <CopyButton text={fmtFpr(key.fingerprint)} /></dd>
            {key.expires && <><dt>{t("pgp.details.expires")}</dt><dd>{fmtDay(key.expires)}</dd></>}
          </dl>
          <div className="note"><Info size={14} /><span>{t("pgp.gen.backupNote")}</span></div>
          {saved && <div className="notice good">{t("pgp.gen.backupSavedTo", { path: saved })}</div>}
          <div className="ask-actions">
            <button className="btn" onClick={() => void backup()}><HardDriveDownload size={14} /> {saved ? t("pgp.gen.saveAnother") : t("pgp.gen.saveBackup")}</button>
            <button className="btn primary" onClick={() => void close()}>{t("common.done")}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- import

export function ImportKeyDialog({ armored: initial, paste, back }: { armored?: string; paste?: boolean; back?: string }) {
  const t = useT();
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
    const timer = setTimeout(() => {
      api.pgpInspectKey(src).then((r) => n === seq.current && setInfo(r)).catch((e) => n === seq.current && setErr(friendlyError(e)));
    }, 250);
    return () => clearTimeout(timer);
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
    const content = await f.text();
    if (content.includes("-----BEGIN PGP")) {
      setText(content);
      setPath(null);
    } else setErr(t("pgp.import.notText"));
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
      showToast(keys.length === 1 ? t("pgp.import.importedOne", { name: userName(keyName(keys[0])) }) : t("pgp.import.importedMany", { n: keys.length }), undefined, "success");
    } catch (e) {
      const code = errorCode(e);
      setErr(code === "PGP_BAD_PASSPHRASE" ? t("pgp.import.wrongSecret") : friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const needsPw = secret;
  const newPw = secret && !protectedKey;
  return (
    <Modal title={t("pgp.import.title")} onClose={closeDlg}>
      <div
        className={`dropzone ${hot ? "hot" : ""}`}
        onDragOver={(e) => (e.preventDefault(), setHot(true))}
        onDragLeave={() => setHot(false)}
        onDrop={(e) => (e.preventDefault(), void onDrop(e.dataTransfer.files[0]))}
      >
        <Upload size={22} aria-hidden />
        <b>{t("pgp.import.drop")}</b>
        <span className="small">{tx("pgp.import.orChoose", { link: <button className="link" onClick={() => void pick()}>{t("pgp.import.chooseFile")}</button> })}</span>
        {path && <span className="small mono ellipsis" style={{ maxWidth: "100%" }}>{path}</span>}
      </div>
      <textarea
        rows={4}
        className="mono"
        style={{ marginTop: 10, width: "100%" }}
        aria-label={t("pgp.import.armored")}
        // i18n-ok: the literal armor header
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
            <span className="pill">{k.hasSecret ? t("pgp.import.secretKey") : t("pgp.import.publicKey")}</span>
          </div>
          {k.revoked && <div className="notice bad">{t("pgp.import.revoked")}</div>}
          {!k.revoked && k.expired && k.expires && <div className="notice">{t("pgp.import.expired", { date: fmtDay(k.expires) })}</div>}
          {info.alreadyKnown.includes(k.fingerprint) && <div className="notice info">{t("pgp.import.alreadyKnown")}</div>}
        </div>
      ))}
      {info && needsPw && (
        <div className="form" style={{ marginTop: 4 }}>
          <label htmlFor="ik-pw">{newPw ? t("pgp.import.choosePassphrase") : t("pgp.import.enterPassphrase")}</label>
          <input id="ik-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" />
        </div>
      )}
      {info && !secret && (
        <>
          <div className="note" style={{ marginTop: 8 }}><Info size={14} /><span>{t("pgp.import.compare")}</span></div>
          <div style={{ marginTop: 8 }}><Switch checked={verified} onChange={setVerified} label={t("pgp.import.compared")} /></div>
        </>
      )}
      <div className="ask-actions">
        <button className="btn" onClick={closeDlg}>{t("common.cancel")}</button>
        <button className="btn primary" disabled={!info || busy || (needsPw && !pw)} aria-busy={busy} onClick={() => void importIt()}>
          {busy ? <><LoaderCircle size={14} className="spin" /> {t("pgp.import.importing")}</> : t("pgp.import.importKey")}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- key details

export function KeyDetailsDialog({ fingerprint, back }: { fingerprint: string; back?: string }) {
  const t = useT();
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

  if (!keys) return <Modal title={t("pgp.details.title")} onClose={closeDlg}><div className="sk" style={{ height: 120 }} aria-busy /></Modal>;
  if (!k) return <Modal title={t("pgp.details.title")} onClose={closeDlg}><div className="muted">{t("pgp.details.gone")}</div></Modal>;

  const usedBy = k.defaultFor.map((id) => accounts.find((a) => a.id === id)?.email).filter(Boolean);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(errorCode(e) === "PGP_BAD_PASSPHRASE" ? t("pgp.unlock.wrong") : friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    const name = userName(keyName(k));
    const ok = k.hasSecret
      ? await confirm({ title: t("pgp.details.deleteSecretTitle", { id: shortKey(k.fingerprint) }), body: t("pgp.details.deleteSecretBody"), confirmLabel: t("common.delete"), danger: true })
      : await confirm({ title: t("pgp.details.removePublicTitle", { name }), body: t("pgp.details.removePublicBody"), confirmLabel: t("common.remove"), danger: true });
    if (!ok) return;
    await run(async () => {
      await api.pgpDeleteKey(k.fingerprint, true);
      bumpKeys();
      closeDlg();
      showToast(k.hasSecret ? t("pgp.details.keyDeleted") : t("pgp.details.publicRemoved", { name }), undefined, "success");
    });
  };

  return (
    <Modal title={t("pgp.details.title")} onClose={closeDlg}>
      <dl className="kv">
        <dt>{t("pgp.details.userIds")}</dt><dd>{k.userIds.length ? k.userIds.map((u) => <div key={u}>{u}</div>) : <span className="muted">{t("common.none")}</span>}</dd>
        <dt>{t("pgp.details.fingerprint")}</dt><dd><Fpr fpr={k.fingerprint} /> <CopyButton text={fmtFpr(k.fingerprint)} /></dd>
        <dt>{t("pgp.details.algorithm")}</dt><dd>{k.algo}</dd>
        <dt>{t("pgp.details.created")}</dt><dd>{fmtDay(k.created)}</dd>
        <dt>{t("pgp.details.expires")}</dt>
        <dd>
          {k.expires ? fmtDay(k.expires) : t("pgp.expiry.never")} {k.expired && <span className="pill warn">{t("pgp.details.expired")}</span>} {k.revoked && <span className="pill bad">{t("pgp.details.revoked")}</span>}{" "}
          {k.hasSecret && <button className="link small" onClick={() => (setForm(form === "expiry" ? null : "expiry"), setErr(""))}>{t("pgp.details.change")}</button>}
        </dd>
        {k.hasSecret ? (
          <><dt>{t("pgp.details.usedBy")}</dt><dd>{usedBy.length ? usedBy.map((e) => <div key={e}>{t("pgp.details.defaultFor", { email: String(e) })}</div>) : <span className="muted">{t("pgp.details.noMailbox")}</span>}</dd></>
        ) : (
          <><dt>{t("pgp.details.trust")}</dt>
            <dd>
              <Switch
                checked={k.verified}
                onChange={(v) => void run(async () => (await api.pgpSetVerified(k.fingerprint, v), bumpKeys()))}
                label={k.verified ? t("pgp.details.verified") : t("pgp.details.notVerified")}
              />
            </dd></>
        )}
        <dt>{t("pgp.details.source")}</dt><dd>{SOURCE_LABEL[k.source] ? t(SOURCE_LABEL[k.source]) : k.source}</dd>
      </dl>

      {form === "expiry" && (
        <div className="form" style={{ marginTop: 10 }}>
          <label htmlFor="kd-exp">{t("pgp.details.newExpiry")}</label>
          <select id="kd-exp" value={String(days)} onChange={(e) => setDays(e.target.value === "null" ? null : Number(e.target.value))}>
            {EXPIRY.map(([l, d]) => <option key={l} value={String(d)}>{t(l)}</option>)}
          </select>
          <label htmlFor="kd-old">{t("pgp.passphrase")}</label>
          <input id="kd-old" type="password" value={old} onChange={(e) => setOld(e.target.value)} autoComplete="off" />
          <div className="row-inline" style={{ justifyContent: "flex-end" }}>
            <button className="btn small" onClick={() => setForm(null)}>{t("common.cancel")}</button>
            <button className="btn primary small" disabled={!old || busy} onClick={() => void run(async () => (await api.pgpSetExpiry(k.fingerprint, old, days), setOld(""), setForm(null), bumpKeys(), showToast(t("pgp.details.expiryUpdated"), undefined, "success")))}>{t("common.save")}</button>
          </div>
        </div>
      )}
      {form === "passphrase" && (
        <div className="form" style={{ marginTop: 10 }}>
          <label htmlFor="kd-pold">{t("pgp.details.currentPassphrase")}</label>
          <input id="kd-pold" type="password" value={old} onChange={(e) => setOld(e.target.value)} autoComplete="off" />
          <label htmlFor="kd-pnew">{t("pgp.details.newPassphrase")}</label>
          <input id="kd-pnew" type="password" value={fresh} onChange={(e) => setFresh(e.target.value)} autoComplete="new-password" />
          <div className="row-inline" style={{ justifyContent: "flex-end" }}>
            <button className="btn small" onClick={() => setForm(null)}>{t("common.cancel")}</button>
            <button
              className="btn primary small"
              disabled={!old || fresh.length < 8 || busy}
              onClick={() => void run(async () => (await api.pgpChangePassphrase(k.fingerprint, old, fresh), setOld(""), setFresh(""), setForm(null), bumpKeys(), showToast(t("pgp.details.passphraseChanged"), undefined, "success")))}
            >
              {t("pgp.details.changePassphraseBtn")}
            </button>
          </div>
          {fresh && fresh.length < 8 && <div className="field-err"><TriangleAlert size={13} />{t("pgp.gen.minLength")}</div>}
        </div>
      )}
      {err && <div className="field-err" role="alert" style={{ marginTop: 8 }}><TriangleAlert size={13} />{err}</div>}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
        <button className="btn small" onClick={() => void api.pgpExportPublic(k.fingerprint).then((p) => p && showToast(t("pgp.details.savedTo", { path: p }), undefined, "success")).catch((e) => showToast(friendlyError(e), undefined, "error"))}>
          <HardDriveDownload size={13} /> {t("pgp.details.exportPublic")}
        </button>
        <button className="btn small" onClick={() => void api.pgpPublicArmored(k.fingerprint).then((a) => navigator.clipboard.writeText(a)).then(() => showToast(t("pgp.details.publicCopied"), undefined, "success")).catch((e) => showToast(friendlyError(e), undefined, "error"))}>
          <Copy size={13} /> {t("pgp.details.copyPublic")}
        </button>
        {k.hasSecret && (
          <>
            <button className="btn small" onClick={() => void api.pgpExportSecret(k.fingerprint).then((p) => p && showToast(t("pgp.details.backupSavedTo", { path: p }), undefined, "success")).catch((e) => showToast(friendlyError(e), undefined, "error"))}>
              <FileKey size={13} /> {t("pgp.details.backupSecret")}
            </button>
            <button className="btn small" onClick={() => (setForm(form === "passphrase" ? null : "passphrase"), setErr(""))}>{t("pgp.details.changePassphrase")}</button>
          </>
        )}
        <button className="btn small danger" onClick={() => void del()}><Trash2 size={13} /> {t("pgp.details.delete")}</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- reading pane: badges and cards

function sigBadge(s: SigInfo): { cls: string; icon: React.ReactNode; text: string; title: string } {
  const who = s.signer || "";
  switch (s.status) {
    case "valid":
      if (!s.matchesFrom) return { cls: "warn", icon: <ShieldAlert size={12} />, text: t("pgp.sig.otherSigner", { who: who || t("pgp.sig.someone") }), title: t("pgp.sig.otherSignerTip") };
      return s.verified
        ? { cls: "good", icon: <ShieldCheck size={12} />, text: t("pgp.sig.verified", { who }), title: t("pgp.sig.verifiedTip") }
        : { cls: "accent", icon: <BadgeCheck size={12} />, text: t("pgp.sig.valid"), title: t("pgp.sig.validTip") };
    case "unknown_key":
      return { cls: "warn", icon: <ShieldQuestionMark size={12} />, text: t("pgp.sig.unknown"), title: t("pgp.sig.unknownTip") };
    case "expired_key":
      return { cls: "warn", icon: <ShieldAlert size={12} />, text: t("pgp.sig.expired"), title: t("pgp.sig.expiredTip") };
    case "revoked_key":
      return { cls: "warn", icon: <ShieldAlert size={12} />, text: t("pgp.sig.revoked"), title: t("pgp.sig.revokedTip") };
    default:
      return { cls: "bad", icon: <ShieldX size={12} />, text: t("pgp.sig.invalid"), title: t("pgp.sig.invalidTip") };
  }
}

function SecPopover({ m, sec, onClose }: { m: MessageFull; sec: MessageSecurity; onClose: () => void }) {
  const t = useT();
  const setDialog = useStore((s) => s.setDialog);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, onClose, true);
  const s = sec.signature;
  const known = !!s?.fingerprint;
  return (
    <div className="popover sec-pop" role="dialog" aria-label={t("pgp.pop.label")} ref={ref}>
      {s && (
        <>
          <h4>{s.status === "valid" ? <ShieldCheck size={15} className="good-ico" /> : s.status === "invalid" ? <ShieldX size={15} className="bad-ico" /> : <ShieldAlert size={15} className="warn-ico" />}
            {s.status === "valid" ? t("pgp.pop.valid") : s.status === "invalid" ? t("pgp.pop.invalid") : s.status === "unknown_key" ? t("pgp.pop.unknown") : s.status === "expired_key" ? t("pgp.pop.expired") : t("pgp.pop.revoked")}
          </h4>
          <dl className="kv">
            {s.signer && <><dt>{t("pgp.pop.signedBy")}</dt><dd>{s.signer}</dd></>}
            <dt>{t("pgp.pop.key")}</dt><dd className="fpr">{s.fingerprint ? fmtFpr(s.fingerprint) : shortKey(s.keyId)}</dd>
            {known && <><dt>{t("pgp.pop.keyTrust")}</dt><dd>{s.verified ? <span className="pill good">{t("pgp.details.verified")}</span> : <span className="pill">{t("pgp.details.notVerified")}</span>}</dd></>}
            {s.signedAt && <><dt>{t("pgp.pop.signedAt")}</dt><dd>{fmtFull(s.signedAt)}</dd></>}
            {!s.matchesFrom && <><dt>{t("pgp.pop.sender")}</dt><dd>{t("pgp.pop.senderNotOnKey", { email: m.fromEmail })}</dd></>}
          </dl>
        </>
      )}
      {sec.encrypted && (
        <dl className="kv">
          <dt>{t("pgp.pop.encryptedFor")}</dt><dd>{sec.encryptedFor.length ? sec.encryptedFor.map((k) => shortKey(k)).join(", ") : t("pgp.pop.hiddenRecipients")}</dd>
          <dt>{t("pgp.pop.format")}</dt><dd>{(sec.signature?.inline || sec.partial ? t("pgp.pop.inline") : "PGP/MIME") + " · AES-256"}</dd>
        </dl>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        {known && <button className="btn small" onClick={() => (onClose(), setDialog({ type: "pgp-key", fingerprint: s!.fingerprint! }))}>{t("pgp.pop.showKey")}</button>}
        {!m.confidential && <button className="btn small" onClick={() => (onClose(), setDialog({ type: "original", messageId: m.id }))}>{t("reading.msg.showOriginal")}</button>}
      </div>
    </div>
  );
}

/** Badges for the security state of one message, with a details popover. Renders nothing for ordinary mail. */
export function SecBadges({ m }: { m: MessageFull }) {
  const t = useT();
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
            ? <button className="pill warn" aria-haspopup="dialog" aria-expanded={open} title={t("pgp.badge.partlyTip")} onClick={() => setOpen((o) => !o)}><LockOpen size={12} /> {t("pgp.badge.partly")}</button>
            : <button className="pill good" aria-haspopup="dialog" aria-expanded={open} title={t("pgp.badge.encryptedTip")} onClick={() => setOpen((o) => !o)}><Lock size={12} /> {t("pgp.badge.encrypted")}</button>
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
          {tx("pgp.notice.invalid", { link: <button className="link" onClick={() => setOpen(true)}>{t("pgp.notice.details")}</button> }, { signer: sec.signature.signer || t("pgp.notice.theSender") })}
        </div>
      )}
      {sec.signature?.status === "unknown_key" && (
        <div className="notice">
          {tx("pgp.notice.unknownKey", { key: <span className="mono">{shortKey(sec.signature.keyId)}</span> })}{" "}
          {keyAtt && <><button className="link" onClick={() => void importKeyFromMessage(m, keyAtt.index)}>{t("pgp.notice.importFromAttachment")}</button> · </>}
          <button className="link" onClick={() => setDialog({ type: "pgp-import" })}>{t("pgp.notice.importFromFile")}</button>
        </div>
      )}
    </>
  );
}

/** Shown instead of the message body when it could not be decrypted (locked, no key, damaged). */
export function EncCard({ m }: { m: MessageFull }) {
  const t = useT();
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
        setErr(c === "PGP_LOCKED_OUT" ? t("pgp.unlock.tooMany") : c === "PGP_BAD_PASSPHRASE" ? t("pgp.unlock.wrong") : friendlyError(e));
        setPw("");
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="enc-card" role="group" aria-label={t("pgp.card.encryptedLabel")}>
        <div className="enc-ico"><LockKeyhole size={24} /></div>
        <b>{t("pgp.card.encryptedTitle")}</b>
        <span className="muted small">{sec.lockedLabel ? t("pgp.card.enterPassphraseLabel", { key: shortKey(sec.lockedKey ?? ""), label: sec.lockedLabel }) : t("pgp.card.enterPassphrase", { key: shortKey(sec.lockedKey ?? "") })}</span>
        <div className="row-inline">
          <input type="password" placeholder={t("pgp.passphrase")} aria-label={t("pgp.passphrase")} aria-invalid={!!err} value={pw} autoComplete="off" onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void unlock()} />
          <button className="btn primary" disabled={!pw || busy} aria-busy={busy} onClick={() => void unlock()}>{busy ? t("pgp.unlock.unlocking") : t("pgp.unlock.unlock")}</button>
        </div>
        {err && <div className="field-err" role="alert"><TriangleAlert size={13} />{err}</div>}
        <Switch checked={keep} onChange={setKeep} label={prefs.pgpRemember === "session" ? t("pgp.unlock.rememberSession") : t("pgp.unlock.keepFew")} />
      </div>
    );
  }

  if (sec.decryption === "no_key") {
    const first = sec.encryptedFor[0];
    return (
      <div className="enc-card bad" role="group" aria-label={t("pgp.card.noKeyLabel")}>
        <div className="enc-ico"><LockKeyhole size={24} /></div>
        <b>{t("pgp.card.noKeyLabel")}</b>
        <span className="muted small">
          {first ? tx("pgp.card.noKeyForKey", { key: <span className="mono">{shortKey(first)}</span> }) : t("pgp.card.noKeyAny")}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => setDialog({ type: "pgp-import" })}>{t("pgp.card.importKey")}</button>
          {!m.confidential && <button className="btn" onClick={() => setDialog({ type: "original", messageId: m.id })}>{t("reading.msg.showOriginal")}</button>}
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
    <div className="enc-card bad" role="group" aria-label={t("pgp.card.damagedLabel")}>
      <div className="enc-ico"><FileWarning size={24} /></div>
      <b>{t("pgp.card.damagedTitle")}</b>
      <span className="muted small">{t("pgp.card.damagedBody", { reason: sec.error ?? t("pgp.card.damagedFallback") })}</span>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" onClick={() => void retry()}>{t("pgp.tryAgain")}</button>
        {!m.confidential && <button className="btn" onClick={() => setDialog({ type: "original", messageId: m.id })}>{t("reading.msg.showOriginal")}</button>}
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
    const name = keys[0] ? userName(keyName(keys[0])) : t("pgp.fromMessage.theSender");
    st.showToast(
      t("pgp.fromMessage.added", { name }),
      fresh.length ? () => void Promise.all(fresh.map((k) => api.pgpDeleteKey(k.fingerprint, true))).then(() => useStore.getState().bumpKeys()) : undefined,
      "success",
    );
    // show the signature check again now that the key is known
    if (st.selected) void st.select(st.selected);
  } catch (e) {
    st.showToast(t("pgp.fromMessage.failed", { error: friendlyError(e) }), undefined, "error");
  }
}

export const isKeyAttachment = (a: { mime: string; name: string; size: number }) => a.mime === "application/pgp-keys" || (/\.asc$/i.test(a.name) && a.size < 60_000);

/** True when the body should be replaced by a card (not decrypted). */
export const needsCard = (m: MessageFull) => !!m.security && m.security.encrypted && m.security.decryption !== "ok" && m.security.decryption !== "none";

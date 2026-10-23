import { BadgeCheck, FileWarning, Lock, LockKeyhole, LockOpen, ShieldAlert, ShieldCheck, ShieldQuestionMark, ShieldX, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { answerVia } from "../actions";
import { api, errorCode, MessageFull, MessageSecurity, PgpKey, SigInfo } from "../api";
import { t } from "../i18n";
import { useT } from "../i18n/react";
import { tx } from "../i18n/rich";
import { friendlyError, UnlockReason, useStore } from "../store";
import { fmtFpr, fmtFull, shortKey, userName } from "../util";
import { Switch, useOutside } from "./ui";
import { LazyPassphraseDialog } from "../lazyViews";

// ---------------------------------------------------------------- helpers

export const keyName = (k: Pick<PgpKey, "userIds" | "keyId">) => k.userIds[0] ?? t("pgp.keyName", { id: shortKey(k.keyId) });

/** Ask for the passphrase of a key (unlocks it for the session). Resolves true when it was unlocked. */
export const askUnlock = (fingerprint: string, reason: UnlockReason, label?: string) => useStore.getState().askPassphrase({ fingerprint, reason, label });

/**
 * "Move to Drafts" of a scheduled message (W2.4). An encrypted one was sealed for its recipients and you; the draft is stored for your key only, so
 * it is opened with your key first: a locked key is asked for (once), then the move is tried again. Rejects like `api.outboxToDraft`.
 */
export async function moveScheduledToDrafts(outboxId: string): Promise<void> {
  try {
    await api.outboxToDraft(outboxId);
  } catch (err) {
    const locked = String(err).match(/PGP_LOCKED:([0-9A-F]+)/);
    if (errorCode(err) === "PGP_LOCKED" && locked && (await askUnlock(locked[1], "decrypt"))) return api.outboxToDraft(outboxId);
    throw err;
  }
}

/** Renders the passphrase prompt when a feature asked for one. Mount once, next to AskHost. */
export function PassphraseHost() {
  const p = useStore((s) => s.passphrase);
  return p ? <LazyPassphraseDialog key={`${p.fingerprint}:${p.reason}`} /> : null;
}

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
      showToast(() => friendlyError(e), undefined, "error");
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
  if (answerVia.importKey) return answerVia.importKey(m, index); // the reader window: the main window manages the keys
  const st = useStore.getState();
  try {
    const before = new Set((await api.pgpListKeys()).map((k) => k.fingerprint));
    const keys = await api.pgpImportFromMessage(m.id, index);
    st.bumpKeys();
    const fresh = keys.filter((k) => !before.has(k.fingerprint));
    const name = keys[0] ? userName(keyName(keys[0])) : t("pgp.fromMessage.theSender");
    st.showToast(
      () => t("pgp.fromMessage.added", { name }),
      fresh.length ? () => void Promise.all(fresh.map((k) => api.pgpDeleteKey(k.fingerprint, true))).then(() => useStore.getState().bumpKeys()) : undefined,
      "success",
    );
    // show the signature check again now that the key is known
    if (st.selected) void st.select(st.selected);
  } catch (e) {
    st.showToast(() => t("pgp.fromMessage.failed", { error: friendlyError(e) }), undefined, "error");
  }
}

export const isKeyAttachment = (a: { mime: string; name: string; size: number }) => a.mime === "application/pgp-keys" || (/\.asc$/i.test(a.name) && a.size < 60_000);

/** True when the body should be replaced by a card (not decrypted). */
export const needsCard = (m: MessageFull) => !!m.security && m.security.encrypted && m.security.decryption !== "ok" && m.security.decryption !== "none";

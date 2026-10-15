import { useState } from "react";
import { Account, api } from "../api";
import { endHint, endNotice, endReason, GOOGLE_REVIEW_HELP_URL, providerLabel, waitHint, type EndReason, type SignInProvider } from "../signIn";
import { friendlyError, useStore } from "../store";
import { useT } from "../i18n/react";
import { openUpdateLink } from "../updates";

/** A sign-in that ended without access: why, and the error it came with (the notice is written when it is drawn, in the language in use). */
export interface SignInEnd {
  reason: EndReason;
  raw: string;
}

/** The result of a failed sign-in: the notice to show for it, or null when it is an ordinary error that is shown as it is. */
export function signInEnd(provider: SignInProvider, purpose: "mail" | "calendar", e: unknown): SignInEnd | null {
  const reason = endReason(String(e));
  if (!reason) return null;
  // the person pressed Cancel and there is nothing to add: say nothing
  if (reason === "cancelled" && !endHint(provider, purpose, reason)) return null;
  return { reason, raw: String(e) };
}

function HelpLink() {
  const t = useT();
  return (
    <button className="link" onClick={() => void openUpdateLink(GOOGLE_REVIEW_HELP_URL)}>{t("signin.google.learn")}</button>
  );
}

/**
 * The line under a sign-in that waits for the browser: what to do on Google's warning page (the app is unverified until Google's review
 * is done), a link to the Help entry, and a Cancel link when `onCancel` is given (a mail sign-in has a Cancel button of its own).
 */
export function SignInWaiting({ provider, lead, onCancel, cancelRef }: {
  provider: SignInProvider;
  lead: string;
  onCancel?: () => void;
  cancelRef?: React.Ref<HTMLButtonElement>;
}) {
  const t = useT();
  const hint = waitHint(provider);
  return (
    <div className="muted small" role="status" aria-live="polite">
      {lead}
      {hint && (
        <>
          {" "}{hint}{" "}<HelpLink />
        </>
      )}
      {onCancel && (
        <>
          {" "}<button ref={cancelRef} className="link" onClick={onCancel}>{t("common.cancel")}</button>
        </>
      )}
    </div>
  );
}

/** The calm notice after a sign-in ended without access (timeout, cancel, refused, blocked by the organization), with the advice for it. */
export function SignInEnded({ provider, purpose, end, onAppPassword }: {
  provider: SignInProvider;
  purpose: "mail" | "calendar";
  end: SignInEnd;
  /** mail sign-in only: switch to the form that adds Gmail with an app password */
  onAppPassword?: () => void;
}) {
  const t = useT();
  // the calendar says it in its own sentence ("Calendar sign-in timed out ..."), mail says which sign-in ended
  const { lead, hint } = endNotice(provider, purpose, end.reason, purpose === "calendar" ? friendlyError(end.raw) : null);
  return (
    <div className="notice" role={end.reason === "cancelled" ? "status" : "alert"}>
      {lead}
      {hint && (
        <>
          {lead ? " " : ""}{hint.text}
          {hint.learn && (
            <>
              {" "}<HelpLink />
            </>
          )}
          {hint.appPassword && onAppPassword && (
            <div style={{ marginTop: 6 }}>
              <button className="btn small" onClick={onAppPassword}>{t("signin.end.appPassword")}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * "Sign in again" for a Google / Microsoft mailbox whose sign-in was rejected when its mail was refreshed (the grant was revoked or ended,
 * or the organization has to approve the app). Shown in the folder list (`compact`) and in the mailbox's Settings. The sign-in is the
 * mailbox's own address: nothing is added, the mail stays.
 */
export function ReauthNotice({ account, compact }: { account: Account; compact?: boolean }) {
  const t = useT();
  const kind = useStore((s) => s.reauth[account.id]);
  const [busy, setBusy] = useState(false);
  const [end, setEnd] = useState<SignInEnd | null>(null);
  const [error, setError] = useState("");
  const provider: SignInProvider | null = account.auth === "oauth_google" ? "google" : account.auth === "oauth_microsoft" ? "microsoft" : null;
  if (!kind || !provider) return null;
  const go = async () => {
    setBusy(true);
    setEnd(null);
    setError("");
    try {
      await api.reauthAccount(account.id);
      const st = useStore.getState();
      st.setReauth(account.id, null);
      st.showToast(t("signin.again.done", { email: account.email }), undefined, "success");
      void st.sync();
    } catch (e) {
      const ended = signInEnd(provider, "mail", e);
      if (ended) setEnd(ended);
      else setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  const text = kind === "blocked" ? t("signin.again.blocked", { email: account.email }) : t("signin.again.text", { provider: providerLabel(provider), email: account.email });
  const short = kind === "blocked" ? t("signin.again.blockedShort") : t("signin.again.short", { provider: providerLabel(provider) });
  return (
    <div className={compact ? "notice bad fp-reauth" : "notice bad"} role="status">
      <div>{compact ? short : text}</div>
      {busy ? (
        <>
          <SignInWaiting provider={provider} lead={t("signin.waiting.mail")} onCancel={() => void api.oauthCancel()} />
        </>
      ) : (
        <div style={{ marginTop: 6 }}>
          <button className="btn small primary" onClick={() => void go()}>{t("signin.again.button")}</button>
        </div>
      )}
      {end && <div style={{ marginTop: 6 }}><SignInEnded provider={provider} purpose="mail" end={end} /></div>}
      {error && <div className="field-err" role="alert" style={{ marginTop: 6 }}>{error}</div>}
    </div>
  );
}

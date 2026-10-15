// What to say around the browser sign-in (mail and calendar): the hint while it waits, and the notice when it ends without access.
// Pure functions: scripts/test-sign-in.mjs loads this file with node (explicit .ts imports).
import { backendCode, parseCoded } from "./backendErrors.ts";
import { calendarErrorCode } from "./calendarSync.ts";
import { t } from "./i18n/index.ts";
import type { Key } from "./i18n/index.ts";

/**
 * Google has not finished verifying Hey Look!: the consent screen is in production but unverified, so people who are not among the first
 * 100 users see Google's "Google hasn't verified this app" page, and nobody new can sign in once the limit for unverified apps is used up.
 * While this is true the Google sign-in shows the hint for that page. The release after Google approves the app sets it to false.
 */
export const GOOGLE_REVIEW_PENDING = true;

/** The Help entry that explains Google's warning page (opened in the system browser). */
export const GOOGLE_REVIEW_HELP_URL = "https://thnonl.github.io/hey-look/help.html#google-review";

export type SignInProvider = "google" | "microsoft";
export const providerLabel = (p: SignInProvider): string => (p === "google" ? "Google" : "Microsoft");

/** Why a browser sign-in ended without access. */
export type EndReason = "timeout" | "cancelled" | "denied" | "blocked";

/** The text of an error as the backend wrote it (a thrown Error carries an "Error: " in front). */
const plain = (raw: unknown): string => String(raw).replace(/^Error:s*/, "").trim();

// what Microsoft (and a tenant's policy) says when the organization has to approve the app first
const ORG_MUST_APPROVE = /AADSTS(?:65001|90094|900941|50105|53003)|admin_policy_enforced|org_internal|consent_required|admin approval/i;

/**
 * How a failed sign-in ended, from the error text of the mail command ("OAUTH_TIMEOUT|label=Google: ...") or of the calendar command
 * ("CAL_TIMEOUT: ..."); null for any other failure (a wrong client, no network ...), which is shown as it is.
 */
export function endReason(rawError: string): EndReason | null {
  const raw = plain(rawError);
  const cal = calendarErrorCode(raw);
  if (cal === "TIMEOUT") return "timeout";
  if (cal === "CANCELLED") return "cancelled";
  if (cal === "DENIED") return "denied";
  if (cal === "BLOCKED") return "blocked";
  switch (backendCode(raw)) {
    case "OAUTH_TIMEOUT":
      return "timeout";
    case "OAUTH_CANCELLED":
      return "cancelled";
    case "OAUTH_BLOCKED":
      return "blocked";
    case "OAUTH_REFUSED": {
      const reason = parseCoded(raw)?.params.reason ?? raw;
      return ORG_MUST_APPROVE.test(reason) ? "blocked" : /access_denied/i.test(reason) ? "denied" : null;
    }
    default:
      return null;
  }
}

/** The sentence that opens the notice of a mail sign-in that ended (the calendar shows its own sentence instead). */
export function endLead(provider: SignInProvider, reason: EndReason): string | null {
  if (reason === "blocked") return null;
  return t(`signin.end.${reason}` as Key, { provider: providerLabel(provider) });
}

export interface EndHint {
  text: string;
  /** offer "Add Gmail with an app password" (mail only) */
  appPassword: boolean;
  /** offer the link to the Help entry */
  learn: boolean;
}

/**
 * The advice after a sign-in ended without access. Google: it may have blocked it (the limit for unverified apps); a Gmail account can
 * be added with an app password instead, which does not apply to calendar sync. Microsoft: the organization may need to approve the app.
 */
export function endHint(provider: SignInProvider, purpose: "mail" | "calendar", reason: EndReason): EndHint | null {
  if (provider === "google") {
    if (!GOOGLE_REVIEW_PENDING || reason === "blocked") return null;
    return purpose === "mail"
      ? { text: t("signin.end.google.mail"), appPassword: true, learn: true }
      : { text: t("signin.end.google.calendar"), appPassword: false, learn: true };
  }
  if (reason === "blocked") {
    // (the calendar's own sentence for this case already tells the person to ask the IT admin)
    return purpose === "mail" ? { text: t("signin.end.microsoft.blocked"), appPassword: false, learn: false } : null;
  }
  return { text: t("signin.end.microsoft"), appPassword: false, learn: false };
}

/** The line shown while the browser sign-in waits: Google's warning page is explained, Microsoft needs nothing more. */
export function waitHint(provider: SignInProvider): string | null {
  return provider === "google" && GOOGLE_REVIEW_PENDING ? t("signin.google.hint") : null;
}

/**
 * Whether a mailbox's sign-in was rejected when its mail was refreshed (OAUTH_REAUTH: the grant ended, OAUTH_BLOCKED: the organization has
 * to approve the app): the mailbox then shows "Sign in again". Null for every other error.
 */
export function needsSignIn(raw: string): "again" | "blocked" | null {
  const code = backendCode(plain(raw));
  return code === "OAUTH_REAUTH" ? "again" : code === "OAUTH_BLOCKED" ? "blocked" : null;
}

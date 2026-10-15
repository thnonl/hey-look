// The browser sign-in of mail and calendar: how a sign-in that ended is told apart (timeout, cancel, refused, the organization has to
// approve), what is said for Google (not verified yet) and for Microsoft (ask the IT admin), and which mail errors mean "Sign in again".
// Checks src/signIn.ts. Run: node --experimental-strip-types scripts/test-sign-in.mjs
import assert from "node:assert/strict";
import { setLangPref } from "../src/i18n/index.ts";
import { GOOGLE_REVIEW_HELP_URL, GOOGLE_REVIEW_PENDING, endHint, endLead, endReason, needsSignIn, waitHint } from "../src/signIn.ts";
import { calendarErrorText, statusLine } from "../src/calendarSync.ts";
import { backendText } from "../src/backendErrors.ts";

assert.equal(GOOGLE_REVIEW_PENDING, true, "1.0.1 ships while Google has not verified the app");
assert.equal(GOOGLE_REVIEW_HELP_URL, "https://thnonl.github.io/hey-look/help.html#google-review");

// ---- how a sign-in ended (the texts are what the Rust code sends)
const mail = (code, label, rest = "") => `${code}|label=${label}${rest}: whatever`;
assert.equal(endReason(mail("OAUTH_TIMEOUT", "Google")), "timeout");
assert.equal(endReason(mail("OAUTH_CANCELLED", "Microsoft")), "cancelled");
assert.equal(endReason("CAL_TIMEOUT: Calendar sign-in timed out. Turn the switch on to try again."), "timeout");
assert.equal(endReason("CAL_CANCELLED: Calendar sign-in was cancelled."), "cancelled");
assert.equal(endReason("CAL_DENIED: Calendar access wasn’t allowed. Turn the switch on to try again."), "denied");
assert.equal(endReason("CAL_BLOCKED: me@x.test’s organization may need to approve Hey Look! for calendar access. Ask your IT admin."), "blocked");
// the provider sent the person back with an error
assert.equal(endReason(mail("OAUTH_REFUSED", "Google", "|reason=access_denied")), "denied");
assert.equal(endReason(mail("OAUTH_REFUSED", "Microsoft", "|reason=access_denied - AADSTS65004%3A The user declined")), "denied");
assert.equal(endReason(mail("OAUTH_REFUSED", "Microsoft", "|reason=access_denied - AADSTS65001%3A The user or administrator has not consented")), "blocked");
assert.equal(endReason(mail("OAUTH_REFUSED", "Microsoft", "|reason=interaction_required - AADSTS90094%3A The grant requires admin permission")), "blocked");
assert.equal(endReason(mail("OAUTH_REFUSED", "Microsoft", "|reason=consent_required")), "blocked");
assert.equal(endReason(mail("OAUTH_REFUSED", "Google", "|reason=redirect_uri_mismatch")), null, "a wrong client is an ordinary error");
assert.equal(endReason(mail("OAUTH_BLOCKED", "Microsoft")), "blocked");
// anything else is an ordinary error, shown as it is
for (const other of ["token exchange failed: invalid_grant", "Couldn’t save the password", "CAL_ERROR: Couldn’t turn on calendar sync: x", "CAL_WRONG_ACCOUNT: x", "OAUTH_STATE: x", ""]) assert.equal(endReason(other), null, other);

// ---- Google: not verified yet
setLangPref("en");
assert.equal(waitHint("microsoft"), null, "only Google has a warning page to explain");
const wait = waitHint("google");
assert.ok(wait.includes("Google hasn’t verified this app") && wait.includes("Advanced") && wait.includes("Go to Hey Look! (unsafe)") && wait.includes("waiting for Google’s review"), wait);
for (const reason of ["timeout", "cancelled", "denied"]) {
  const mailHint = endHint("google", "mail", reason);
  assert.ok(/may have blocked/.test(mailHint.text) && /limit for apps Google hasn’t verified/.test(mailHint.text) && /app password/.test(mailHint.text), mailHint.text);
  assert.deepEqual([mailHint.appPassword, mailHint.learn], [true, true], "mail: the app password way and the Help link");
  const calHint = endHint("google", "calendar", reason);
  assert.ok(/may have blocked/.test(calHint.text) && /mail isn’t affected/.test(calHint.text), calHint.text);
  assert.deepEqual([calHint.appPassword, calHint.learn], [false, true], "calendar sync cannot use an app password");
}
assert.equal(endHint("google", "mail", "blocked"), null);
// the sentence that opens a mail notice
assert.equal(endLead("google", "timeout"), "Google sign-in timed out.");
assert.equal(endLead("microsoft", "cancelled"), "Microsoft sign-in was cancelled.");
assert.equal(endLead("microsoft", "blocked"), null, "the advice alone");

// ---- Microsoft: the organization may have to approve Hey Look!
for (const purpose of ["mail", "calendar"]) {
  for (const reason of ["timeout", "cancelled", "denied"]) {
    const h = endHint("microsoft", purpose, reason);
    assert.ok(/organization/.test(h.text) && /approve Hey Look!/.test(h.text) && /IT admin/.test(h.text), `${purpose} ${reason}: ${h.text}`);
    assert.deepEqual([h.appPassword, h.learn], [false, false]);
  }
}
assert.ok(/IT admin/.test(endHint("microsoft", "mail", "blocked").text));
assert.equal(endHint("microsoft", "calendar", "blocked"), null, "the calendar sentence for it already says so");
// the calendar's own sentences (statusLine / connect errors) name the IT admin as well
assert.ok(/organization may need to approve Hey Look!.*IT admin/.test(calendarErrorText("CAL_BLOCKED: me@x.test’s organization may need to approve Hey Look! for calendar access. Ask your IT admin.")));
const src = { id: "s", accountId: "a", kind: "microsoft", status: "blocked", lastSync: null, lastError: null, retryAt: null, firstSync: false, calendars: [] };
assert.ok(/IT admin/.test(statusLine(src, { email: "me@x.test", nowSec: 0, fmtTime: String }).text));
assert.equal(statusLine({ ...src, status: "auth" }, { email: "me@x.test", nowSec: 0, fmtTime: String }).allow, true, "calendar: access ended offers Allow access again");

// ---- the same advice in Vietnamese and French (written by the coder, to be reviewed)
for (const lang of ["vi", "fr"]) {
  setLangPref(lang);
  assert.ok(waitHint("google").includes("Advanced") && waitHint("google").includes("Go to Hey Look! (unsafe)") && waitHint("google").includes("Google hasn’t verified this app"), `${lang} keeps Google's words`);
  assert.ok(/CNTT/.test(endHint("microsoft", "mail", "timeout").text) || /informatique/.test(endHint("microsoft", "mail", "timeout").text), `${lang}: ask the IT admin`);
  assert.ok(/CNTT|informatique/.test(statusLine(src, { email: "me@x.test", nowSec: 0, fmtTime: String }).text), `${lang}: calendar blocked names the IT admin`);
  assert.ok(endHint("google", "mail", "timeout").appPassword);
}
setLangPref("en");

// ---- mail errors that mean "Sign in again"
assert.equal(needsSignIn("OAUTH_REAUTH|label=Google: Google sign-in expired or revoked (invalid_grant: Token has been expired or revoked.). Sign in again."), "again");
assert.equal(needsSignIn("OAUTH_REAUTH|label=Microsoft: no stored Microsoft token: x. Sign in again."), "again");
assert.equal(needsSignIn("Error: OAUTH_BLOCKED|label=Microsoft: Your organization may need to approve Hey Look! for this Microsoft account. Ask your IT admin. (AADSTS65001)"), "blocked");
assert.equal(needsSignIn("OAUTH_REFRESH|label=Google|reason=temporarily_unavailable: x"), null, "a token endpoint that is only unavailable is not a sign-out");
assert.equal(needsSignIn("dns error"), null);
assert.equal(needsSignIn(""), null);
// ... and what the person reads for them, in every language
const reauth = "OAUTH_REAUTH|label=Google: Google sign-in expired or revoked (invalid_grant). Sign in again.";
assert.equal(backendText(reauth), "Google sign-in ended. Sign in again to keep getting mail.");
setLangPref("vi");
assert.ok(backendText(reauth).includes("đăng nhập lại"));
setLangPref("fr");
assert.ok(backendText(reauth).includes("Connectez-vous de nouveau"));
setLangPref("en");
assert.ok(/IT admin/.test(backendText("OAUTH_BLOCKED|label=Microsoft: x")));

console.log("ok - test-sign-in");

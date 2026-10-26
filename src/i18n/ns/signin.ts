import { define } from "../types.ts";

// The wait for the browser while signing in (mail and calendar), what is said when it ends without access, and the "Sign in again"
// state of a mailbox whose sign-in was rejected. While Google has not verified Hey Look! (GOOGLE_REVIEW_PENDING in src/signIn.ts) a
// person who signs in sees Google's warning page, and Google may refuse the sign-in.
// "Google hasn't verified this app", "Advanced" and "Go to Hey Look! (unsafe)" are the words of Google's own page (which Google shows in the
// language of the browser), so they stay in English in every language.
export default define({
  en: {
    "signin.waiting.mail": "Finish in your browser.",
    "signin.google.hint": "If Google shows “Google hasn’t verified this app”, choose Advanced, then Go to Hey Look! (unsafe). Hey Look! is waiting for Google’s review.",
    "signin.google.learn": "What does this mean?",
    "signin.end.timeout": "{provider} sign-in timed out.",
    "signin.end.cancelled": "{provider} sign-in was cancelled.",
    "signin.end.denied": "{provider} sign-in wasn’t completed.",
    "signin.end.generic": "{provider} sign-in didn’t finish.",
    "signin.end.google.mail": "Google may have blocked this sign-in. You can add a Gmail account with an app password instead.",
    "signin.end.google.calendar": "Google may have blocked this sign-in. Your mail isn’t affected.",
    "signin.end.microsoft": "If your organization manages this account, it may need to approve Hey Look! first. Ask your IT admin.",
    "signin.end.microsoft.blocked": "Your organization may need to approve Hey Look! before this account can sign in. Ask your IT admin, then try again.",
    "signin.end.appPassword": "Add Gmail with an app password",
    "signin.again.text": "{provider} sign-in for {email} ended. Sign in again to keep getting mail. Your mail stays on this computer.",
    "signin.again.blocked": "Your organization may need to approve Hey Look! for {email}. Ask your IT admin, then try again.",
    "signin.again.button": "Sign in again",
    "signin.again.short": "{provider} sign-in ended.",
    "signin.again.blockedShort": "Hey Look! may need your organization’s approval.",
    "signin.again.done": "Signed in again as {email}",
  },
});

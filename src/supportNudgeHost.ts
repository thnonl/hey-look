// The occasional "support the project" toast: reads the schedule (supportNudge.ts, pure and tested), looks at what the app is doing, and
// draws the toast when it is due and the moment is calm. Local only: nothing here talks to a server.
import { api } from "./api";
import { supportUrl } from "./aboutLinks";
import { t } from "./i18n";
import { ensureSchedule, decide, Moment, SHOW_MS, setEnabled, shown, supported } from "./supportNudge";
import { composeWindowsOpen } from "./popout/popoutCount";
import { useStore } from "./store";
import { openUpdateLink, useUpdates } from "./updates";
import { useFrame } from "./winframe";

const KEY = "support-nudge";
/** How often the app looks whether a due nudge may appear now. */
const CHECK_MS = 30_000;
/** A hovered or focused toast gets this much longer before it goes away by itself. */
const KEEP_MS = 3_000;

let sessionStart = Date.now();
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;

/** Dev preview only (devMock.ts): pretend the app has been open since `ms`. */
export function setSessionStartForTest(ms: number) {
  sessionStart = ms;
}

/** What the app is doing right now (the inputs of the "calm moment" rule). */
export function currentMoment(): Moment {
  const s = useStore.getState();
  const flow = useUpdates.getState().flow.state;
  return {
    focused: useFrame.getState().focused && document.visibilityState === "visible" && document.hasFocus(),
    sessionMs: Date.now() - sessionStart,
    composing: !!s.compose || composeWindowsOpen() > 0, // (a message in a window of its own counts, REQ-W15)
    modalOpen: !!(s.dialog || s.ask || s.passphrase || s.commandOpen),
    toastShowing: s.toasts.length > 0,
    busy: s.sendsInFlight > 0 || s.transfers > 0 || flow === "downloading" || flow === "verifying" || flow === "installing",
  };
}

const nudge = () => useStore.getState().prefs.supportNudge;
const save = (next: ReturnType<typeof nudge>) => useStore.getState().setPrefs({ supportNudge: next });

function hide() {
  clearTimeout(hideTimer);
  useStore.getState().setStickyToast(KEY, null);
}

/** Takes the toast away after `ms`, but not while the pointer or the keyboard focus is on it. */
function arm(ms: number) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (document.querySelector(".toast.support")?.matches(":hover, :focus-within")) return arm(KEEP_MS);
    hide();
  }, ms);
}

/** Shows the toast now and counts it as shown (the next one is due in 2 months, whatever the person does with this one). */
export function showSupportNudge() {
  save(shown(nudge(), Date.now()));
  const st = useStore.getState();
  st.setStickyToast(KEY, {
    text: () => t("app.nudge.text"),
    kind: "info",
    support: true,
    hideClose: true,
    escCloses: true,
    ttl: SHOW_MS,
    onDismiss: () => clearTimeout(hideTimer), // Esc
    actions: [
      {
        label: () => t("app.nudge.coffee"),
        run: () => {
          clearTimeout(hideTimer);
          save(supported(nudge(), Date.now())); // supporters hear from us again in 6 months
          void openUpdateLink(supportUrl()); // the same safe path as the About links (a failed open copies the link and says so); the page of the language in use at the click
        },
      },
      { label: () => t("app.nudge.notNow"), run: () => clearTimeout(hideTimer) },
    ],
    link: { label: () => t("app.nudge.stop"), run: () => { clearTimeout(hideTimer); save(setEnabled(nudge(), false, Date.now())); } },
  });
  arm(SHOW_MS);
}

/** Shows the nudge when it is due and this is a calm moment. */
export function checkSupportNudge() {
  const st = useStore.getState();
  if (!st.loaded || st.accounts.length === 0) return; // (the Welcome screen is no place for it)
  if (decide(nudge(), Date.now(), currentMoment()) === "show") showSupportNudge();
}

/** Called once the preferences are loaded: makes sure the first due date exists, then keeps looking. */
export async function startSupportNudge() {
  if (started) return;
  started = true;
  const cur = nudge();
  if (cur.firstRunAt === null || cur.nextDueAt === null) {
    let hint: number | null = null;
    if (cur.firstRunAt === null) {
      try {
        hint = await api.firstRunHint(); // an install from before the reminder existed: the age of its database
      } catch {
        /* unknown: today counts as the first run */
      }
    }
    const latest = nudge();
    const next = ensureSchedule(latest, Date.now(), hint, Math.random);
    if (next !== latest) save(next);
  }
  setInterval(checkSupportNudge, CHECK_MS);
}

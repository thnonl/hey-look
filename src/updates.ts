// In-app updates, UI side: the result of the check, the download / ready / install flow and its toasts.
// The backend (src-tauri/src/update.rs) does the work: this keeps the state the card, the top-bar chip and the toasts show.
import { copyToClipboard, openExternal } from "./open";
import { stickyTimers } from "./stickyTimers";
import { create } from "zustand";
import { api, DlEvent, UpdateInfo, UpdateKind, UpdateResult, UpdateTrigger } from "./api";
import { t } from "./i18n";
import { friendlyError, useStore } from "./store";
import { useFrame } from "./winframe";

export type FlowState = "idle" | "downloading" | "verifying" | "ready" | "waiting" | "installing" | "failed" | "deferred";
/** Why the "restart now?" question is asked instead of counting down (what is open). */
export type AskVariant = "none" | "dirty" | "empty" | "scheduled" | "dialog";

export interface UpdateFlow {
  state: FlowState;
  /** the version the flow is about */
  version: string | null;
  received: number;
  total: number | null;
  /** bytes per second over the last 3 s, once 2 s of data exist */
  speed: number | null;
  /** seconds left, when the total and the speed are known */
  eta: number | null;
  stage: "download" | "badurl" | "verify" | "install" | null;
  message: string;
  /** seconds left of the 5 s countdown (ready, nothing open) */
  countdown: number | null;
  asking: AskVariant;
  /** failed during install: the package is still there, "Try again" installs it again */
  canReinstall: boolean;
}

const IDLE: UpdateFlow = { state: "idle", version: null, received: 0, total: null, speed: null, eta: null, stage: null, message: "", countdown: null, asking: "none", canReinstall: false };
const TOAST = "update";

interface UpdatesState {
  /** The last meaningful answer of the check (a `throttled` / `disabled` answer without cached info does not replace it). */
  update: UpdateResult | null;
  /** When the latest answer says the last attempt happened (unix seconds). */
  checkedAt: number | null;
  /** A manual check is running (also while it waits for an automatic one). */
  busy: boolean;
  /** The version the "update available" toast was shown for in this app run. */
  toastFor: string | null;
  /** The 8 s startup check was issued: focus / app-shown events count only after that. */
  startupIssued: boolean;
  /** The version the "restart now?" question was asked for in this app run. */
  askedFor: string | null;
  flow: UpdateFlow;

  markStartup: () => void;
  checkUpdate: (trigger: UpdateTrigger) => Promise<void>;
  announceUpdate: () => void;
  openSettingsAbout: (manual: boolean) => void;
  startUpdate: (source: "card" | "toast") => Promise<void>;
  cancelUpdate: () => void;
  deferUpdate: () => void;
  cancelRestart: () => void;
  restartToUpdate: () => Promise<void>;
  retryUpdate: () => void;
  openFallback: () => void;
  startupCheck: () => Promise<void>;
}

/** A check that failed (offline / error) but carries the update the app already knew: the offer stays, with a quiet note. */
export const isStaleOffer = (r: UpdateResult | null): boolean =>
  !!r && (r.kind === "offline" || r.kind === "error") && !!r.info && r.cachedKind === "available";

/** The kind that counts for the UI: `throttled` / `disabled` stand for what their cached info says, a stale offer for `available`. */
export const updateKindOf = (r: UpdateResult | null): UpdateKind | null =>
  !r ? null : r.kind === "throttled" || r.kind === "disabled" ? (r.info ? r.cachedKind ?? null : null) : isStaleOffer(r) ? "available" : r.kind;

/** A download is running or a package waits: automatic checks stay quiet. */
export const flowActive = (f: UpdateFlow) => f.state !== "idle" && f.state !== "failed";

/** The newer version the user has not skipped (drives the gear dot, the toast and the chip), else null. */
export function pendingVersion(update: UpdateResult | null, skipped: string): string | null {
  const latest = updateKindOf(update) === "available" ? update?.info?.latest ?? null : null;
  return latest && latest !== skipped ? latest : null;
}

/** Open a link in the browser; if that fails the link is copied and an error toast says so. */
export async function openUpdateLink(url: string, announce = false) {
  const { showToast } = useStore.getState();
  try {
    await openExternal(url);
    if (announce) showToast(t("updates.toast.opening"), undefined, "info");
  } catch {
    // the toast says "copied" only when it was (on Linux it was not, QA BUG-L4)
    const copied = await copyToClipboard(url);
    showToast(
      copied ? t("updates.toast.openFailedCopied") : t("updates.toast.openFailedNotCopied", { url: url.length > 100 ? url.slice(0, 100) + "…" : url }),
      undefined,
      "error",
    );
  }
}

/** Whether the app window has the focus (kept by `useFrame`; where the frame is not custom it stays true, so the toast is not held back). */
const windowFocused = () => useFrame.getState().focused;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Composing, or a dialog other than Settings (or a question / passphrase prompt) is open. */
function openThing(): AskVariant {
  const s = useStore.getState();
  if (s.compose) return s.compose.outboxId ? "scheduled" : s.composeDirty ? "dirty" : "empty";
  if ((s.dialog && s.dialog.type !== "settings") || s.ask || s.passphrase) return "dialog";
  return "none";
}

const askText = (version: string, variant: AskVariant) =>
  t(variant === "dirty" ? "updates.ask.readyDirty" : variant === "empty" ? "updates.ask.readyEmpty" : variant === "scheduled" ? "updates.ask.readyScheduled" : "updates.ask.ready", { version });

let inflight: Promise<UpdateResult | null> | null = null;
/** Bumped for every download: events of an older one (cancelled) are ignored. */
let runId = 0;
let ring: { t: number; b: number }[] = [];
let startedAt = 0;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let restarting = false;
/** The sticky error toast of a restart that the failed draft save stopped (REQ-28 c). */
const RESTART_STOPPED = "update-restart-stopped";
const RESTART_STOPPED_TEXT = "updates.restartStopped" as const; // a dictionary key: translated where the toast is shown
/** The 30 s timers of the sticky toasts above and the update result: one per toast, a new one replaces the old one (BUG-14). */
const stickyTimer = stickyTimers((key) => useStore.getState().setStickyToast(key, null));

export const useUpdates = create<UpdatesState>((set, get) => {
  const setFlow = (patch: Partial<UpdateFlow>) => set((s) => ({ flow: { ...s.flow, ...patch } }));
  const clearCountdown = () => {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = undefined;
  };
  const toast = (spec: Parameters<ReturnType<typeof useStore.getState>["setStickyToast"]>[1]) => useStore.getState().setStickyToast(TOAST, spec);

  const fail = (stage: NonNullable<UpdateFlow["stage"]>, message: string) => {
    clearCountdown();
    toast(null);
    const v = get().flow.version;
    setFlow({ state: "failed", stage, message, countdown: null, asking: "none", canReinstall: stage === "install", speed: null, eta: null });
    const st = useStore.getState();
    if (windowFocused() && !st.dialog) {
      st.showToast(t("updates.toast.failed", { version: v ?? "" }), undefined, "error", [{ label: t("updates.action.details"), run: () => get().openSettingsAbout(false) }]);
    }
  };

  const onEvent = (id: number, e: DlEvent) => {
    if (id !== runId || get().flow.state === "idle") return;
    switch (e.event) {
      case "started": {
        setFlow({ total: e.data.total, received: 0 });
        // the check inside the download reached GitHub: the offer is real now, whatever the last check said (the note goes, and stays gone)
        const u = get().update;
        if (u && isStaleOffer(u)) set({ update: { ...u, kind: "available", message: null, fromCache: false, cachedKind: null } });
        break;
      }
      case "progress": {
        const now = Date.now();
        ring.push({ t: now, b: e.data.received });
        ring = ring.filter((p) => now - p.t <= 3500);
        const first = ring[0];
        const dt = (now - first.t) / 1000;
        const speed = now - startedAt >= 2000 && dt > 0.2 ? (e.data.received - first.b) / dt : null;
        const total = get().flow.total;
        const eta = speed && speed > 0 && total ? Math.max(0, (total - e.data.received) / speed) : null;
        setFlow({ received: e.data.received, speed, eta });
        break;
      }
      case "verifying":
        setFlow({ state: "verifying", speed: null, eta: null });
        break;
      case "ready":
        setFlow({ state: "ready", speed: null, eta: null });
        evaluateReady();
        break;
      case "failed":
        if (e.data.stage === "changed") {
          // GitHub has another version than the card: nothing was downloaded; start over from a fresh answer (no failure state, no chip)
          clearCountdown();
          runId++;
          set({ flow: IDLE });
          useStore.getState().showToast(t("updates.toast.changed", { version: e.data.message }), undefined, "info");
          void get().checkUpdate("manual");
        } else fail(e.data.stage, e.data.message);
        break;
      case "cancelled":
        break;
    }
  };

  /** Ready: count down to the restart when nothing is open, else ask (once per version and run). */
  const evaluateReady = () => {
    clearCountdown();
    const v = get().flow.version;
    if (!v) return;
    const variant = openThing();
    if (variant !== "none") {
      setFlow({ state: "ready", countdown: null, asking: variant });
      set({ askedFor: v });
      toast({
        text: askText(v, variant),
        actions: [
          { label: t("updates.action.restartNow"), run: () => void get().restartToUpdate() },
          { label: t("updates.action.later"), run: () => get().deferUpdate() },
        ],
        onDismiss: () => get().deferUpdate(),
      });
      return;
    }
    let left = 5;
    const show = () =>
      toast({
        text: t("updates.countdown", { version: v, seconds: left }),
        actions: [
          { label: t("updates.action.restartNow"), run: () => void get().restartToUpdate() },
          { label: t("updates.action.notNow"), run: () => get().deferUpdate() },
        ],
        onDismiss: () => get().deferUpdate(),
      });
    setFlow({ state: "ready", countdown: left, asking: "none" });
    show();
    countdownTimer = setInterval(() => {
      if (get().flow.state !== "ready") return clearCountdown();
      if (openThing() !== "none") return evaluateReady();
      left -= 1;
      if (left <= 0) {
        clearCountdown();
        toast(null);
        void get().restartToUpdate();
        return;
      }
      setFlow({ countdown: left });
      show();
    }, 1000);
  };

  /** Wait until no message is being sent. Resolves false when the restart was cancelled meanwhile. */
  const waitForSends = async (): Promise<boolean> => {
    const sending = async () => useStore.getState().sendsInFlight > 0 || (await api.outboxBusy().catch(() => false));
    if (!(await sending())) return true;
    setFlow({ state: "waiting" });
    let since = Date.now();
    for (;;) {
      if (get().flow.state !== "waiting") return false;
      if (!(await sending())) return true;
      if (Date.now() - since > 60_000) {
        const c = await useStore.getState().choose({
          title: t("updates.ask.sendingTitle"),
          body: t("updates.ask.sendingBody"),
          choices: [
            { id: "wait", label: t("updates.action.wait") },
            { id: "anyway", label: t("updates.action.restartAnyway"), kind: "danger" },
          ],
        });
        if (c === "anyway") return true;
        since = Date.now();
      }
      await sleep(500);
    }
  };

  return {
    update: null,
    checkedAt: null,
    busy: false,
    toastFor: null,
    startupIssued: false,
    askedFor: null,
    flow: IDLE,

    markStartup: () => set({ startupIssued: true }),

    openSettingsAbout: (manual) => {
      useStore.setState({ dialog: { type: "settings", tab: "about", nonce: Date.now() } });
      if (manual) void get().checkUpdate("manual");
    },

    checkUpdate: async (trigger) => {
      const manual = trigger === "manual";
      // an update is on its way: automatic checks do nothing
      if (!manual && flowActive(get().flow)) return;
      if (manual) set({ busy: true });
      try {
        if (inflight) {
          // one request at a time: an automatic call just drops out; a manual one waits and uses the answer if a request was made
          if (!manual) return;
          const prev = await inflight;
          if (prev && prev.kind !== "throttled" && prev.kind !== "disabled") return;
        }
        const run = api.checkUpdate(trigger).catch((e): UpdateResult => {
          // the call itself failed: the offer the UI already shows stays (as for any failed check)
          const known = get().update;
          const offer = updateKindOf(known) === "available" ? known?.info ?? null : null;
          return {
            kind: "error",
            current: known?.current ?? "",
            platform: known?.platform ?? { os: "", arch: "", installer: "unknown", label: t("updates.platform.unknown") },
            checkedAt: get().checkedAt,
            message: friendlyError(e).replace(/\.$/, ""),
            info: offer,
            fromCache: !!offer,
            cachedKind: offer ? "available" : null,
          };
        });
        inflight = run;
        const r = await run;
        inflight = null;
        const holdOn = (r.kind === "throttled" || r.kind === "disabled") && !r.info;
        set({ update: holdOn ? get().update : r, checkedAt: r.checkedAt });
        const kind = updateKindOf(r);
        const latest = r.info?.latest ?? null;
        if (manual) {
          // a manual answer counts as seen: no toast for this version later in the run
          if (kind === "available" && latest) set({ toastFor: latest });
          // a newer version than the one downloaded (or that failed): forget the old package, offer the new one
          const f = get().flow;
          if (kind === "available" && !isStaleOffer(r) && latest && f.version && f.version !== latest && f.state !== "idle" && f.state !== "downloading" && f.state !== "verifying" && f.state !== "installing") {
            clearCountdown();
            toast(null);
            void api.updateDiscard().catch(() => undefined);
            set({ flow: IDLE, askedFor: null });
          }
        } else {
          get().announceUpdate();
        }
        // a check that got an answer clears an old failure (the red chip and the error text) - the offer is shown again
        if (get().flow.state === "failed" && !holdOn && (r.kind === "available" || r.kind === "upToDate" || r.kind === "noRelease")) {
          clearCountdown();
          set({ flow: IDLE });
        }
      } finally {
        inflight = null;
        if (manual) set({ busy: false });
      }
    },

    announceUpdate: () => {
      const { update, toastFor, flow } = get();
      const st = useStore.getState();
      const v = pendingVersion(update, st.prefs.skippedUpdate);
      const info = update?.info;
      // a stale offer (the last check failed) is no news: no toast from it
      // (an answer of kind `disabled` - automatic checks are off - is a remembered offer, not news: no toast, REQ-18 r3.4)
      if (!v || !info || toastFor === v || flowActive(flow) || !windowFocused() || isStaleOffer(update) || update?.kind === "disabled") return;
      set({ toastFor: v });
      // stays until the user closes it (the × or Esc), no timer
      st.setStickyToast("update-available", {
        text: t("updates.available", { version: v }),
        actions: [
          ...(info.asset ? [{ label: t("updates.action.update"), run: () => void get().startUpdate("toast") }] : []),
          { label: t("updates.action.whatsNew"), run: () => get().openSettingsAbout(false) },
        ],
        closeLabel: t("common.close"),
        escCloses: true,
      });
    },

    startUpdate: async (_source) => {
      const f = get().flow;
      const info = get().update?.info;
      if ((f.state !== "idle" && f.state !== "failed") || !info?.asset) return;
      const id = ++runId;
      ring = [];
      startedAt = Date.now();
      set({ flow: { ...IDLE, state: "downloading", version: info.latest } });
      useStore.getState().setStickyToast("update-available", null); // the announcement is answered
      useStore.getState().showToast(t("updates.toast.downloading", { version: info.latest }), undefined, "info");
      try {
        await api.updateDownload(info.latest, (e) => onEvent(id, e));
      } catch (e) {
        if (id === runId && (get().flow.state === "downloading" || get().flow.state === "verifying")) fail("download", friendlyError(e));
      }
    },

    cancelUpdate: () => {
      if (get().flow.state !== "downloading") return;
      runId++; // late events of this download are ignored
      set({ flow: IDLE });
      void api.updateCancel().catch(() => undefined);
      useStore.getState().showToast(t("updates.toast.cancelled"), undefined, "info");
    },

    // Later / Not now: keep the package; it is installed when the app quits
    deferUpdate: () => {
      const f = get().flow;
      if (f.state !== "ready" && f.state !== "waiting") return;
      clearCountdown();
      toast(null);
      set({ askedFor: f.version });
      setFlow({ state: "deferred", countdown: null, asking: "none" });
      void api.updateDefer(true).catch(() => undefined); // this run only: the package is installed when the app quits
    },

    cancelRestart: () => {
      if (get().flow.state === "waiting") {
        setFlow({ state: "deferred", countdown: null, asking: "none" });
        void api.updateDefer(true).catch(() => undefined);
      }
    },

    restartToUpdate: async () => {
      const f0 = get().flow;
      if (restarting || !(f0.state === "ready" || f0.state === "deferred" || (f0.state === "failed" && f0.canReinstall))) return;
      restarting = true;
      try {
        clearCountdown();
        toast(null);
        void api.updateDefer(false).catch(() => undefined); // restarting now: no install at quit on top of it
        const st = useStore.getState();
        st.setStickyToast(RESTART_STOPPED, null); // a new attempt: the note of the last one goes, and so does its timer
        stickyTimer.cancel(RESTART_STOPPED);
        let draftSaved = false;
        const stay = (asking: AskVariant) => setFlow({ state: "ready", countdown: null, asking });
        if (st.compose) {
          if (st.compose.outboxId) {
            // a scheduled message stays scheduled as it was; unsaved edits to it are lost
            if (st.composeDirty) {
              const c = await st.choose({
                title: t("updates.ask.discardTitle"),
                body: t("updates.ask.discardBody"),
                choices: [
                  { id: "keep", label: t("updates.action.keepEditing") },
                  { id: "restart", label: t("updates.action.restartDiscard"), kind: "danger" },
                ],
              });
              if (c !== "restart") return stay("scheduled");
              st.setComposeDirty(false);
            }
          } else if (st.composeDirty) {
            // a saver that throws is a failed save too (the restart must never end without a word)
            const saved = await (async () => {
              try {
                return st.composeSaver ? await st.composeSaver({ quiet: true }) : false;
              } catch {
                return false;
              }
            })();
            if (saved !== true) {
              // sticky: the save can take seconds on a slow server, and a toast of a few seconds was gone before anyone looked (QA BUG-13)
              st.setStickyToast(RESTART_STOPPED, { text: t(RESTART_STOPPED_TEXT), kind: "error", closeLabel: t("common.close") });
              stickyTimer.arm(RESTART_STOPPED);
              void api.updateNote(`restart not started: the draft could not be saved (${useStore.getState().draftError || "no error text"}); the message stays open`).catch(() => undefined);
              return stay("dirty");
            }
            draftSaved = true;
            st.setComposeDirty(false);
          }
          await st.openCompose(null);
        }
        if (!(await waitForSends())) return;
        setFlow({ state: "installing", countdown: null, asking: "none", stage: null, message: "", canReinstall: false });
        try {
          await api.updateInstall(true, draftSaved);
        } catch (e) {
          fail("install", friendlyError(e).replace(/\.$/, ""));
        }
      } catch (e) {
        // anything else that went wrong before the installer started must not end without a word
        useStore.getState().setStickyToast(RESTART_STOPPED, { text: t("updates.restartFailed", { error: friendlyError(e).replace(/\.$/, "") }), kind: "error", closeLabel: t("common.close") });
        void api.updateNote(`restart not started: ${friendlyError(e)}`).catch(() => undefined);
        if (get().flow.state === "waiting") setFlow({ state: "ready", countdown: null, asking: "none" });
      } finally {
        restarting = false;
      }
    },

    // F6 "Try again": install again when only the install failed, else download again
    retryUpdate: () => {
      const f = get().flow;
      if (f.state !== "failed") return;
      if (f.canReinstall) void get().restartToUpdate();
      else void get().startUpdate("card");
    },

    // F6 "Download from GitHub instead": the installer in the browser (the release page on macOS or when the link is not safe)
    openFallback: () => {
      const { update } = get();
      const info: UpdateInfo | null | undefined = update?.info;
      if (!info) return;
      const a = info.asset;
      const direct = a && a.urlOk && update?.platform.os !== "macos" && !a.name.endsWith(".app.tar.gz");
      void openUpdateLink(direct ? a.url : info.releaseUrl, true);
    },

    // after a restart: tell how the update went (once), before the first check. The toast stays until it is closed (or 30 s): the
    // person is often not looking when the window comes back, and a toast of a few seconds was missed (QA BUG-12). The backend keeps
    // the result until this page says it showed it, so a window that died before the person saw it tells it again after its restart.
    startupCheck: async () => {
      try {
        const s = await api.updateStartupState();
        const st = useStore.getState();
        const key = "update-result";
        if (s.outcome === "updated") {
          st.setStickyToast(key, { text: t(s.draft ? "updates.result.updatedDraft" : "updates.result.updated", { version: s.version ?? "" }), kind: "success", closeLabel: t("common.close") });
        } else if (s.outcome === "failed") {
          st.setStickyToast(key, {
            text: t("updates.result.failed", { version: s.version ?? "" }),
            kind: "error",
            actions: [{ label: t("updates.action.open"), run: () => get().openSettingsAbout(false) }],
            closeLabel: t("common.close"),
          });
        } else {
          return;
        }
        stickyTimer.arm(key);
        await api.updateStartupAck();
      } catch {
        /* an old backend or the browser without the mock: nothing to tell */
      }
    },
  };
});

/** Download progress in whole percent (null while the total is unknown). */
export const pct = (f: UpdateFlow): number | null => (f.total ? Math.min(100, Math.floor((f.received / f.total) * 100)) : null);

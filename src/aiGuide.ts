// The one toast for an AI Assistant problem (1.0.6): the AI Assistant is not set up, or a call failed. It stays until it is answered (no timer),
// says what did not work, why, and what to do next, and has the buttons "Open AI Assistant settings" (which puts the cursor in the field
// the problem is about) and, where trying again can help, "Try again". Summarize, Translate and Write with AI all use it, in the main window and
// in the reader and compose windows (there the settings open in the main window, through the dialog request of the pop-out channel).
// The rules for sorting an error are in src/aiProblem.ts.
import { api } from "./api";
import { aiProblemButtons, aiProblemText, classifyAiError, NOT_SET_UP, type AiFeature, type AiProblem } from "./aiProblem";
import { t } from "./i18n";
import { friendlyError, useStore } from "./store";

/** The key of the toast: there is only ever one, a new problem replaces the one on screen in place. */
export const AI_PROBLEM_KEY = "ai-problem";

/** The feature of the toast on screen and whether its "Try again" belongs to what is on screen (a summary of this conversation, the message being written). */
let shown: { feature: AiFeature; tied: boolean; notSetUp: boolean } | null = null;

/** The first field of the AI Assistant tab that is still empty (the address, then the model). */
async function missingField(): Promise<"aiBaseUrl" | "aiModel"> {
  try {
    const [endpoint, model] = await Promise.all([api.getSetting("ai_endpoint"), api.getSetting("ai_model")]);
    if (!endpoint?.trim()) return "aiBaseUrl";
    if (!model?.trim()) return "aiModel";
  } catch {
    /* the address is the first thing to fill in */
  }
  return "aiBaseUrl";
}

/** Settings > AI Assistant, with the cursor in the field. In a reader or compose window this asks the main window (src/popout/readerBridge.ts, ComposeView.tsx). */
export async function openAiSettings(focus?: AiProblem["focus"]): Promise<void> {
  const field = focus === "missing" ? await missingField() : focus;
  useStore.getState().setDialog({ type: "settings", tab: "ai", focus: field, nonce: Date.now() });
}

/** The AI Assistant has an address and a model: the flag of the store, read again from the settings once when it says no (it may have been set in another window). */
export async function aiReady(): Promise<boolean> {
  if (useStore.getState().aiConfigured) return true;
  await useStore.getState().refreshAi();
  return useStore.getState().aiConfigured;
}

/**
 * Show the toast for a problem. `raw` is the error of the call (`NOT_SET_UP` for a feature that finds the Assistant not set up before
 * it asks). `retry` makes the "Try again" button; `tied`: that retry only makes sense while the thing it is for is still there, so
 * `leaveAiContext` removes the toast when it is gone. The person's own Cancel is no problem: returns false and shows nothing.
 */
export function showAiProblem(raw: unknown, o: { feature: AiFeature; retry?: () => void; tied?: boolean }): boolean {
  const p = classifyAiError(raw);
  if (!p) return false;
  const settings = { label: () => t("reading.aiProblem.openSettings"), run: () => void openAiSettings(p.focus) };
  const again = { label: () => t("reading.aiProblem.tryAgain"), run: () => o.retry?.() };
  shown = { feature: o.feature, tied: !!o.retry && !!o.tied && p.retry, notSetUp: p.kind === "notConfigured" };
  useStore.getState().setStickyToast(AI_PROBLEM_KEY, {
    // a function: the toast is written again in the language in use when the person switches language while it is on screen
    text: () => aiProblemText(o.feature, p, friendlyError(raw)),
    kind: p.kind === "notConfigured" ? "info" : "error",
    actions: aiProblemButtons(p, !!o.retry).map((b) => (b === "settings" ? settings : again)),
    closeLabel: () => t("common.close"),
    escCloses: true,
    guide: true,
  });
  return true;
}

export const showAiNotSetUp = (feature: AiFeature) => showAiProblem(NOT_SET_UP, { feature });

/**
 * The AI settings were saved and the Assistant now has an address and a model: the toast "AI Assistant is not set up" is answered, so it goes (v1.0.6 QA round 3: it
 * stayed on screen after the settings were saved). Any other problem (a refused key, an unknown model) stays: saving does not say that it is fixed.
 */
export function aiSettingsSaved(): void {
  if (shown?.notSetUp && useStore.getState().aiConfigured) {
    shown = null;
    useStore.getState().setStickyToast(AI_PROBLEM_KEY, null);
  }
}

/**
 * The person starts a new AI request (Summarize, Translate, Write with AI, also through "Try again"): the problem of the one before is no longer the truth, so its toast goes at once.
 * If the new request fails, its own toast shows (`showAiProblem`); if the Assistant is not set up, the "not set up" one does.
 */
export function clearAiProblem(): void {
  shown = null;
  useStore.getState().setStickyToast(AI_PROBLEM_KEY, null);
}

/** What a "Try again" was for is gone (another conversation, the message was closed): the toast goes with it. One without a retry stays, it is about the settings. */
export function leaveAiContext(feature: AiFeature): void {
  if (shown && shown.feature === feature && shown.tied) {
    shown = null;
    useStore.getState().setStickyToast(AI_PROBLEM_KEY, null);
  }
}

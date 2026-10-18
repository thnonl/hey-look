/**
 * What went wrong with an AI Assistant call, in words a person can act on (1.0.6). One place sorts every error of the three features
 * (Summarize, Translate, Write with AI) into a problem kind and says which settings field fixes it and whether trying again can help;
 * src/aiGuide.ts turns that into the one toast that stays until it is answered.
 * Pure (no store, no backend): scripts/test-ai-problem.mjs runs it.
 */
import { parseCoded } from "./backendErrors.ts";
import { t } from "./i18n/index.ts";

export type AiFeature = "summarize" | "translate" | "write";

export type AiProblemKind =
  | "notConfigured" // no address or no model saved
  | "auth" // 401 / 403: the provider refused the key
  | "unreachable" // no answer from the address (DNS, refused, TLS, no network, a malformed address)
  | "badAddress" // 404 without a word about a model: the address is not an AI provider's
  | "model" // the provider does not know the model name
  | "busy" // 429 and 5xx
  | "unreadable" // a 200 answer the app cannot use
  | "timeout" // the 3 minute limit of a request, or the 15 minutes of a translation
  | "other"; // anything else: the (already cut) sentence of the error is shown

/** The settings fields the AI Assistant tab can put the cursor in (the ids are `set-<name>`). "missing": the first one that is still empty. */
export type AiField = "aiBaseUrl" | "aiKey" | "aiModel";

export interface AiProblem {
  kind: AiProblemKind;
  /** the HTTP status the provider answered with, when it did */
  status?: number;
  /** trying the same request again may work (a busy provider, a slow answer, a lost connection) */
  retry: boolean;
  /** where the cursor goes in Settings > AI Assistant */
  focus?: AiField | "missing";
}

/** The error text of a call that finds nothing saved to call (the backend's own text for it): what the pre-check of a feature reports. */
// i18n-ok: a coded error, shown as the problem "not set up" (the backend sends the same text)
export const NOT_SET_UP = "AI_NOT_CONFIGURED: AI not configured: set endpoint and model in Settings > AI";

const NO_MODEL = /\bmodel/i;
const MODEL_REFUSED = /not found|does ?n[o’']t exist|unknown|invalid|unsupported|not supported|no such|not available|no access|not_found/i;
/** An error of the connection itself (reqwest's words): the address cannot be reached or is not an address at all. */
const NETWORK = /error sending request|dns error|failed to lookup|connect|connection|refused|unreachable|tcp|timed out|timeout|certificate|tls|ssl|handshake|builder error|relative url|invalid (url|port|domain|ip)|\burl\b|scheme|error decoding response body|incomplete message|reset|broken pipe|no route|network/i;
/** The address itself is malformed: trying again cannot help. */
const MALFORMED = /builder error|relative url|invalid (url|port|domain|ip)|scheme/i;

function http(status: number, detail: string): AiProblem {
  if (status === 401 || status === 403) return { kind: "auth", status, retry: false, focus: "aiKey" };
  if (status === 429 || status >= 500) return { kind: "busy", status, retry: true };
  if (status === 404) {
    return NO_MODEL.test(detail) ? { kind: "model", status, retry: false, focus: "aiModel" } : { kind: "badAddress", status, retry: false, focus: "aiBaseUrl" };
  }
  if ((status === 400 || status === 422) && NO_MODEL.test(detail) && MODEL_REFUSED.test(detail)) return { kind: "model", status, retry: false, focus: "aiModel" };
  return { kind: "other", status, retry: false };
}

/**
 * The problem an error of an AI call stands for; `null` for the person's own Cancel (nothing to tell them).
 * Handles the coded errors of src-tauri/src/ai.rs and the UI's own (AI_TIMEOUT, AI_TIMEOUT_TOTAL) and the plain text of a failed connection.
 */
export function classifyAiError(raw: unknown): AiProblem | null {
  const s = String(raw instanceof Error ? raw.message : raw).replace(/^Error:\s*/, "").trim();
  const c = parseCoded(s);
  if (c) {
    switch (c.code) {
      case "AI_CANCELLED":
        return null;
      case "AI_NOT_CONFIGURED":
        return { kind: "notConfigured", retry: false, focus: "missing" };
      case "AI_TIMEOUT":
      case "AI_TIMEOUT_TOTAL":
        return { kind: "timeout", retry: true };
      case "AI_BAD_RESPONSE":
        return { kind: "unreadable", retry: true };
      case "AI_HTTP":
        return http(Number(c.params.status), c.params.detail ?? "");
      default:
        return { kind: "other", retry: false };
    }
  }
  if (NETWORK.test(s)) return { kind: "unreachable", retry: !MALFORMED.test(s), focus: "aiBaseUrl" };
  return { kind: "other", retry: true };
}

/** The buttons of the toast, in order: "Try again" first where trying again is the likely cure, else the settings first. */
export function aiProblemButtons(p: AiProblem, canRetry: boolean): ("tryAgain" | "settings")[] {
  return p.retry && canRetry ? ["tryAgain", "settings"] : ["settings"];
}

/**
 * The three lines of the toast, in the language in use now: what did not work, why, and what to do next (joined by line breaks; the toast
 * paints the first one bold). `other` is the sentence of the error itself for a problem that has no sentence of its own.
 */
export function aiProblemText(feature: AiFeature, p: AiProblem, other: string): string {
  // (an Assistant that is not set up is not a failure of this feature: the title says what is wrong, whichever feature asked)
  const title = p.kind === "notConfigured" ? t("reading.aiProblem.title.notSetUp") : t(`reading.aiProblem.title.${feature}`);
  const cause = p.kind === "other" ? other : t(`reading.aiProblem.${p.kind}.cause`, { status: p.status ?? "" });
  const step = t(`reading.aiProblem.${p.kind}.step`);
  return [title, cause, step].join("\n");
}

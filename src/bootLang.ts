// The saved language, applied before anything is drawn.
//
// The Language setting lives in the backend's settings ("prefs", read with get_setting), which is asynchronous. The app used to apply it
// in store.init(), after the first render had started, so a sentence made in between (a toast from an event the backend sent at start-up,
// a title, an error) was written in English and stayed English. main.tsx now waits for `applySavedLanguage` before it renders the app
// (and so before any listener exists); store.init() applies the same setting again, which changes nothing.
// A language other than English is a chunk of its own (src/i18n/lang-<code>.ts): it is fetched here, so the first frame is already in it
// (the start screen of index.html covers the window meanwhile). If the chunk cannot be fetched the app starts in English; store.init() tries once more.
// Loadable by `node --experimental-strip-types` (scripts/test-boot-lang.mjs): no imports except the i18n module.
import { switchLanguage } from "./i18n/index.ts";

/** Read the saved preferences with `getSetting` and apply their language; English when nothing is saved or the read fails. */
export async function applySavedLanguage(getSetting: (key: string) => Promise<string | null>): Promise<void> {
  try {
    const raw = await getSetting("prefs");
    const language: unknown = raw ? (JSON.parse(raw) as { language?: unknown } | null)?.language : undefined;
    await switchLanguage(typeof language === "string" ? language : undefined);
  } catch {
    /* unreadable or missing, or the language chunk could not be fetched: the language in use (English at start) until store.init() has the preferences */
  }
}

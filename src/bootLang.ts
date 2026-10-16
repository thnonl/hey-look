// The saved language, applied before anything is drawn.
//
// The Language setting lives in the backend's settings ("prefs", read with get_setting), which is asynchronous. The app used to apply it
// in store.init(), after the first render had started, so a sentence made in between (a toast from an event the backend sent at start-up,
// a title, an error) was written in English and stayed English. main.tsx now waits for `applySavedLanguage` before it renders the app
// (and so before any listener exists); store.init() applies the same setting again, which changes nothing.
// Loadable by `node --experimental-strip-types` (scripts/test-boot-lang.mjs): no imports except the i18n module.
import { setLangPref } from "./i18n/index.ts";

/** Read the saved preferences with `getSetting` and apply their language; English when nothing is saved or the read fails. */
export async function applySavedLanguage(getSetting: (key: string) => Promise<string | null>): Promise<void> {
  try {
    const raw = await getSetting("prefs");
    const language: unknown = raw ? (JSON.parse(raw) as { language?: unknown } | null)?.language : undefined;
    setLangPref(typeof language === "string" ? language : undefined);
  } catch {
    /* unreadable or missing: English until store.init() has the preferences */
  }
}

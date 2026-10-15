import { useSyncExternalStore } from "react";
import { getLang, langVersion, subscribeLang, t } from "./index.ts";
import type { Lang } from "./index.ts";

/** Call once in a component that shows text: it re-renders when the language changes. Returns `t`. */
export function useT(): typeof t {
  useSyncExternalStore(subscribeLang, langVersion);
  return t;
}
/** The language in use, re-rendering on change (for components that format dates / numbers without calling `t`). */
export function useLang(): Lang {
  useSyncExternalStore(subscribeLang, langVersion);
  return getLang();
}

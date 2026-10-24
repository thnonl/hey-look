import { useEffect, useRef } from "react";
import { useStore } from "../store";

/**
 * Esc closes a dialog that is opened on top of another one (the CalDAV connect dialog and the New calendar dialog over Settings) and nothing else: the dialog below has its own Esc handler on
 * the window, so this one takes the key first, in the capture phase. A question on top (store `ask`) takes the key itself. `closeIf` says whether the dialog may close right now (not while it saves).
 */
export function useNestedEsc(close: () => void) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || useStore.getState().ask) return;
      e.stopPropagation();
      ref.current();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
}

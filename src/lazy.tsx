import { type ComponentType, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { useT } from "./i18n/react";
import { friendlyError, useStore } from "./store";
import { LAZY_LOOK_MS, loadLazy, peekLazy } from "./lazyLoad";

// The React side of loading a part on demand (1.0.7 WP9d, REQ-9.2.4 / 9.2.5, src/lazyViews.tsx has the parts):
//   - a part that is already loaded is drawn in the same render (no empty step), so a prefetched editor opens as fast as before;
//   - one that is not there yet draws its `frame` at once (a dialog's frame, the compose shell, nothing for a pane) and, 150 ms after it was asked for, the loading look in the place where it
//     will appear (the existing ring and "Loading…");
//   - one that cannot be loaded (after the retry) is not opened: the toast "Failed: …", `failed` undoes what the click had started (the dialog closes, the Calendar goes back to Mail), and the
//     next try loads again.

/** The existing loading look (MessageList footer, attachment preview): the ring and "Loading…", centred in the place of the part. */
export function LazyLoading() {
  const tr = useT();
  return (
    <div className="lazy-load" role="status" aria-busy="true">
      <span className="spin" aria-hidden /> {tr("common.loading")}
    </div>
  );
}

/** True once `ms` have passed since this mounted (the part was asked for) and `on` is still true. */
export function useAfter(on: boolean, ms: number = LAZY_LOOK_MS): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) return;
    const id = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(id);
  }, [on, ms]);
  return on && late;
}

/** The toast of a part that could not be loaded. */
export function reportLazyFailure(e: unknown): void {
  useStore.getState().showToast(() => t("errors.toast.failed", { error: friendlyError(e) }), undefined, "error");
}

/**
 * A dialog frame replaced by the dialog itself would play the opening animation of the dialog a second time (a flicker). A dialog that is loaded on demand (its frame was drawn from
 * the first render) therefore opens without the animation, frame and dialog alike: the page carries this attribute while it is open (App.css `[data-lazy-handoff]` switches the opening
 * animations off) and loses it when the dialog closes. Taking it away earlier would start the animation of the dialog that is on screen. Counted: two such dialogs can overlap.
 */
const HANDOFF = "data-lazy-handoff";
let handoffs = 0;
function markHandoff(on: boolean): void {
  handoffs = Math.max(0, handoffs + (on ? 1 : -1));
  if (handoffs > 0) document.documentElement.setAttribute(HANDOFF, "");
  else document.documentElement.removeAttribute(HANDOFF);
}

export interface LazyViewOptions<M, P> {
  /** names the module in the cache, shared by the views of one chunk */
  key: string;
  /** the name the dev seam `#lazyfail=` answers to */
  kind: string;
  load: () => Promise<M>;
  pick: (m: M) => ComponentType<P>;
  /** drawn from the first render until the part is there; `late` is true 150 ms after the ask (then the loading look belongs in it). Default: nothing, then the loading look. */
  frame?: (props: P, late: boolean) => ReactNode;
  /** the frame is a dialog frame (see HANDOFF) */
  dialog?: boolean;
  /** the part could not be loaded: put back what the click started */
  failed?: (props: P, error: unknown) => void;
  /** a view that cannot be replaced by anything (a pop-out window): the failure shows a Retry button */
  retry?: boolean;
  /** another view of the same part tells the failure (the side menu of the Calendar next to its pane): no toast of its own */
  quiet?: boolean;
}

export function lazyView<M, P extends object>(o: LazyViewOptions<M, P>): ComponentType<P> {
  function Lazy(props: P) {
    const [mod, setMod] = useState<M | undefined>(() => peekLazy<M>(o.key));
    const [error, setError] = useState<unknown>(null);
    const [attempt, setAttempt] = useState(0);
    const asked = useRef(0);
    const late = useAfter(!mod && !error);
    const propsRef = useRef(props);
    propsRef.current = props;
    useEffect(() => {
      if (mod) return;
      let live = true;
      const mine = ++asked.current;
      setError(null);
      loadLazy(o.key, o.load, o.kind).then(
        (m) => live && mine === asked.current && setMod(m),
        (e: unknown) => {
          if (!live || mine !== asked.current) return;
          setError(e ?? new Error("failed"));
          if (!o.quiet) reportLazyFailure(e);
          o.failed?.(propsRef.current, e);
        },
      );
      return () => void (live = false);
    }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps
    // the frame is up from the first render: the dialog that replaces it must not play its opening animation again (see HANDOFF)
    const framedAtStart = useRef(!mod && !!o.dialog);
    useLayoutEffect(() => {
      if (!framedAtStart.current) return;
      markHandoff(true);
      return () => markHandoff(false);
    }, []);
    if (mod) {
      const View = o.pick(mod);
      return <View {...props} />;
    }
    if (error && o.retry) return <LazyRetry onRetry={() => setAttempt((n) => n + 1)} />;
    if (error) return null;
    return <>{o.frame ? o.frame(props, late) : late ? <LazyLoading /> : null}</>;
  }
  return Lazy;
}

/** The failure of a view that has no other place to be (a pop-out window): the retry button (the words are the existing "Retry"). */
function LazyRetry({ onRetry }: { onRetry: () => void }) {
  const tr = useT();
  return (
    <div className="lazy-load" role="alert">
      <button className="btn" onClick={onRetry}>{tr("common.retry")}</button>
    </div>
  );
}


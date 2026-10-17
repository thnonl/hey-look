import { useEditorState, type Editor } from "@tiptap/react";
import { Ellipsis } from "lucide-react";
import { Fragment, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { FloatingMenu, type MenuItem } from "../components/ui";
import { useT } from "../i18n/react";
import { useStore } from "../store";
import { CONTROLS, MORE_ITEMS, readBarState, type BarState, type Ctx, type FormatHost, type Rove, type Variant } from "./controls";
import type { BaseFont } from "./emailHtml";
import { focusText } from "./commands";
import { layoutBar } from "./toolbarLayout";
import { pushRecent } from "./colors";

/** What a host can ask of its toolbar. */
export interface FormatBarApi {
  /** the focus goes to the toolbar (Alt+F10 in the body) */
  focus: () => void;
}

const same = (a: BarState | null, b: BarState | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The formatting toolbar of the message body (variant "compose") and of the signature and template editors ("compact"): one row that never wraps,
 * the controls of controls.tsx in their place, what does not fit in the "More formatting options" menu, most important first (spec-rich-text.md
 * REQ-10). It is a `toolbar` with one Tab stop (roving tabindex): the arrow keys, Home and End move between the controls, ArrowDown opens a
 * dropdown, Esc goes back to the text with the selection as it was.
 */
export function FormatBar({ editor, base, host, variant, apiRef }: { editor: Editor | null; base: BaseFont; host: FormatHost; variant: Variant; apiRef?: Ref<FormatBarApi> }) {
  const t = useT();
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const root = useRef<HTMLDivElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const [avail, setAvail] = useState(Infinity);
  const [active, setActive] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [picker, setPicker] = useState<string | null>(null);

  const st = useEditorState({ editor, selector: ({ editor: e }) => (e ? readBarState(e, base) : null), equalityFn: same });

  const controls = useMemo(() => CONTROLS.filter((c) => c.variants.includes(variant) && (c.id !== "picture" || !!host.insertPicture)), [variant, host.insertPicture]);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setAvail(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { visible, hidden } = layoutBar(controls, avail);
  const shown = controls.filter((c) => visible.includes(c.id)).sort((a, b) => a.order - b.order);
  const roveIds = [...shown.flatMap((c) => c.rove), "more"];
  const activeId = roveIds.includes(active) ? active : roveIds[0];
  const rove = useCallback((id: string): Rove => ({ "data-rove": id, tabIndex: id === activeId ? 0 : -1, onFocus: () => setActive(id) }), [activeId]);

  // the link popover is drawn under the Link button; once that button has moved into More, it is drawn under the More button
  useLayoutEffect(() => {
    if (!visible.includes("link") && moreBtn.current) host.link.btnRef.current = moreBtn.current;
  });

  useImperativeHandle(apiRef, () => ({
    focus: () => root.current?.querySelector<HTMLElement>(`[data-rove="${CSS.escape(activeId)}"]`)?.focus(),
  }), [activeId]);

  if (!editor || !st) return <div className="fmt-bar" role="toolbar" aria-label={t("compose.fmt.toolbar")} ref={root} />;

  const ctx: Ctx = {
    editor, t, base, st, host,
    recentColors: prefs.recentColors,
    highlightColor: prefs.highlightColor,
    rememberColor: (hex) => setPrefs({ recentColors: pushRecent(prefs.recentColors, hex) }),
    rememberHighlight: (hex) => setPrefs({ highlightColor: hex }),
    rove,
    openPicker: (id) => setPicker(id),
  };

  const hiddenControls = hidden.map((id) => controls.find((c) => c.id === id)!);
  const moreRows: MenuItem[] = [
    ...hiddenControls.flatMap((c) => c.more(ctx)),
    ...(hiddenControls.length ? [{ divider: true } as MenuItem] : []),
    ...MORE_ITEMS.filter((m) => m.variants.includes(variant)).map((m) => m.item(ctx)),
  ];

  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = root.current;
    // keys of a menu or palette drawn in a portal reach this handler through the React tree: they are not ours
    if (!el || !(e.target instanceof Node) || !el.contains(e.target)) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>("[data-rove]"));
    const at = items.indexOf((e.target as HTMLElement).closest<HTMLElement>("[data-rove]") as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      focusText(editor);
      return;
    }
    if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    let to = -1;
    if (e.key === "ArrowRight") to = (at + 1) % items.length;
    else if (e.key === "ArrowLeft") to = (at - 1 + items.length) % items.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = items.length - 1;
    if (to >= 0) {
      e.preventDefault();
      items[to].focus();
    }
  };

  const pickerControl = picker ? controls.find((c) => c.id === picker) : undefined;
  return (
    <div className="fmt-bar" role="toolbar" aria-label={t("compose.fmt.toolbar")} aria-orientation="horizontal" ref={root} onKeyDown={onKeyDown}>
      {shown.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 && shown[i - 1].group !== c.group && <span className="fmt-sep" role="separator" aria-orientation="vertical" />}
          {c.bar(ctx)}
        </Fragment>
      ))}
      <button
        ref={moreBtn}
        type="button"
        {...rove("more")}
        className="icon-btn fmt-btn fmt-more"
        title={t("compose.fmt.more")}
        aria-label={t("compose.fmt.more")}
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setMoreOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setMoreOpen(true);
          }
        }}
      >
        <Ellipsis size={14} aria-hidden="true" />
      </button>
      {moreOpen && <FloatingMenu anchor={moreBtn} items={moreRows} align="right" onClose={() => setMoreOpen(false)} />}
      {pickerControl?.picker?.(ctx, moreBtn, moreBtn, () => setPicker(null))}
    </div>
  );
}

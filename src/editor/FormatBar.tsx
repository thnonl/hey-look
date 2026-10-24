import { useEditorState, type Editor } from "@tiptap/react";
import { Ellipsis } from "lucide-react";
import { Fragment, Suspense, lazy, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { FloatingMenu, type MenuItem } from "../components/ui";
import { useT } from "../i18n/react";
import { useStore } from "../store";
import { CONTROLS, MORE_ITEMS, readBarState, type BarState, type Ctx, type FormatHost, type Rove, type Variant } from "./controls";
import type { BaseFont } from "./emailHtml";
import { focusText } from "./commands";
import { layoutBar } from "./toolbarLayout";
import { pushRecent } from "./colors";
import type { PainterMode } from "./formatPainter";
import type { MiniApi } from "./MiniToolbar";
import { useMiniShow } from "./useMiniShow";

/** What a host can ask of its toolbar. */
export interface FormatBarApi {
  /** the focus goes to the toolbar (Alt+F10 in the body) */
  focus: () => void;
  /** the Styles menu opens (Ctrl+Shift+S in the body), under the Styles box or, when that is in More, under the More button */
  openStyles: () => void;
}

/** Controls of the host that share the toolbar's arrow-key order and its one Tab stop (Compose: the Light / Dark preview switch). They come after More. */
export interface BarTrailing {
  /** the `rove` ids of the focusable elements, in order */
  ids: readonly string[];
  render: (rove: (id: string) => Rove) => ReactNode;
}

// the floating tools of the table, the link and the picture (insertUi.tsx) are fetched when the caret first gets into one of them
// the mini toolbar over a mouse selection (W3.3) is fetched the first time it shows (it is prefetched with the insert tools: kit.ts)
const MiniToolbar = lazy(() => import("./MiniToolbar"));
const InsertOverlays = lazy(() => import("./insertUi").then((m) => ({ default: m.InsertOverlays })));

const same = (a: BarState | null, b: BarState | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The formatting toolbar of the message body (variant "compose") and of the signature and template editors ("compact"): one row that never wraps,
 * the controls of controls.tsx in their place, what does not fit in the "More formatting options" menu, most important first (spec-rich-text.md
 * REQ-10). It is a `toolbar` with one Tab stop (roving tabindex): the arrow keys, Home and End move between the controls, ArrowDown opens a
 * dropdown, Esc goes back to the text with the selection as it was.
 */
export function FormatBar({ editor, base, host, variant, apiRef, trailing }: { editor: Editor | null; base: BaseFont; host: FormatHost; variant: Variant; apiRef?: Ref<FormatBarApi>; trailing?: BarTrailing }) {
  const t = useT();
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const root = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const [avail, setAvail] = useState(Infinity);
  const [active, setActive] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [picker, setPicker] = useState<string | null>(null);
  const [pickerAt, setPickerAt] = useState<RefObject<HTMLElement | null> | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openVia, setOpenVia] = useState<"key" | null>(null);

  const st = useEditorState({ editor, selector: ({ editor: e }) => (e ? readBarState(e, base) : null), equalityFn: same });
  const painter: PainterMode = st?.painter ?? "off";

  const controls = useMemo(() => CONTROLS.filter((c) => c.variants.includes(variant) && (c.id !== "picture" || !!host.insertPicture)), [variant, host.insertPicture]);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => setAvail(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { visible, hidden } = layoutBar(controls, avail);
  const shown = controls.filter((c) => visible.includes(c.id)).sort((a, b) => a.order - b.order);
  const roveIds = [...shown.flatMap((c) => c.rove), "more", ...(trailing?.ids ?? [])];
  const activeId = roveIds.includes(active) ? active : roveIds[0];
  const rove = useCallback((id: string): Rove => ({ "data-rove": id, tabIndex: id === activeId ? 0 : -1, onFocus: () => setActive(id) }), [activeId]);

  // the link popover is drawn under the Link button; once that button has moved into More, it is drawn under the More button
  useLayoutEffect(() => {
    if (!visible.includes("link") && moreBtn.current) host.link.btnRef.current = moreBtn.current;
  });

  const focusBar = () => root.current?.querySelector<HTMLElement>(`[data-rove="${CSS.escape(activeId)}"]`)?.focus();
  const miniApi = useRef<MiniApi | null>(null);
  const mini = useMiniShow(editor, { enabled: prefs.miniToolbar !== false, painterOn: painter !== "off", blocked: openId !== null || picker !== null || moreOpen || host.link.isOpen });
  const stylesShown = visible.includes("styles");
  useImperativeHandle(apiRef, () => ({
    // Alt+F10: the mini toolbar when it is on screen, else the formatting toolbar
    focus: () => {
      if (miniApi.current?.focus()) return;
      focusBar();
    },
    openStyles: () => {
      if (stylesShown) {
        setPicker(null);
        setOpenVia("key");
        setOpenId("styles");
      } else {
        setOpenVia("key");
        setPicker("styles");
      }
    },
  }), [activeId, stylesShown]);

  // a screen reader hears the format painter switch on (once or kept on) and off (W3.1: polite live message)
  const painterWas = useRef<PainterMode>("off");
  const [live, setLive] = useState("");
  useEffect(() => {
    if (painterWas.current === painter) return;
    painterWas.current = painter;
    setLive(t(painter === "off" ? "compose.painter.off" : painter === "once" ? "compose.painter.on" : "compose.painter.onSticky"));
  }, [painter, t]);

  if (!editor || !st) return <div className="fmt-tb" role="toolbar" aria-label={t("compose.fmt.toolbar")} ref={root}><div className="fmt-bar" ref={row} /></div>;

  const ctx: Ctx = {
    editor, t, base, st, host,
    recentColors: prefs.recentColors,
    highlightColor: prefs.highlightColor,
    rememberColor: (hex) => setPrefs({ recentColors: pushRecent(prefs.recentColors, hex) }),
    rememberHighlight: (hex) => setPrefs({ highlightColor: hex }),
    rove,
    openPicker: (id, at) => {
      setOpenVia(null);
      setPickerAt(at ?? null);
      setPicker(id);
    },
    open: openId,
    openVia,
    setOpen: (id) => {
      setOpenVia(null);
      setOpenId(id);
    },
  };

  const hiddenControls = hidden.map((id) => controls.find((c) => c.id === id)!);
  const moreRows: MenuItem[] = [
    ...hiddenControls.flatMap((c) => c.more(ctx)),
    ...(hiddenControls.length ? [{ divider: true } as MenuItem] : []),
    ...MORE_ITEMS.filter((m) => m.variants.includes(variant)).map((m) => m.item(ctx)),
  ];
  // an empty group (a hidden control whose rows are always in the menu anyway) leaves no divider behind
  while (moreRows.length && moreRows[0].divider) moreRows.shift();

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

  const pickerControl = picker ? controls.find((c) => c.id === picker) ?? MORE_ITEMS.find((m) => m.id === picker) : undefined;
  return (
    <>
    <div className="fmt-tb" role="toolbar" aria-label={t("compose.fmt.toolbar")} aria-orientation="horizontal" ref={root} onKeyDown={onKeyDown}>
      <div className="fmt-bar" ref={row}>
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
      {moreOpen && <FloatingMenu anchor={moreBtn} items={moreRows} align="right" tall onClose={() => setMoreOpen(false)} />}
      {pickerControl?.picker?.(ctx, pickerAt ?? moreBtn, pickerAt ?? moreBtn, () => (setPicker(null), setPickerAt(null)))}
      </div>
      {(st.inTable || st.inLink || st.onPicture) && <Suspense fallback={null}><InsertOverlays editor={editor} st={st} host={host} /></Suspense>}
      {mini.shown && <Suspense fallback={null}><MiniToolbar editor={editor} ctx={ctx} shown={mini.shown} onHide={mini.hide} onFocusBar={focusBar} apiRef={miniApi} /></Suspense>}
      {trailing?.render(rove)}
    </div>
    <span className="sr-only" role="status" aria-live="polite">{live}</span>
    </>
  );
}

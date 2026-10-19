// The interface of the Insert group that is not needed before it is used (a chunk of its own, fetched by React.lazy from controls.tsx and FormatBar.tsx):
//  - the Table button's popover (grid of 10 x 8, "Insert table...") and its options menu while the caret is in a table;
//  - the floating table tools above the table (Insert, Delete, Borders, Cell shading, Header row);
//  - the link bubble under a link the caret is in (address, Open link, Edit link, Remove link);
//  - the corner handles that resize a selected picture;
//  - the emoji picker.
// Spec: spec-rich-text.md REQ-30..34, REQ-40, design 4.4, 4.5.

import { ChevronDown, ExternalLink, Pencil, Unlink } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { FloatingMenu, Modal, type MenuItem } from "../components/ui";
import { readLinkTarget, removeLinkTarget } from "../components/LinkPopover";
import { fitInWindow } from "../fitInWindow";
import { intlLocale } from "../i18n";
import { fmtPattern } from "../i18n/format";
import { useLang, useT } from "../i18n/react";
import { checkLinkUrl } from "../linkUrl";
import { openExternal } from "../open";
import { useStore } from "../store";
import { HANDLE_SIZE } from "../pictureToolsLayout";
import { kbd, osNow } from "../platform";
import { fmtClock } from "../util";
import { Panel, Sw, useSwatchName, type PaletteClose } from "./ColorPalette";
import { STANDARD, sameColor, themeGrid } from "./colors";
import type { BarState, Ctx, FormatHost } from "./controls";
import { ALL_EMOJI, EMOJI_GROUPS, osEmojiKeys } from "./emojiData";
import { emojiName, loadEmojiNames, searchEmoji, type EmojiNames } from "./emojiSearch";
import { cleanRecentEmoji, pushRecentEmoji } from "./recentEmoji";
import {
  DEFAULT_COLS, DEFAULT_ROWS, MAX_COLS, MAX_ROWS, canMergeCells, canSplitCell, cellShading, hasHeaderRow, insertTable, mergeSelectedCells, setBorders, setShading, splitSelectedCell, tableAction, tableBorders, toggleHeaderRow, type TableAction,
} from "./tableCommands";
import type { TableBorders } from "./tableExtension";

type Anchor = RefObject<HTMLElement | null>;
const keep = (e: React.MouseEvent) => e.preventDefault(); // a press on a floating tool must not take the focus (and the caret) out of the editor

// ---------------------------------------------------------------- the table menu (the Table button)

const GRID_COLS = 10;
const GRID_ROWS = 8;

/** The structure and format rows of the table tools as menu rows (the Table button's menu while the caret is in a table). */
function tableRows(editor: Editor, t: Ctx["t"], openShading: () => void): MenuItem[] {
  const act = (a: TableAction) => () => void tableAction(editor, a);
  const b = tableBorders(editor.state);
  return [
    { label: t("compose.table.rowAbove"), onClick: act("rowAbove") },
    { label: t("compose.table.rowBelow"), onClick: act("rowBelow") },
    { label: t("compose.table.colLeft"), onClick: act("colLeft") },
    { label: t("compose.table.colRight"), onClick: act("colRight") },
    { divider: true },
    { label: t("compose.table.deleteRow"), onClick: act("deleteRow") },
    { label: t("compose.table.deleteCol"), onClick: act("deleteCol") },
    { label: t("compose.table.deleteTable"), onClick: act("deleteTable") },
    { divider: true },
    { label: t("compose.table.merge"), disabled: !canMergeCells(editor.state), onClick: () => void mergeSelectedCells(editor) },
    { label: t("compose.table.split"), disabled: !canSplitCell(editor.state), onClick: () => void splitSelectedCell(editor) },
    { divider: true },
    { label: t("compose.table.allBorders"), checked: b === "all", onClick: () => void setBorders(editor, "all") },
    { label: t("compose.table.outsideBorders"), checked: b === "outside", onClick: () => void setBorders(editor, "outside") },
    { label: t("compose.table.noBorders"), checked: b === "none", onClick: () => void setBorders(editor, "none") },
    { divider: true },
    { label: t("compose.table.headerRow"), kind: "check", checked: hasHeaderRow(editor.state), onClick: () => void toggleHeaderRow(editor) },
    { label: t("compose.table.shading"), hint: "›", onClick: openShading },
  ];
}

/** The Table button's popover: the grid (and "Insert table...") outside a table, the table's own menu inside one. */
export function TableMenu({ c, anchor, trigger, onClose }: { c: Ctx; anchor: Anchor; trigger: Anchor; onClose: () => void }) {
  const [view, setView] = useState<"menu" | "shading" | "dialog">("menu");
  if (view === "dialog") return <InsertTableDialog editor={c.editor} onClose={onClose} />;
  if (view === "shading") return <ShadingPalette editor={c.editor} anchor={anchor} onClose={(why) => (onClose(), why === "esc" && trigger.current?.focus({ preventScroll: true }))} />;
  if (c.st.inTable) return <FloatingMenu anchor={anchor} trigger={trigger} items={tableRows(c.editor, c.t, () => setView("shading"))} minWidth={210} onClose={onClose} />;
  return <TableGrid editor={c.editor} anchor={anchor} trigger={trigger} onClose={onClose} onDialog={() => setView("dialog")} />;
}

function TableGrid({ editor, anchor, trigger, onClose, onDialog }: { editor: Editor; anchor: Anchor; trigger: Anchor; onClose: () => void; onDialog: () => void }) {
  const t = useT();
  const [hot, setHot] = useState({ cols: 0, rows: 0 });
  const done = (why: PaletteClose) => {
    onClose();
    if (why === "esc") trigger.current?.focus({ preventScroll: true });
  };
  const pick = (cols: number, rows: number) => {
    onClose();
    insertTable(editor, cols, rows);
  };
  const label = hot.cols ? t("compose.table.grid", { cols: hot.cols, rows: hot.rows }) : t("compose.table.tip");
  return (
    <Panel anchor={anchor} onClose={done} label={t("compose.table.tip")} className="fmt-pop-table">
      <div className="tbl-grid" role="group" aria-label={t("compose.table.gridLabel")} onMouseLeave={() => setHot({ cols: 0, rows: 0 })}>
        {Array.from({ length: GRID_ROWS }, (_, r) =>
          Array.from({ length: GRID_COLS }, (_, c) => (
            <button
              key={`${r}-${c}`}
              type="button"
              className={`tbl-cell${c < hot.cols && r < hot.rows ? " on" : ""}`}
              data-row={r}
              data-col={c}
              aria-label={t("compose.table.grid", { cols: c + 1, rows: r + 1 })}
              onMouseEnter={() => setHot({ cols: c + 1, rows: r + 1 })}
              onFocus={() => setHot({ cols: c + 1, rows: r + 1 })}
              onClick={() => pick(c + 1, r + 1)}
            />
          )),
        )}
      </div>
      <div className="tbl-grid-label" aria-live="polite">{label}</div>
      <button type="button" className="fmt-more-colors" data-row={GRID_ROWS} data-col={0} onClick={onDialog}>
        {t("compose.table.insertDialog")}
      </button>
    </Panel>
  );
}

/** "Insert table...": the number of columns (1-20) and rows (1-100). */
function InsertTableDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const t = useT();
  const [cols, setCols] = useState(String(DEFAULT_COLS));
  const [rows, setRows] = useState(String(DEFAULT_ROWS));
  const [shown, setShown] = useState(false);
  const num = (s: string) => (/^\d{1,3}$/.test(s.trim()) ? Number(s) : NaN);
  const colsOk = num(cols) >= 1 && num(cols) <= MAX_COLS;
  const rowsOk = num(rows) >= 1 && num(rows) <= MAX_ROWS;
  const submit = () => {
    setShown(true);
    if (!colsOk || !rowsOk) return;
    onClose();
    insertTable(editor, num(cols), num(rows));
  };
  // (a plain box and not a form element: the content security policy has no form-action)
  const enter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <Modal title={t("compose.table.dialogTitle")} onClose={onClose} width={340}>
      <div className="tbl-dialog" onKeyDown={enter}>
        <label className="link-pop-field">
          <span>{t("compose.table.columns")}</span>
          <input type="number" min={1} max={MAX_COLS} value={cols} autoFocus aria-invalid={shown && !colsOk} onChange={(e) => setCols(e.target.value)} onFocus={(e) => e.target.select()} />
        </label>
        {shown && !colsOk && <div className="link-pop-err" role="alert">{t("compose.table.errColumns")}</div>}
        <label className="link-pop-field">
          <span>{t("compose.table.rows")}</span>
          <input type="number" min={1} max={MAX_ROWS} value={rows} aria-invalid={shown && !rowsOk} onChange={(e) => setRows(e.target.value)} onFocus={(e) => e.target.select()} />
        </label>
        {shown && !rowsOk && <div className="link-pop-err" role="alert">{t("compose.table.errRows")}</div>}
        <div className="link-pop-btns">
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className="btn primary" onClick={submit}>{t("compose.table.insert")}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Cell shading: the theme and standard colours of the font colour palette and "No color". */
function ShadingPalette({ editor, anchor, onClose }: { editor: Editor; anchor: Anchor; onClose: (why: PaletteClose) => void }) {
  const t = useT();
  const name = useSwatchName();
  const current = cellShading(editor.state) || null;
  const pick = (hex: string | null) => {
    setShading(editor, hex);
    onClose("pick");
  };
  let row = 0;
  return (
    <Panel anchor={anchor} onClose={onClose} label={t("compose.table.shading")} className="fmt-pop-color">
      <div className="fmt-pop-head">{t("compose.fmt.color.theme")}</div>
      <div className="fmt-grid" role="group" aria-label={t("compose.fmt.color.theme")}>
        {themeGrid().map((r) => {
          const ri = row++;
          return r.map((s, c) => <Sw key={`${ri}-${c}`} s={s} name={name(s)} row={ri} col={c} current={sameColor(current, s.hex)} onPick={pick} />);
        })}
      </div>
      <div className="fmt-pop-head">{t("compose.fmt.color.standard")}</div>
      <div className="fmt-grid" role="group" aria-label={t("compose.fmt.color.standard")}>
        {(() => {
          const ri = row++;
          return STANDARD.map((s, c) => <Sw key={c} s={s} name={name(s)} row={ri} col={c} current={sameColor(current, s.hex)} onPick={pick} />);
        })()}
      </div>
      <button type="button" className="fmt-more-colors" data-row={row} data-col={0} aria-pressed={current === null} onClick={() => pick(null)}>
        {t("compose.fmt.color.none")}
      </button>
    </Panel>
  );
}

// ---------------------------------------------------------------- where a floating tool goes

const edge = (n: number) => Math.round(n);
type Box = { left: number; top: number; right: number; bottom: number };

/** The box of an element of the editor on screen, kept up to date while the selection moves, the pane scrolls or the window changes size. */
function useBox(editor: Editor, find: () => HTMLElement | null): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  const findRef = useRef(find);
  findRef.current = find;
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = findRef.current()?.getBoundingClientRect();
        const next = r ? { left: edge(r.left), top: edge(r.top), right: edge(r.right), bottom: edge(r.bottom) } : null;
        setBox((b) => (b && next && b.left === next.left && b.top === next.top && b.right === next.right && b.bottom === next.bottom ? b : next));
      });
    };
    measure();
    editor.on("transaction", measure);
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(editor.view.dom);
    return () => {
      cancelAnimationFrame(raf);
      editor.off("transaction", measure);
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
      ro?.disconnect();
    };
  }, [editor]);
  return box;
}

/** The pane the editor scrolls in: a floating tool stays inside it. */
const paneOf = (editor: Editor): HTMLElement => (editor.view.dom.closest(".cp-editor, .rich-body") as HTMLElement | null) ?? editor.view.dom;

/** True while the editor has the focus or something of the tool (a button, a menu opened from it) has. */
function useWorking(editor: Editor, tool: RefObject<HTMLElement | null>, menus: number): boolean {
  const [on, setOn] = useState(editor.isFocused);
  useEffect(() => {
    const sync = () => setTimeout(() => setOn(editor.isFocused || !!tool.current?.contains(document.activeElement)), 0);
    editor.on("focus", sync);
    editor.on("blur", sync);
    sync();
    return () => {
      editor.off("focus", sync);
      editor.off("blur", sync);
    };
  }, [editor, tool]);
  return on || menus > 0;
}

// ---------------------------------------------------------------- the table tools (floating bar)

function ToolMenu({ label, items, onOpen }: { label: string; items: MenuItem[]; onOpen: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const set = (v: boolean) => (setOpen(v), onOpen(v));
  return (
    <div className="tbl-dd" ref={wrap}>
      <button ref={btn} type="button" className="tool-btn" aria-haspopup="menu" aria-expanded={open} onMouseDown={keep} onClick={() => set(!open)}>
        {label}
        <ChevronDown size={10} aria-hidden="true" />
      </button>
      {open && <FloatingMenu anchor={wrap} trigger={btn} items={items} minWidth={190} onClose={() => set(false)} />}
    </div>
  );
}

function TableTools({ editor }: { editor: Editor }) {
  const t = useT();
  // the checks of the menus and the Header row button follow every change of the document
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    editor.on("transaction", tick);
    return () => void editor.off("transaction", tick);
  }, [editor]);
  const bar = useRef<HTMLDivElement>(null);
  const [menus, setMenus] = useState(0);
  const [shadeOpen, setShadeOpen] = useState(false);
  const shadeWrap = useRef<HTMLDivElement>(null);
  const working = useWorking(editor, bar, menus + (shadeOpen ? 1 : 0));
  const box = useBox(editor, () => {
    const at = editor.state.selection.$from;
    for (let d = at.depth; d > 0; d--) if (at.node(d).type.name === "table") return editor.view.nodeDOM(at.before(d)) as HTMLElement | null;
    return null;
  });
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el || !box) return setPos(null);
    const pane = paneOf(editor).getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (box.bottom < pane.top || box.top > pane.bottom) return setPos(null); // the table is scrolled out of the pane
    const top = Math.max(pane.top + 4, box.top - h - 6);
    const { shift } = fitInWindow({ left: box.left, right: box.left + w, top, bottom: top + h }, pane.right, window.innerHeight, 6);
    setPos({ left: Math.max(pane.left + 4, box.left + shift), top });
  }, [box, editor, menus, working]);
  const upd = (n: number) => setMenus((m) => Math.max(0, m + n));
  const st = editor.state;
  const b = tableBorders(st);
  const act = (a: TableAction) => () => void tableAction(editor, a);
  const insertRows: MenuItem[] = [
    { label: t("compose.table.rowAbove"), onClick: act("rowAbove") },
    { label: t("compose.table.rowBelow"), onClick: act("rowBelow") },
    { label: t("compose.table.colLeft"), onClick: act("colLeft") },
    { label: t("compose.table.colRight"), onClick: act("colRight") },
  ];
  const deleteRows: MenuItem[] = [
    { label: t("compose.table.deleteRow"), onClick: act("deleteRow") },
    { label: t("compose.table.deleteCol"), onClick: act("deleteCol") },
    { label: t("compose.table.deleteTable"), onClick: act("deleteTable") },
  ];
  const borderRows: MenuItem[] = (["all", "outside", "none"] as TableBorders[]).map((k) => ({
    label: t(k === "all" ? "compose.table.allBorders" : k === "outside" ? "compose.table.outsideBorders" : "compose.table.noBorders"),
    checked: b === k,
    onClick: () => void setBorders(editor, k),
  }));
  const header = hasHeaderRow(st);
  return createPortal(
    <div
      ref={bar}
      className="img-tools tbl-tools"
      role="toolbar"
      aria-label={t("compose.table.tools")}
      style={pos && working ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden", pointerEvents: "none" }}
    >
      <ToolMenu label={t("compose.table.insert")} items={insertRows} onOpen={(o) => upd(o ? 1 : -1)} />
      <ToolMenu label={t("common.delete")} items={deleteRows} onOpen={(o) => upd(o ? 1 : -1)} />
      <button type="button" className="tool-btn" disabled={!canMergeCells(st)} onMouseDown={keep} onClick={() => void mergeSelectedCells(editor)}>{t("compose.table.merge")}</button>
      <button type="button" className="tool-btn" disabled={!canSplitCell(st)} onMouseDown={keep} onClick={() => void splitSelectedCell(editor)}>{t("compose.table.split")}</button>
      <ToolMenu label={t("compose.table.borders")} items={borderRows} onOpen={(o) => upd(o ? 1 : -1)} />
      <div className="tbl-dd" ref={shadeWrap}>
        <button type="button" className="tool-btn" aria-haspopup="dialog" aria-expanded={shadeOpen} onMouseDown={keep} onClick={() => setShadeOpen((o) => !o)}>
          {t("compose.table.shading")}
          <ChevronDown size={10} aria-hidden="true" />
        </button>
        {shadeOpen && <ShadingPalette editor={editor} anchor={shadeWrap} onClose={() => setShadeOpen(false)} />}
      </div>
      <button type="button" className={`tool-btn${header ? " on" : ""}`} aria-pressed={header} onMouseDown={keep} onClick={() => void toggleHeaderRow(editor)}>
        {t("compose.table.headerRow")}
      </button>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- the link bubble

function LinkBubble({ editor, host }: { editor: Editor; host: FormatHost }) {
  const t = useT();
  const bar = useRef<HTMLDivElement>(null);
  const target = readLinkTarget(editor);
  const focused = useWorking(editor, bar, 0);
  const box = useBox(editor, () => {
    const t0 = readLinkTarget(editor);
    if (!t0.inLink) return null;
    try {
      const a = editor.view.coordsAtPos(t0.from);
      const z = editor.view.coordsAtPos(t0.to);
      const fake = { getBoundingClientRect: () => ({ left: a.left, top: Math.min(a.top, z.top), right: z.right, bottom: Math.max(a.bottom, z.bottom) }) };
      return fake as unknown as HTMLElement;
    } catch {
      return null;
    }
  });
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el || !box) return setPos(null);
    const pane = paneOf(editor).getBoundingClientRect();
    if (box.bottom < pane.top || box.top > pane.bottom) return setPos(null);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const below = box.bottom + 6;
    const top = below + h > window.innerHeight - 6 ? Math.max(6, box.top - h - 6) : below;
    const { shift } = fitInWindow({ left: box.left, right: box.left + w, top, bottom: top + h }, window.innerWidth, window.innerHeight, 6);
    setPos({ left: box.left + shift, top });
  }, [box, editor, target.href]);
  const href = target.href;
  const check = checkLinkUrl(href);
  return createPortal(
    <div
      ref={bar}
      className="img-tools link-bubble"
      role="toolbar"
      aria-label={t("compose.link.bubble")}
      style={pos && focused ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden", pointerEvents: "none" }}
    >
      <span className="link-bubble-url" title={href}>{href.replace(/^mailto:/i, "")}</span>
      <button type="button" className="icon-btn" aria-label={t("compose.link.open")} title={t("compose.link.open")} disabled={!check.ok} onMouseDown={keep} onClick={() => check.ok && void openExternal(check.href).catch(() => undefined)}>
        <ExternalLink size={14} />
      </button>
      <button type="button" className="icon-btn" aria-label={t("compose.link.edit")} title={kbd(`${t("compose.link.edit")} (Ctrl+K)`)} onMouseDown={keep} onClick={host.link.open}>
        <Pencil size={14} />
      </button>
      <button type="button" className="icon-btn" aria-label={t("compose.link.remove")} title={t("compose.link.remove")} onMouseDown={keep} onClick={() => removeLinkTarget(editor, readLinkTarget(editor))}>
        <Unlink size={14} />
      </button>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- picture handles

const MIN_PICTURE = 40;
const CORNERS = [
  { id: "nw", x: 0, y: 0, dir: -1, cursor: "nwse-resize" },
  { id: "ne", x: 1, y: 0, dir: 1, cursor: "nesw-resize" },
  { id: "sw", x: 0, y: 1, dir: -1, cursor: "nesw-resize" },
  { id: "se", x: 1, y: 1, dir: 1, cursor: "nwse-resize" },
] as const;

/** Four handles at the corners of the selected picture: dragging one resizes it with the same proportions (the `width` of the picture, 40 px up to its own size). */
function PictureHandles({ editor }: { editor: Editor }) {
  // (6) only while the editor has the focus: with a dialog or another window in front the handles are not drawn (they were painted over Settings)
  const [focused, setFocused] = useState(editor.isFocused);
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    editor.on("focus", on);
    editor.on("blur", off);
    return () => {
      editor.off("focus", on);
      editor.off("blur", off);
    };
  }, [editor]);
  const img = () => {
    const sel = editor.state.selection;
    return sel instanceof NodeSelection && sel.node.type.name === "image" ? (editor.view.nodeDOM(sel.from) as HTMLImageElement | null) : null;
  };
  const box = useBox(editor, img);
  const pane = useBox(editor, () => paneOf(editor));
  const [live, setLive] = useState<Box | null>(null);
  if (!box || !pane || !focused) return null;
  const shown = live ?? box;
  const down = (e: React.PointerEvent<HTMLElement>, dir: number) => {
    const el = img();
    const sel = editor.state.selection;
    if (!el || !(sel instanceof NodeSelection) || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    const pane = paneOf(editor).getBoundingClientRect();
    const natural = el.naturalWidth || Math.round(startW * 4);
    const max = Math.max(MIN_PICTURE, Math.min(natural, Math.round(pane.width - 40)));
    const pos = sel.from;
    let w = Math.round(startW);
    // the window follows the pointer, wherever it goes during the drag
    const move = (ev: PointerEvent) => {
      w = Math.round(Math.min(max, Math.max(MIN_PICTURE, startW + dir * (ev.clientX - startX))));
      el.style.width = `${w}px`; // (a preview: the document changes once, when the button is let go)
      const r = el.getBoundingClientRect();
      setLive({ left: edge(r.left), top: edge(r.top), right: edge(r.right), bottom: edge(r.bottom) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      el.style.removeProperty("width");
      setLive(null);
      if (Math.abs(w - startW) >= 1) editor.chain().focus().setNodeSelection(pos).updateAttributes("image", { width: w }).run();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  // (BUG-2) the handles are drawn in a box that has the size of the pane the editor scrolls in and clips them: a picture that is scrolled out
  // of the pane keeps none of its handles over the To row or the attachment row; at the edge of the pane they are cut like the picture
  return createPortal(
    <div className="pic-handles" aria-hidden="true" style={{ left: pane.left, top: pane.top, width: pane.right - pane.left, height: pane.bottom - pane.top }}>
      {CORNERS.map((c) => (
        <i
          key={c.id}
          className="pic-handle"
          // (inside the corner of the picture, so a toolbar that is above, below or over the picture never touches one: pictureToolsLayout.ts)
          style={{ left: (c.x ? shown.right - HANDLE_SIZE : shown.left) - pane.left, top: (c.y ? shown.bottom - HANDLE_SIZE : shown.top) - pane.top, cursor: c.cursor }}
          onPointerDown={(e) => down(e, c.dir)}
        />
      ))}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- the overlays FormatBar mounts

/** The floating tools that belong to what the caret is in. */
export function InsertOverlays({ editor, st, host }: { editor: Editor; st: BarState; host: FormatHost }) {
  return (
    <>
      {st.inTable && <TableTools editor={editor} />}
      {st.inLink && !host.link.isOpen && <LinkBubble editor={editor} host={host} />}
      {st.onPicture && <PictureHandles editor={editor} />}
    </>
  );
}

// ---------------------------------------------------------------- symbol, date and time

/** The 24 common symbols of REQ-41. */
const SYMBOLS = "\u00a9 \u00ae \u2122 \u20ac \u00a3 \u00a5 \u00a7 \u00b6 \u00b0 \u00b1 \u00d7 \u00f7 \u2260 \u2264 \u2265 \u2192 \u2190 \u2191 \u2193 \u2022 \u2026 \u2014 \u2013 \u00bd".split(" ");

/** Insert > Symbol: a grid of 24 symbols; a click puts one at the caret. */
export function SymbolMenu({ c, anchor, trigger, onClose }: { c: Ctx; anchor: Anchor; trigger: Anchor; onClose: () => void }) {
  const t = useT();
  const done = (why: PaletteClose) => {
    onClose();
    if (why === "esc") trigger.current?.focus({ preventScroll: true });
  };
  const insert = (glyph: string) => {
    onClose();
    c.editor.chain().focus().insertContent(glyph).run();
  };
  return (
    <Panel anchor={anchor} onClose={done} label={t("compose.insert.symbol")} className="fmt-pop-symbol">
      <div className="emoji-grid" role="group" aria-label={t("compose.insert.symbol")}>
        {SYMBOLS.map((g, i) => (
          <button key={g} type="button" className="emoji-btn symbol-btn" data-row={Math.floor(i / 8)} data-col={i % 8} aria-label={g} onClick={() => insert(g)}>
            {g}
          </button>
        ))}
      </div>
    </Panel>
  );
}

/** The four ways Date & time writes now, in the language and the clock (12 / 24 hour) in use. */
export function dateTimeChoices(now: Date, intl: string): string[] {
  const secs = now.getTime() / 1000;
  const long = new Intl.DateTimeFormat(intl, { day: "numeric", month: "long", year: "numeric" }).format(now);
  return [
    fmtPattern(now, "dd/MM/yyyy"),
    new Intl.DateTimeFormat(intl, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now),
    `${long}, ${fmtClock(secs)}`,
    fmtClock(secs),
  ];
}

/** Insert > Date & time: the four formats as menu rows; the text goes in at the caret (it is text, not a field that updates). */
export function DateMenu({ c, anchor, trigger, onClose }: { c: Ctx; anchor: Anchor; trigger: Anchor; onClose: () => void }) {
  const items: MenuItem[] = dateTimeChoices(new Date(), intlLocale()).map((text) => ({ label: text, onClick: () => void c.editor.chain().focus().insertContent(text).run() }));
  return <FloatingMenu anchor={anchor} trigger={trigger} items={items} minWidth={250} onClose={onClose} />;
}

// ---------------------------------------------------------------- emoji

/** The emoji picker: a search box (names and keywords in the app's language and in English), the tabs "Recently used" and the 8 categories of 32; the hint names the system's own panel. */
export function EmojiMenu({ c, anchor, trigger, onClose }: { c: Ctx; anchor: Anchor; trigger: Anchor; onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  const recentPref = useStore((s) => s.prefs.recentEmoji);
  const setPrefs = useStore((s) => s.setPrefs);
  const known = useMemo(() => new Set(ALL_EMOJI), []);
  const recent = useMemo(() => cleanRecentEmoji(recentPref, known), [recentPref, known]);
  // tab 0 is "Recently used" (the one shown when there is any), then the categories
  const [tab, setTab] = useState(() => (recent.length > 0 ? 0 : 1));
  const [query, setQuery] = useState("");
  const [names, setNames] = useState<EmojiNames[]>([]); // (fetched with the picker: a chunk per language, never in the main bundle)
  useEffect(() => {
    let live = true;
    void loadEmojiNames(lang).then((n) => live && setNames(n)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [lang]);
  const keys = osEmojiKeys(osNow());
  const searchRef = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const searching = query.trim() !== "";
  const found = useMemo(() => (searching ? searchEmoji(query, ALL_EMOJI, names) : []), [searching, query, names]);
  const done = (why: PaletteClose) => {
    onClose();
    if (why === "esc") trigger.current?.focus({ preventScroll: true });
  };
  const insert = (glyph: string) => {
    setPrefs({ recentEmoji: pushRecentEmoji(recent, glyph) });
    onClose();
    c.editor.chain().focus().insertContent(glyph).run();
  };
  const group = tab > 0 ? EMOJI_GROUPS[tab - 1] : null;
  const shown = searching ? found : group ? group.emoji : recent;
  const title = group ? t(`compose.emoji.${group.id}` as const) : t("compose.emoji.recent");
  const nameOf = (e: string) => emojiName(e, names) ?? e;
  return (
    <Panel anchor={anchor} onClose={done} label={t("compose.insert.emoji")} className="fmt-pop-emoji" initialFocus="input.emoji-search">
      <input
        ref={searchRef}
        type="text"
        role="searchbox"
        className="emoji-search"
        value={query}
        placeholder={t("compose.emoji.search")}
        aria-label={t("compose.emoji.search")}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // (an input method confirms its word with Enter / Esc)
          if (e.key === "ArrowDown") {
            e.preventDefault();
            body.current?.querySelector<HTMLElement>(".emoji-grid button")?.focus();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (searching && found[0]) insert(found[0]);
          } else if (e.key === "Escape" && query !== "") {
            // Esc clears the box; in an empty box it closes the picker (the panel's own Esc)
            e.preventDefault();
            e.stopPropagation();
            setQuery("");
          }
        }}
      />
      <div
        ref={body}
        onKeyDown={(e) => {
          // Arrow Up from the top row (the tabs, or the first row of the results) goes back to the search box
          if (e.key !== "ArrowUp") return;
          const at = (e.target as HTMLElement).closest<HTMLElement>("button[data-row]");
          if (!at || !body.current) return;
          const top = Math.min(...Array.from(body.current.querySelectorAll<HTMLElement>("button[data-row]"), (b) => Number(b.dataset.row)));
          if (Number(at.dataset.row) !== top) return;
          e.preventDefault();
          e.stopPropagation();
          searchRef.current?.focus();
        }}
      >
        {!searching && (
          <div className="emoji-tabs" role="group" aria-label={t("compose.insert.emoji")}>
            {[null, ...EMOJI_GROUPS].map((x, i) => (
              <button
                key={x?.id ?? "recent"}
                type="button"
                className={`emoji-tab${i === tab ? " on" : ""}`}
                data-row={0}
                data-col={i}
                aria-pressed={i === tab}
                title={x ? t(`compose.emoji.${x.id}` as const) : t("compose.emoji.recent")}
                aria-label={x ? t(`compose.emoji.${x.id}` as const) : t("compose.emoji.recent")}
                onClick={() => setTab(i)}
              >
                {x ? x.emoji[0] : "\u{1F558}"}
              </button>
            ))}
          </div>
        )}
        {!searching && <div className="emoji-name" aria-live="polite">{title}</div>}
        {searching && found.length === 0 && names.length > 0 && <div className="emoji-empty" role="status">{t("compose.emoji.noResults")}</div>}
        <div className="emoji-grid" role="group" aria-label={searching ? t("compose.emoji.search") : title}>
          {shown.map((e, i) => (
            <button key={e} type="button" className="emoji-btn" data-row={1 + Math.floor(i / 8)} data-col={i % 8} aria-label={nameOf(e)} title={nameOf(e)} onClick={() => insert(e)}>
              {e}
            </button>
          ))}
        </div>
      </div>
      {keys && <div className="emoji-hint">{t("compose.insert.emojiHint", { keys })}</div>}
    </Panel>
  );
}

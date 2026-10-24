import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, ArrowUpDown, Bold, CalendarClock, CaseSensitive, ChevronDown, Highlighter, ImagePlus, IndentDecrease, IndentIncrease, Italic, Link2, List, ListOrdered, Minus,
  Omega, Paintbrush, PilcrowLeft, PilcrowRight, Plus, RemoveFormatting, Redo2, Replace, Search, Smile, Strikethrough, Subscript, Superscript, Table2, Underline as UnderlineIcon, Undo2, ZoomIn,
} from "lucide-react";
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { FloatingMenu, type MenuItem } from "../components/ui";
import type { Key, Params } from "../i18n";
import { useT } from "../i18n/react";
import { kbd, osNow } from "../platform";
import { FontColorPalette, HighlightPalette, type PaletteClose } from "./ColorPalette";
import { DEFAULT_FONT_COLOR, pushRecent } from "./colors";
import { LINE_HEIGHTS, type Align } from "./blockFormat";
import {
  selectionAlign, selectionDirection, selectionHasSpaceAfter, selectionLineHeight, selectionListStyle, selectionStyle, listKind, setDirection, type StyleName,
} from "./blockCommands";
import {
  applyStyle, changeIndent, chooseListStyle, clearFormatting, focusText, insertHorizontalLine, toggleScript, selectionColor, selectionFamily, selectionSize, setAlignment, setFamily, setHighlight,
  setSize, setSpaceAfterParagraph, setSpacing, setTextColor, type Uniform,
} from "./commands";
import type { BaseFont } from "./emailHtml";
import { painterClick, painterMode, type PainterMode } from "./formatPainter";
import { FONTS, SIZES, familyName, fontOf, normFamily, parseTypedSize } from "./fonts";
import { BAR_META, type Variant } from "./toolbarLayout";

export type { Variant };

// The controls of the formatting toolbar, as a registry: every control says where it sits (`group`, `order`), how long it stays in the bar when the
// bar gets narrow (`priority`, spec-rich-text.md 4.1), how wide it is, which toolbars have it (`variants`), how it looks in the bar and how it looks
// in the "More formatting options" menu once it does not fit. FormatBar.tsx lays them out. A later package (paragraph formatting, tables,
// pictures ...) adds its entries to CONTROLS (and to MORE_ITEMS for what always lives in the menu) and changes nothing else.

type T = ReturnType<typeof useT>;

/** What the toolbar needs to know about the editor, read after every transaction. */
export interface BarState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  subscript: boolean;
  superscript: boolean;
  bulletList: boolean;
  orderedList: boolean;
  canUndo: boolean;
  canRedo: boolean;
  family: Uniform<string>;
  size: Uniform<number>;
  color: Uniform<string>;
  highlight: Uniform<string>;
  /** the alignment over the selection (a mixed selection shows left) */
  align: Align | "left";
  /** the text direction over the selection: "ltr" / "rtl", null when the selection has both (REQ-43) */
  direction: "ltr" | "rtl" | null;
  /** the paragraph style (Normal, Heading 1-3, Quote, Code); null when the selection has several */
  style: StyleName | null;
  /** the line spacing ("1.5"; null = single, a mixed selection has no check) and whether every paragraph has space after it */
  lineHeight: string | null;
  lineHeightMixed: boolean;
  spaceAfter: boolean;
  /** the marker style of the selection's bulleted / numbered lists (null: none, or several) */
  bulletStyle: string | null;
  numberStyle: string | null;
  /** the caret is in a table / in a link / a picture is selected: the floating tools of insertUi.tsx belong to it */
  inTable: boolean;
  inLink: boolean;
  onPicture: boolean;
  /** the format painter: off, on for one use, or kept on (W3.1) */
  painter: PainterMode;
}

export function readBarState(editor: Editor, base: BaseFont): BarState {
  return {
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    underline: editor.isActive("underline"),
    strike: editor.isActive("strike"),
    subscript: editor.isActive("subscript"),
    superscript: editor.isActive("superscript"),
    bulletList: listKind(editor.state) === "bullet",
    orderedList: listKind(editor.state) === "ordered",
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
    family: selectionFamily(editor, base),
    size: selectionSize(editor, base),
    color: selectionColor(editor, "color", base),
    highlight: selectionColor(editor, "backgroundColor", base),
    align: selectionAlign(editor.state).value,
    direction: selectionDirection(editor.state).mixed ? null : selectionDirection(editor.state).value === "rtl" ? "rtl" : "ltr",
    style: selectionStyle(editor.state).value,
    lineHeight: selectionLineHeight(editor.state).value,
    lineHeightMixed: selectionLineHeight(editor.state).mixed,
    spaceAfter: selectionHasSpaceAfter(editor.state),
    bulletStyle: selectionListStyle(editor.state, false).value,
    numberStyle: selectionListStyle(editor.state, true).value,
    inTable: editor.isActive("table"),
    inLink: editor.isActive("link"),
    onPicture: editor.state.selection instanceof NodeSelection && editor.state.selection.node.type.name === "image",
    painter: painterMode(editor.state),
  };
}

/** What the host of the toolbar (Compose, RichEditor) provides: the link UI of its editor and, for a message, the picture button. */
export interface FormatHost {
  link: { open: (at?: unknown) => void; isOpen: boolean; btnRef: RefObject<HTMLButtonElement | null> };
  /** present when the editor takes pictures (the message body, the signature and the template editor) */
  insertPicture?: () => void;
  /** the message body shows the editor larger or smaller (REQ-49): the percentage and how it changes; not in a signature or template */
  zoom?: { value: number; set: (percent: number) => void };
  /** the message body has Find and replace (REQ-44): opens its panel */
  find?: (mode: "find" | "replace") => void;
}

/** Roving tabindex: one control of the toolbar is a Tab stop, the arrow keys move between the others. */
export interface Rove {
  "data-rove": string;
  tabIndex: 0 | -1;
  onFocus: () => void;
}

export interface Ctx {
  editor: Editor;
  t: T;
  base: BaseFont;
  st: BarState;
  host: FormatHost;
  recentColors: string[];
  highlightColor: string;
  rememberColor: (hex: string) => void;
  rememberHighlight: (hex: string) => void;
  rove: (id: string) => Rove;
  /** open a control's picker from the More menu (it opens under the More button) or, with `at`, under that element (a row of the Insert menu) */
  openPicker: (id: string, at?: RefObject<HTMLElement | null>) => void;
  /** which dropdown of the bar is open (font, size, align, styles, insert ...), and how to open or close one; `openVia` "key": the shortcut opened it, so Esc goes back to the text */
  open: string | null;
  openVia: "key" | null;
  setOpen: (id: string | null) => void;
}

export interface FormatControl {
  id: string;
  group: string;
  order: number;
  priority: number;
  width: number;
  variants: readonly Variant[];
  /** the focusable elements of the control in the bar (`rove` ids), in order */
  rove: readonly string[];
  /** the control in the bar */
  bar: (c: Ctx) => ReactNode;
  /** the rows of the More menu when the control does not fit in the bar */
  more: (c: Ctx) => MenuItem[];
  /** a control with a picker (menu or palette): the picker, drawn under `anchor` */
  picker?: (c: Ctx, anchor: RefObject<HTMLElement | null>, trigger: RefObject<HTMLElement | null>, close: () => void) => ReactNode;
}

/** Rows that always live in the More menu (after the controls that did not fit). */
export interface MoreEntry {
  id: string;
  variants: readonly Variant[];
  item: (c: Ctx) => MenuItem;
  /** a row that opens a menu (Line spacing): the menu, drawn under the More button */
  picker?: (c: Ctx, anchor: RefObject<HTMLElement | null>, trigger: RefObject<HTMLElement | null>, close: () => void) => ReactNode;
}

// ---------------------------------------------------------------- shared pieces

const keepSelection = (e: React.MouseEvent) => e.preventDefault(); // a click on the toolbar must not take the focus (and the caret) out of the editor

function Tool({ c, id, icon, label, tip, on, disabled, run, btnRef, haspopup, expanded }: {
  c: Ctx; id: string; icon: ReactNode; label: string; tip: string; on?: boolean; disabled?: boolean; run: (clicks: number) => void;
  btnRef?: RefObject<HTMLButtonElement | null>; haspopup?: "dialog"; expanded?: boolean;
}) {
  return (
    <button
      ref={btnRef}
      type="button"
      {...c.rove(id)}
      className={`icon-btn fmt-btn${on ? " on" : ""}`}
      title={tip}
      aria-label={label}
      aria-pressed={on}
      aria-disabled={disabled || undefined}
      aria-haspopup={haspopup}
      aria-expanded={expanded}
      onMouseDown={keepSelection}
      onClick={(e) => {
        if (disabled) return;
        run(e.detail); // (the click count: the format painter tells a double click from a click)
        if (!haspopup) focusText(c.editor); // the text keeps the focus (and the caret) after a toolbar button
      }}
    >
      {icon}
    </button>
  );
}

/** ArrowDown / Alt+ArrowDown on a dropdown trigger opens it. */
const opensOnDown = (open: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "ArrowDown" || (e.altKey && e.key === "ArrowDown")) {
    e.preventDefault();
    open();
  }
};

/** A bar entry that is one button and one row of the More menu: a toggle (pressed state) or, with `action`, a plain command (`off` greys it). */
function toggle(o: {
  id: string; label: Key; tip: Key | null; icon: ReactNode;
  on?: (s: BarState) => boolean; off?: (s: BarState) => boolean; run: (c: Ctx) => void; tipParams?: () => Params;
}): FormatControl {
  const tipOf = (c: Ctx) => (o.tip ? kbd(c.t(o.tip, o.tipParams?.())) : c.t(o.label));
  const isToggle = !!o.on;
  return {
    id: o.id, ...BAR_META[o.id], rove: [o.id],
    bar: (c) => <Tool c={c} id={o.id} icon={o.icon} label={c.t(o.label)} tip={tipOf(c)} on={isToggle ? o.on!(c.st) : undefined} disabled={o.off?.(c.st)} run={() => o.run(c)} />,
    more: (c) => [{ label: c.t(o.label), icon: o.icon, kind: "check", checked: isToggle ? o.on!(c.st) : undefined, disabled: o.off?.(c.st), onClick: () => o.run(c) }],
  };
}

const IC = 14;

// ---------------------------------------------------------------- the font box, the size box, the styles box

/** Where Esc sends the focus when a shortcut (Ctrl+Shift+S) opened the menu: back to the text. */
function useTextTrigger(editor: Editor): RefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement | null>(null);
  ref.current = { focus: () => focusText(editor) } as unknown as HTMLElement;
  return ref;
}

type MenuProps = { c: Ctx; anchor: RefObject<HTMLElement | null>; trigger: RefObject<HTMLElement | null>; onClose: () => void };

function FontMenu({ c, anchor, trigger, onClose }: MenuProps) {
  const cur = c.st.family;
  const baseName = familyName(c.base.family);
  const items: MenuItem[] = [
    { label: c.t("compose.fmt.fontDefault", { font: baseName }), checked: !cur.mixed && cur.value === null, onClick: () => setFamily(c.editor, null) },
    { divider: true },
    ...FONTS.map((f) => ({
      label: f.name,
      style: { fontFamily: f.stack },
      checked: !cur.mixed && cur.value !== null && fontOf(cur.value)?.name === f.name,
      onClick: () => setFamily(c.editor, f.stack),
    })),
  ];
  return <FloatingMenu anchor={anchor} trigger={trigger} items={items} minWidth={200} onClose={onClose} />;
}

function SizeMenu({ c, anchor, trigger, onClose }: MenuProps) {
  const cur = c.st.size;
  const items: MenuItem[] = SIZES.map((s) => ({ label: String(s), checked: !cur.mixed && cur.value !== null && Math.abs(cur.value - s) < 1e-6, onClick: () => setSize(c.editor, s) }));
  return <FloatingMenu anchor={anchor} trigger={trigger} items={items} minWidth={72} onClose={onClose} />;
}

/** The rows of the Styles menu: the style, its name, its key, how the row looks. */
const STYLE_ROWS: readonly { id: StyleName; label: Key; keys: string | null; look?: React.CSSProperties }[] = [
  { id: "normal", label: "compose.fmt.style.normal", keys: "Ctrl+Shift+N" },
  { id: "h1", label: "compose.fmt.style.h1", keys: "Ctrl+Alt+1", look: { fontWeight: 700, fontSize: "1.18em" } },
  { id: "h2", label: "compose.fmt.style.h2", keys: "Ctrl+Alt+2", look: { fontWeight: 700, fontSize: "1.08em" } },
  { id: "h3", label: "compose.fmt.style.h3", keys: "Ctrl+Alt+3", look: { fontWeight: 700 } },
  { id: "quote", label: "compose.fmt.style.quote", keys: null, look: { fontStyle: "italic" } },
  { id: "code", label: "compose.fmt.style.code", keys: null, look: { fontFamily: "Consolas, Menlo, 'Courier New', monospace" } },
];

function StylesMenu({ c, anchor, trigger, onClose }: MenuProps) {
  const text = useTextTrigger(c.editor);
  const items: MenuItem[] = STYLE_ROWS.map((r) => ({
    label: c.t(r.label),
    style: r.look,
    hint: r.keys ? kbd(r.keys) : undefined,
    checked: c.st.style === r.id,
    onClick: () => void applyStyle(c.editor, r.id),
  }));
  return <FloatingMenu anchor={anchor} trigger={c.openVia === "key" ? text : trigger} items={items} minWidth={190} onClose={onClose} />;
}

function Box({ c, id, width, text, style, label, tip, Menu }: {
  c: Ctx; id: string; width: number; text: string; style?: React.CSSProperties; label: string; tip: string; Menu: (p: MenuProps) => ReactNode;
}) {
  const open = c.open === id;
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <div className="fmt-dd" ref={wrap} style={{ width }}>
      <button
        ref={btn}
        type="button"
        {...c.rove(id)}
        className="fmt-box"
        title={tip}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={keepSelection}
        onClick={() => c.setOpen(open ? null : id)}
        onKeyDown={opensOnDown(() => c.setOpen(id))}
      >
        <span className="fmt-box-txt ellipsis" style={style}>{text}</span>
        <ChevronDown size={12} className="caret" aria-hidden="true" />
      </button>
      {open && <Menu c={c} anchor={wrap} trigger={btn} onClose={() => c.setOpen(null)} />}
    </div>
  );
}

const fontControl: FormatControl = {
  id: "font", ...BAR_META.font, rove: ["font"],
  bar: (c) => {
    const cur = c.st.family;
    const name = cur.mixed ? "" : cur.value ? (fontOf(cur.value)?.name ?? familyName(cur.value)) : familyName(c.base.family);
    const stack = cur.mixed ? undefined : cur.value ?? c.base.family;
    return <Box c={c} id="font" width={BAR_META.font.width} text={name} style={stack ? { fontFamily: normFamily(stack) } : undefined} label={c.t("compose.fmt.font")} tip={c.t("compose.fmt.font")} Menu={FontMenu} />;
  },
  more: (c) => [{ label: c.t("compose.fmt.font"), hint: "›", onClick: () => c.openPicker("font") }],
  picker: (c, anchor, trigger, close) => <FontMenu c={c} anchor={anchor} trigger={trigger} onClose={close} />,
};

/**
 * The size box is an editable combo (as in Word): type a number and press Enter (or Tab) to apply it; Esc or leaving the box puts the old value
 * back. The arrow button and ArrowDown open the list of the usual sizes. A number outside 1 - 400, or text that is no number, is not applied.
 */
function SizeCombo({ c }: { c: Ctx }) {
  const cur = c.st.size;
  const shown = cur.mixed || cur.value === null ? "" : String(cur.value);
  const [text, setText] = useState(shown);
  const [dirty, setDirty] = useState(false);
  const open = c.open === "size";
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const label = c.t("compose.fmt.fontSize");
  const optsLabel = c.t("compose.fmt.fontSizeOptions");
  const rv = c.rove("size");
  // the box follows the caret as long as the person is not typing in it
  useEffect(() => {
    if (!dirty) setText(shown);
  }, [shown, dirty]);
  const revert = () => {
    setDirty(false);
    setText(shown);
  };
  const commit = () => {
    const n = parseTypedSize(text);
    setDirty(false);
    if (n === null) setText(shown);
    else setSize(c.editor, n); // (the text has the focus again)
  };
  return (
    <div className="fmt-dd fmt-combo" ref={wrap} style={{ width: BAR_META.size.width }}>
      <input
        ref={input}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        {...rv}
        className="fmt-size-in"
        value={text}
        title={label}
        aria-label={label}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        onFocus={(e) => {
          rv.onFocus();
          e.currentTarget.select();
        }}
        onBlur={() => dirty && revert()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey && dirty)) {
            e.preventDefault();
            e.stopPropagation();
            commit();
          } else if (e.key === "Escape") {
            revert(); // (the bar puts the focus back in the text)
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            c.setOpen("size");
          } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") && !e.altKey && !e.ctrlKey && !e.metaKey) {
            // inside the text the arrows move the caret; at its edge (or with everything selected) they go on to the next control of the bar
            const el = e.currentTarget;
            const all = el.selectionStart === 0 && el.selectionEnd === el.value.length;
            const edge = e.key === "ArrowLeft" ? el.selectionStart === 0 && (all || el.selectionEnd === 0) : e.key === "ArrowRight" ? el.selectionEnd === el.value.length && (all || el.selectionStart === el.value.length) : false;
            if (!edge) e.stopPropagation();
          }
        }}
      />
      <button
        type="button"
        {...c.rove("size:opts")}
        className="fmt-size-btn"
        title={optsLabel}
        aria-label={optsLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={keepSelection}
        onClick={() => c.setOpen(open ? null : "size")}
        onKeyDown={opensOnDown(() => c.setOpen("size"))}
      >
        <ChevronDown size={12} className="caret" aria-hidden="true" />
      </button>
      {open && <SizeMenu c={c} anchor={wrap} trigger={input} onClose={() => c.setOpen(null)} />}
    </div>
  );
}

const sizeControl: FormatControl = {
  id: "size", ...BAR_META.size, rove: ["size", "size:opts"],
  bar: (c) => <SizeCombo c={c} />,
  more: (c) => [{ label: c.t("compose.fmt.fontSize"), hint: "›", onClick: () => c.openPicker("size") }],
  picker: (c, anchor, trigger, close) => <SizeMenu c={c} anchor={anchor} trigger={trigger} onClose={close} />,
};

const STYLE_NAME: Record<StyleName, Key> = {
  normal: "compose.fmt.style.normal", h1: "compose.fmt.style.h1", h2: "compose.fmt.style.h2", h3: "compose.fmt.style.h3", quote: "compose.fmt.style.quote", code: "compose.fmt.style.code",
};

const stylesControl: FormatControl = {
  id: "styles", ...BAR_META.styles, rove: ["styles"],
  bar: (c) => (
    <Box c={c} id="styles" width={BAR_META.styles.width} text={c.st.style ? c.t(STYLE_NAME[c.st.style]) : ""} label={c.t("compose.fmt.styles")} tip={kbd(c.t("compose.fmt.stylesTip"))} Menu={StylesMenu} />
  ),
  more: (c) => [{ label: c.t("compose.fmt.styles"), hint: "›", onClick: () => c.openPicker("styles") }],
  picker: (c, anchor, trigger, close) => <StylesMenu c={c} anchor={anchor} trigger={trigger} onClose={close} />,
};

// ---------------------------------------------------------------- alignment, lists, indent, insert

const ALIGNS: readonly { id: Align | "left"; label: Key; icon: ReactNode }[] = [
  { id: "left", label: "compose.fmt.alignLeft", icon: <AlignLeft size={IC} aria-hidden="true" /> },
  { id: "center", label: "compose.fmt.alignCenter", icon: <AlignCenter size={IC} aria-hidden="true" /> },
  { id: "right", label: "compose.fmt.alignRight", icon: <AlignRight size={IC} aria-hidden="true" /> },
  { id: "justify", label: "compose.fmt.justify", icon: <AlignJustify size={IC} aria-hidden="true" /> },
];
const ALIGN_KEYS: Record<string, string> = { left: "Ctrl+L", center: "Ctrl+E", right: "Ctrl+R", justify: "Ctrl+Shift+J" };

function AlignMenu({ c, anchor, trigger, onClose }: MenuProps) {
  const items: MenuItem[] = ALIGNS.map((a) => ({ label: c.t(a.label), icon: a.icon, hint: kbd(ALIGN_KEYS[a.id]), checked: c.st.align === a.id, onClick: () => void setAlignment(c.editor, a.id) }));
  return <FloatingMenu anchor={anchor} trigger={trigger} items={items} minWidth={200} onClose={onClose} />;
}

/** A button with an icon and a caret that opens a menu: the Align and the Insert controls. */
function IconMenu({ c, id, icon, label, tip, Menu }: { c: Ctx; id: string; icon: ReactNode; label: string; tip: string; Menu: (p: MenuProps) => ReactNode }) {
  const open = c.open === id;
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <div className="fmt-dd" ref={wrap}>
      <button
        ref={btn}
        type="button"
        {...c.rove(id)}
        className="icon-btn fmt-btn fmt-drop"
        title={tip}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={keepSelection}
        onClick={() => c.setOpen(open ? null : id)}
        onKeyDown={opensOnDown(() => c.setOpen(id))}
      >
        {icon}
        <ChevronDown size={10} className="caret" aria-hidden="true" />
      </button>
      {open && <Menu c={c} anchor={wrap} trigger={btn} onClose={() => c.setOpen(null)} />}
    </div>
  );
}

const alignControl: FormatControl = {
  id: "align", ...BAR_META.align, rove: ["align"],
  bar: (c) => {
    const cur = ALIGNS.find((a) => a.id === c.st.align) ?? ALIGNS[0];
    return <IconMenu c={c} id="align" icon={cur.icon} label={c.t("compose.fmt.align")} tip={c.t("compose.fmt.align")} Menu={AlignMenu} />;
  },
  more: (c) => [{ label: c.t("compose.fmt.align"), icon: <AlignLeft size={IC} />, hint: "›", onClick: () => c.openPicker("align") }],
  picker: (c, anchor, trigger, close) => <AlignMenu c={c} anchor={anchor} trigger={trigger} onClose={close} />,
};

const BULLETS: readonly { id: string; label: Key; sample: string }[] = [
  { id: "disc", label: "compose.fmt.bullet.disc", sample: "•" },
  { id: "circle", label: "compose.fmt.bullet.circle", sample: "◦" },
  { id: "square", label: "compose.fmt.bullet.square", sample: "▪" },
];
const NUMBERS: readonly { id: string; label: Key; sample: string }[] = [
  { id: "decimal", label: "compose.fmt.num.decimal", sample: "1." },
  { id: "lower-alpha", label: "compose.fmt.num.lowerAlpha", sample: "a." },
  { id: "upper-alpha", label: "compose.fmt.num.upperAlpha", sample: "A." },
  { id: "lower-roman", label: "compose.fmt.num.lowerRoman", sample: "i." },
  { id: "upper-roman", label: "compose.fmt.num.upperRoman", sample: "I." },
];

function ListStyleMenu({ c, ordered, anchor, trigger, onClose }: MenuProps & { ordered: boolean }) {
  const cur = ordered ? c.st.numberStyle : c.st.bulletStyle;
  // the sample of the marker is the row's icon (a check replaces it on the current style)
  const items: MenuItem[] = (ordered ? NUMBERS : BULLETS).map((s) => ({
    label: c.t(s.label), icon: <span className="fmt-sample" aria-hidden="true">{s.sample}</span>, checked: cur === s.id, onClick: () => void chooseListStyle(c.editor, ordered, s.id),
  }));
  return <FloatingMenu anchor={anchor} trigger={trigger} items={items} minWidth={230} onClose={onClose} />;
}

const toggleList = (c: Ctx, ordered: boolean): void => void (ordered ? c.editor.chain().focus().toggleOrderedList().run() : c.editor.chain().focus().toggleBulletList().run());

/** The bulleted and numbered list buttons: the main part switches the list on and off, the arrow opens the marker styles. */
function ListSplit({ c, ordered }: { c: Ctx; ordered: boolean }) {
  const id = ordered ? "numbered" : "bulleted";
  const on = ordered ? c.st.orderedList : c.st.bulletList;
  const open = c.open === id;
  const wrap = useRef<HTMLDivElement>(null);
  const arrow = useRef<HTMLButtonElement>(null);
  const label = c.t(ordered ? "compose.fmt.numbered" : "compose.fmt.bulleted");
  const optsLabel = c.t(ordered ? "compose.fmt.numberOptions" : "compose.fmt.bulletOptions");
  return (
    <div className="fmt-split fmt-split-list" ref={wrap}>
      <button
        type="button"
        {...c.rove(id)}
        className={`icon-btn fmt-btn fmt-main${on ? " on" : ""}`}
        title={kbd(c.t(ordered ? "compose.fmt.numberedTip" : "compose.fmt.bulletedTip"))}
        aria-label={label}
        aria-pressed={on}
        onMouseDown={keepSelection}
        onClick={() => {
          toggleList(c, ordered);
          focusText(c.editor);
        }}
      >
        {ordered ? <ListOrdered size={IC} aria-hidden="true" /> : <List size={IC} aria-hidden="true" />}
      </button>
      <button
        ref={arrow}
        type="button"
        {...c.rove(`${id}:opts`)}
        className="icon-btn fmt-btn fmt-arrow"
        title={optsLabel}
        aria-label={optsLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={keepSelection}
        onClick={() => c.setOpen(open ? null : id)}
        onKeyDown={opensOnDown(() => c.setOpen(id))}
      >
        <ChevronDown size={10} aria-hidden="true" />
      </button>
      {open && <ListStyleMenu c={c} ordered={ordered} anchor={wrap} trigger={arrow} onClose={() => c.setOpen(null)} />}
    </div>
  );
}

function listControl(ordered: boolean): FormatControl {
  const id = ordered ? "numbered" : "bulleted";
  return {
    id, ...BAR_META[id], rove: [id, `${id}:opts`],
    bar: (c) => <ListSplit c={c} ordered={ordered} />,
    more: (c) => [
      {
        label: c.t(ordered ? "compose.fmt.numbered" : "compose.fmt.bulleted"),
        icon: ordered ? <ListOrdered size={IC} /> : <List size={IC} />,
        kind: "check",
        checked: ordered ? c.st.orderedList : c.st.bulletList,
        onClick: () => toggleList(c, ordered),
      },
      { label: c.t(ordered ? "compose.fmt.numberOptions" : "compose.fmt.bulletOptions"), hint: "›", onClick: () => c.openPicker(id) },
    ],
    picker: (c, anchor, trigger, close) => <ListStyleMenu c={c} ordered={ordered} anchor={anchor} trigger={trigger} onClose={close} />,
  };
}

// the table popover and the emoji picker are in the insertUi chunk (fetched when first opened; nothing of them is in the main bundle)
const LazyTableMenu = lazy(() => import("./insertUi").then((m) => ({ default: m.TableMenu })));
const LazyEmojiMenu = lazy(() => import("./insertUi").then((m) => ({ default: m.EmojiMenu })));
const TableMenuLazy = (p: MenuProps) => <Suspense fallback={null}><LazyTableMenu {...p} /></Suspense>;
const EmojiMenuLazy = (p: MenuProps) => <Suspense fallback={null}><LazyEmojiMenu {...p} /></Suspense>;
const LazySymbolMenu = lazy(() => import("./insertUi").then((m) => ({ default: m.SymbolMenu })));
const LazyDateMenu = lazy(() => import("./insertUi").then((m) => ({ default: m.DateMenu })));
const SymbolMenuLazy = (p: MenuProps) => <Suspense fallback={null}><LazySymbolMenu {...p} /></Suspense>;
const DateMenuLazy = (p: MenuProps) => <Suspense fallback={null}><LazyDateMenu {...p} /></Suspense>;

const tableControl: FormatControl = {
  id: "table", ...BAR_META.table, rove: ["table"],
  bar: (c) => <IconMenu c={c} id="table" icon={<Table2 size={IC} aria-hidden="true" />} label={c.t("compose.table.button")} tip={c.t(c.st.inTable ? "compose.table.tools" : "compose.table.tip")} Menu={TableMenuLazy} />,
  more: (c) => [{ label: c.t("compose.table.button"), icon: <Table2 size={IC} />, hint: "›", onClick: () => c.openPicker("table") }],
  picker: (c, anchor, trigger, close) => <TableMenuLazy c={c} anchor={anchor} trigger={trigger} onClose={close} />,
};

function InsertMenu({ c, anchor, trigger, onClose }: MenuProps) {
  const items: MenuItem[] = [
    { label: c.t("compose.fmt.hr"), icon: <Minus size={IC} />, onClick: () => void insertHorizontalLine(c.editor) },
    { label: c.t("compose.insert.emoji"), icon: <Smile size={IC} />, hint: "›", onClick: () => c.openPicker("emoji", trigger) },
    { label: c.t("compose.insert.symbol"), icon: <Omega size={IC} />, hint: "›", onClick: () => c.openPicker("symbol", trigger) },
    { label: c.t("compose.insert.dateTime"), icon: <CalendarClock size={IC} />, hint: "›", onClick: () => c.openPicker("dateTime", trigger) },
  ];
  return <FloatingMenu anchor={anchor} trigger={trigger} items={items} minWidth={190} onClose={onClose} />;
}

const insertControl: FormatControl = {
  id: "insert", ...BAR_META.insert, rove: ["insert"],
  bar: (c) => <IconMenu c={c} id="insert" icon={<Plus size={IC} aria-hidden="true" />} label={c.t("compose.fmt.insert")} tip={c.t("compose.fmt.insert")} Menu={InsertMenu} />,
  // out of the bar, its rows (Horizontal line) are in the More menu anyway
  more: () => [],
  picker: (c, anchor, trigger, close) => <InsertMenu c={c} anchor={anchor} trigger={trigger} onClose={close} />,
};

/** Line spacing and space after the paragraph (a row of the More menu opens it). */
function SpacingMenu({ c, anchor, trigger, onClose }: MenuProps) {
  const items: MenuItem[] = [
    ...LINE_HEIGHTS.map((n) => {
      const value = n === 1 ? null : String(n);
      return { label: n.toFixed(n === 1.15 ? 2 : 1), checked: !c.st.lineHeightMixed && c.st.lineHeight === value, onClick: () => void setSpacing(c.editor, value) };
    }),
    { divider: true },
    c.st.spaceAfter
      ? { label: c.t("compose.fmt.spacingRemoveAfter"), onClick: () => void setSpaceAfterParagraph(c.editor, false) }
      : { label: c.t("compose.fmt.spacingAddAfter"), onClick: () => void setSpaceAfterParagraph(c.editor, true) },
  ];
  return <FloatingMenu anchor={anchor} trigger={trigger} items={items} minWidth={230} onClose={onClose} />;
}

/** Change case: the five cases of the menu; the code that does it is fetched with the first use. */
const CASES = [
  ["sentence", "compose.fmt.case.sentence"],
  ["lower", "compose.fmt.case.lower"],
  ["upper", "compose.fmt.case.upper"],
  ["title", "compose.fmt.case.title"],
  ["toggle", "compose.fmt.case.toggle"],
] as const;

function CaseMenu({ c, anchor, trigger, onClose }: MenuProps) {
  const items: MenuItem[] = CASES.map(([mode, label]) => ({
    label: c.t(label),
    onClick: () => void import("./changeCase").then((m) => (m.changeCase(c.editor, mode), focusText(c.editor))),
  }));
  return <FloatingMenu anchor={anchor} trigger={trigger} items={items} minWidth={210} onClose={onClose} />;
}

/** The zoom steps of the editor (REQ-49): display only, nothing of it is sent. */
export const ZOOMS: readonly number[] = [75, 100, 125, 150, 200];

function ZoomMenu({ c, anchor, trigger, onClose }: MenuProps) {
  const z = c.host.zoom;
  const items: MenuItem[] = ZOOMS.map((n) => ({ label: `${n}%`, checked: z?.value === n, onClick: () => (z?.set(n), focusText(c.editor)) }));
  return <FloatingMenu anchor={anchor} trigger={trigger} items={items} minWidth={110} onClose={onClose} />;
}

// ---------------------------------------------------------------- colour and highlight (split buttons)

function Split({ c, kind }: { c: Ctx; kind: "color" | "highlight" }) {
  const t = c.t;
  const font = kind === "color";
  const id = font ? "fontColor" : "highlight";
  const last = font ? (c.recentColors[0] ?? DEFAULT_FONT_COLOR) : c.highlightColor;
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const arrow = useRef<HTMLButtonElement>(null);
  const apply = (hex: string | null) => {
    if (font) {
      setTextColor(c.editor, hex);
      if (hex) c.rememberColor(hex);
    } else {
      setHighlight(c.editor, hex);
      if (hex) c.rememberHighlight(hex);
    }
  };
  const label = t(font ? "compose.fmt.fontColor" : "compose.fmt.highlight");
  const optsLabel = t(font ? "compose.fmt.fontColorOptions" : "compose.fmt.highlightOptions");
  return (
    <div className="fmt-split" ref={wrap}>
      <button type="button" {...c.rove(id)} className="icon-btn fmt-btn fmt-main" title={label} aria-label={label} onMouseDown={keepSelection} onClick={() => apply(last)}>
        <span className="fmt-ico">
          {font ? <span className="fmt-a" aria-hidden="true">A</span> : <Highlighter size={IC} aria-hidden="true" />}
          <i style={{ background: last }} />
        </span>
      </button>
      <button
        ref={arrow}
        type="button"
        {...c.rove(`${id}:opts`)}
        className="icon-btn fmt-btn fmt-arrow"
        title={optsLabel}
        aria-label={optsLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseDown={keepSelection}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={opensOnDown(() => setOpen(true))}
      >
        <ChevronDown size={10} aria-hidden="true" />
      </button>
      {open && <SplitPicker c={c} kind={kind} anchor={wrap} trigger={arrow} close={() => setOpen(false)} />}
    </div>
  );
}

function SplitPicker({ c, kind, anchor, trigger, close }: { c: Ctx; kind: "color" | "highlight"; anchor: RefObject<HTMLElement | null>; trigger: RefObject<HTMLElement | null>; close: () => void }) {
  // a colour chosen: the editor has the focus again (the command did it); Esc: back on the button; a press elsewhere: the focus stays there
  const done = (why: PaletteClose) => {
    close();
    if (why === "esc") trigger.current?.focus({ preventScroll: true });
  };
  if (kind === "color") {
    return (
      <FontColorPalette
        anchor={anchor}
        current={c.st.color.mixed ? "" : c.st.color.value}
        recent={c.recentColors}
        onPick={(hex) => {
          setTextColor(c.editor, hex);
          if (hex) c.rememberColor(hex);
        }}
        onClose={done}
      />
    );
  }
  return (
    <HighlightPalette
      anchor={anchor}
      current={c.st.highlight.mixed ? "" : c.st.highlight.value}
      onPick={(hex) => {
        setHighlight(c.editor, hex);
        if (hex) c.rememberHighlight(hex);
      }}
      onClose={done}
    />
  );
}

const colorControl: FormatControl = {
  id: "fontColor", ...BAR_META.fontColor, rove: ["fontColor", "fontColor:opts"],
  bar: (c) => <Split c={c} kind="color" />,
  more: (c) => [{ label: c.t("compose.fmt.fontColor"), hint: "›", onClick: () => c.openPicker("fontColor") }],
  picker: (c, anchor, trigger, close) => <SplitPicker c={c} kind="color" anchor={anchor} trigger={trigger} close={close} />,
};

const highlightControl: FormatControl = {
  id: "highlight", ...BAR_META.highlight, rove: ["highlight", "highlight:opts"],
  bar: (c) => <Split c={c} kind="highlight" />,
  more: (c) => [{ label: c.t("compose.fmt.highlight"), hint: "›", onClick: () => c.openPicker("highlight") }],
  picker: (c, anchor, trigger, close) => <SplitPicker c={c} kind="highlight" anchor={anchor} trigger={trigger} close={close} />,
};

// ---------------------------------------------------------------- the registry (where each control sits and how long it stays: BAR_META in toolbarLayout.ts)

/** The format painter: a click turns it on for one use (or off), a double click keeps it on, Ctrl+Shift+D does the same from the keyboard (formatPainter.ts). */
const painterControl: FormatControl = {
  id: "painter", ...BAR_META.painter, rove: ["painter"],
  bar: (c) => (
    <Tool c={c} id="painter" icon={<Paintbrush size={IC} />} label={c.t("compose.fmt.painter")} tip={kbd(c.t("compose.fmt.painterTip"))} on={c.st.painter !== "off"} run={(clicks) => painterClick(c.editor, clicks)} />
  ),
  more: (c) => [{ label: c.t("compose.fmt.painter"), icon: <Paintbrush size={IC} />, hint: kbd("Ctrl+Shift+D"), kind: "check", checked: c.st.painter !== "off", onClick: () => painterClick(c.editor, 1) }],
};

export const CONTROLS: readonly FormatControl[] = [
  painterControl,
  toggle({ id: "undo", label: "compose.fmt.undo", tip: "compose.fmt.undoTip", icon: <Undo2 size={IC} />, off: (s) => !s.canUndo, run: (c) => void c.editor.chain().focus().undo().run() }),
  toggle({ id: "redo", label: "compose.fmt.redo", tip: "compose.fmt.redoTip", icon: <Redo2 size={IC} />, off: (s) => !s.canRedo, run: (c) => void c.editor.chain().focus().redo().run() }),
  fontControl,
  sizeControl,
  toggle({ id: "bold", label: "compose.fmt.bold", tip: "compose.fmt.boldTip", icon: <Bold size={IC} />, on: (s) => s.bold, run: (c) => void c.editor.chain().focus().toggleBold().run() }),
  toggle({ id: "italic", label: "compose.fmt.italic", tip: "compose.fmt.italicTip", icon: <Italic size={IC} />, on: (s) => s.italic, run: (c) => void c.editor.chain().focus().toggleItalic().run() }),
  toggle({ id: "underline", label: "compose.fmt.underline", tip: "compose.fmt.underlineTip", icon: <UnderlineIcon size={IC} />, on: (s) => s.underline, run: (c) => void c.editor.chain().focus().toggleUnderline().run() }),
  toggle({ id: "strike", label: "compose.fmt.strike", tip: null, icon: <Strikethrough size={IC} />, on: (s) => s.strike, run: (c) => void c.editor.chain().focus().toggleStrike().run() }),
  colorControl,
  highlightControl,
  listControl(false),
  listControl(true),
  toggle({ id: "indentLess", label: "compose.fmt.indentLess", tip: "compose.fmt.indentLessTip", icon: <IndentDecrease size={IC} />, run: (c) => void changeIndent(c.editor, -1) }),
  toggle({ id: "indentMore", label: "compose.fmt.indentMore", tip: "compose.fmt.indentMoreTip", icon: <IndentIncrease size={IC} />, run: (c) => void changeIndent(c.editor, 1) }),
  alignControl,
  stylesControl,
  {
    id: "link", ...BAR_META.link, rove: ["link"],
    bar: (c) => (
      <Tool c={c} id="link" btnRef={c.host.link.btnRef} icon={<Link2 size={IC} />} label={c.t("compose.fmt.link")} tip={kbd(c.t("compose.fmt.linkTip"))} run={c.host.link.open} haspopup="dialog" expanded={c.host.link.isOpen} />
    ),
    more: (c) => [{ label: c.t("compose.fmt.link"), icon: <Link2 size={IC} />, hint: kbd("Ctrl+K"), onClick: c.host.link.open }],
  },
  {
    id: "picture", ...BAR_META.picture, rove: ["picture"],
    bar: (c) => <Tool c={c} id="picture" icon={<ImagePlus size={IC} />} label={c.t("compose.fmt.insertPicture")} tip={kbd(c.t("compose.bar.insertPictureTip"))} run={() => c.host.insertPicture?.()} />,
    more: (c) => [{ label: c.t("compose.fmt.insertPicture"), icon: <ImagePlus size={IC} />, hint: kbd("Ctrl+Shift+P"), onClick: () => c.host.insertPicture?.() }],
  },
  tableControl,
  insertControl,
  toggle({ id: "clear", label: "compose.fmt.clear", tip: "compose.fmt.clearTip", icon: <RemoveFormatting size={IC} />, tipParams: () => ({ keys: osNow() === "macos" ? "Cmd+\\" : "Ctrl+Space" }), run: (c) => void clearFormatting(c.editor) }),
];

export const MORE_ITEMS: readonly MoreEntry[] = [
  {
    id: "subscript", variants: ["compose", "compact"],
    item: (c) => ({ label: c.t("compose.fmt.subscript"), icon: <Subscript size={IC} />, hint: kbd("Ctrl+="), kind: "check", checked: c.st.subscript, onClick: () => void toggleScript(c.editor, "subscript") }),
  },
  {
    id: "superscript", variants: ["compose", "compact"],
    item: (c) => ({ label: c.t("compose.fmt.superscript"), icon: <Superscript size={IC} />, hint: kbd("Ctrl+Shift+="), kind: "check", checked: c.st.superscript, onClick: () => void toggleScript(c.editor, "superscript") }),
  },
  {
    id: "spacing", variants: ["compose", "compact"],
    item: (c) => ({ label: c.t("compose.fmt.spacing"), icon: <ArrowUpDown size={IC} />, hint: "›", onClick: () => c.openPicker("spacing") }),
    picker: (c, anchor, trigger, close) => <SpacingMenu c={c} anchor={anchor} trigger={trigger} onClose={close} />,
  },
  {
    id: "ltr", variants: ["compose", "compact"],
    item: (c) => ({ label: c.t("compose.fmt.ltr"), icon: <PilcrowRight size={IC} />, checked: c.st.direction === "ltr", onClick: () => void c.editor.chain().focus().command(({ state, dispatch }) => setDirection(null)(state, dispatch)).run() }),
  },
  {
    id: "rtl", variants: ["compose", "compact"],
    item: (c) => ({ label: c.t("compose.fmt.rtl"), icon: <PilcrowLeft size={IC} />, checked: c.st.direction === "rtl", onClick: () => void c.editor.chain().focus().command(({ state, dispatch }) => setDirection("rtl")(state, dispatch)).run() }),
  },
  {
    id: "case", variants: ["compose", "compact"],
    item: (c) => ({ label: c.t("compose.fmt.case"), icon: <CaseSensitive size={IC} />, hint: "›", onClick: () => c.openPicker("case") }),
    picker: (c, anchor, trigger, close) => <CaseMenu c={c} anchor={anchor} trigger={trigger} onClose={close} />,
  },
  {
    id: "find", variants: ["compose"],
    item: (c) => ({ label: c.t("compose.fmt.find"), icon: <Search size={IC} />, hint: kbd("Ctrl+F"), disabled: !c.host.find, onClick: () => c.host.find?.("find") }),
  },
  {
    // opens the panel with the Replace row (Cmd+H hides the app on a Mac, so its key there is Cmd+Shift+H)
    id: "replace", variants: ["compose"],
    item: (c) => ({ label: c.t("compose.find.replace"), icon: <Replace size={IC} />, hint: kbd(osNow() === "macos" ? "Ctrl+Shift+H" : "Ctrl+H"), disabled: !c.host.find, onClick: () => c.host.find?.("replace") }),
  },
  {
    id: "zoom", variants: ["compose"],
    item: (c) => ({ label: c.t("compose.fmt.zoom"), icon: <ZoomIn size={IC} />, hint: c.host.zoom && c.host.zoom.value !== 100 ? `${c.host.zoom.value}% ›` : "›", onClick: () => c.openPicker("zoom") }),
    picker: (c, anchor, trigger, close) => <ZoomMenu c={c} anchor={anchor} trigger={trigger} onClose={close} />,
  },
  {
    id: "hr", variants: ["compose", "compact"],
    item: (c) => ({ label: c.t("compose.fmt.hr"), icon: <Minus size={IC} />, onClick: () => void insertHorizontalLine(c.editor) }),
  },
  {
    id: "emoji", variants: ["compose", "compact"],
    item: (c) => ({ label: c.t("compose.insert.emoji"), icon: <Smile size={IC} />, hint: "›", onClick: () => c.openPicker("emoji") }),
    picker: (c, anchor, trigger, close) => <EmojiMenuLazy c={c} anchor={anchor} trigger={trigger} onClose={close} />,
  },
  {
    id: "symbol", variants: ["compose", "compact"],
    item: (c) => ({ label: c.t("compose.insert.symbol"), icon: <Omega size={IC} />, hint: "›", onClick: () => c.openPicker("symbol") }),
    picker: (c, anchor, trigger, close) => <SymbolMenuLazy c={c} anchor={anchor} trigger={trigger} onClose={close} />,
  },
  {
    id: "dateTime", variants: ["compose", "compact"],
    item: (c) => ({ label: c.t("compose.insert.dateTime"), icon: <CalendarClock size={IC} />, hint: "›", onClick: () => c.openPicker("dateTime") }),
    picker: (c, anchor, trigger, close) => <DateMenuLazy c={c} anchor={anchor} trigger={trigger} onClose={close} />,
  },
];

export { pushRecent };

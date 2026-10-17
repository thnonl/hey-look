import type { Editor } from "@tiptap/react";
import {
  Bold, ChevronDown, Highlighter, ImagePlus, Italic, Link2, List, ListOrdered, RemoveFormatting, Redo2, Strikethrough, Subscript, Superscript, Underline as UnderlineIcon, Undo2,
} from "lucide-react";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { FloatingMenu, type MenuItem } from "../components/ui";
import type { Key, Params } from "../i18n";
import { useT } from "../i18n/react";
import { kbd, osNow } from "../platform";
import { FontColorPalette, HighlightPalette, type PaletteClose } from "./ColorPalette";
import { DEFAULT_FONT_COLOR, pushRecent } from "./colors";
import { clearFormatting, focusText, toggleScript, selectionColor, selectionFamily, selectionSize, setFamily, setHighlight, setSize, setTextColor, type Uniform } from "./commands";
import type { BaseFont } from "./emailHtml";
import { FONTS, SIZES, familyName, fontOf, normFamily } from "./fonts";
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
}

export function readBarState(editor: Editor, base: BaseFont): BarState {
  return {
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    underline: editor.isActive("underline"),
    strike: editor.isActive("strike"),
    subscript: editor.isActive("subscript"),
    superscript: editor.isActive("superscript"),
    bulletList: editor.isActive("bulletList"),
    orderedList: editor.isActive("orderedList"),
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
    family: selectionFamily(editor, base),
    size: selectionSize(editor, base),
    color: selectionColor(editor, "color", base),
    highlight: selectionColor(editor, "backgroundColor", base),
  };
}

/** What the host of the toolbar (Compose, RichEditor) provides: the link UI of its editor and, for a message, the picture button. */
export interface FormatHost {
  link: { open: () => void; isOpen: boolean; btnRef: RefObject<HTMLButtonElement | null> };
  /** present in a message only (a signature or template has no picture button yet) */
  insertPicture?: () => void;
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
  /** open a control's picker from the More menu (it opens under the More button) */
  openPicker: (id: string) => void;
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
}

// ---------------------------------------------------------------- shared pieces

const keepSelection = (e: React.MouseEvent) => e.preventDefault(); // a click on the toolbar must not take the focus (and the caret) out of the editor

function Tool({ c, id, icon, label, tip, on, disabled, run, btnRef, haspopup, expanded }: {
  c: Ctx; id: string; icon: ReactNode; label: string; tip: string; on?: boolean; disabled?: boolean; run: () => void;
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
      onClick={() => {
        if (disabled) return;
        run();
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

const isOn = (b: boolean): boolean | undefined => (b ? true : undefined);

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
    more: (c) => [{ label: c.t(o.label), icon: o.icon, checked: isToggle ? isOn(o.on!(c.st)) : undefined, disabled: o.off?.(c.st), onClick: () => o.run(c) }],
  };
}

const IC = 14;

// ---------------------------------------------------------------- the font box and the size box

function FontMenu({ c, anchor, trigger, onClose }: { c: Ctx; anchor: RefObject<HTMLElement | null>; trigger: RefObject<HTMLElement | null>; onClose: () => void }) {
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

function SizeMenu({ c, anchor, trigger, onClose }: { c: Ctx; anchor: RefObject<HTMLElement | null>; trigger: RefObject<HTMLElement | null>; onClose: () => void }) {
  const cur = c.st.size;
  const items: MenuItem[] = SIZES.map((s) => ({ label: String(s), checked: !cur.mixed && cur.value !== null && Math.abs(cur.value - s) < 1e-6, onClick: () => setSize(c.editor, s) }));
  return <FloatingMenu anchor={anchor} trigger={trigger} items={items} minWidth={72} onClose={onClose} />;
}

function Box({ c, id, width, text, style, label, tip, Menu }: {
  c: Ctx; id: string; width: number; text: string; style?: React.CSSProperties; label: string; tip: string; Menu: typeof FontMenu;
}) {
  const [open, setOpen] = useState(false);
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
        onClick={() => setOpen((o) => !o)}
        onKeyDown={opensOnDown(() => setOpen(true))}
      >
        <span className="fmt-box-txt ellipsis" style={style}>{text}</span>
        <ChevronDown size={12} className="caret" aria-hidden="true" />
      </button>
      {open && <Menu c={c} anchor={wrap} trigger={btn} onClose={() => setOpen(false)} />}
    </div>
  );
}

const fontControl: FormatControl = {
  id: "font", ...BAR_META.font, rove: ["font"],
  bar: (c) => {
    const cur = c.st.family;
    const name = cur.mixed ? "" : cur.value ? (fontOf(cur.value)?.name ?? familyName(cur.value)) : familyName(c.base.family);
    const stack = cur.mixed ? undefined : cur.value ?? c.base.family;
    return <Box c={c} id="font" width={120} text={name} style={stack ? { fontFamily: normFamily(stack) } : undefined} label={c.t("compose.fmt.font")} tip={c.t("compose.fmt.font")} Menu={FontMenu} />;
  },
  more: (c) => [{ label: c.t("compose.fmt.font"), hint: "›", onClick: () => c.openPicker("font") }],
  picker: (c, anchor, trigger, close) => <FontMenu c={c} anchor={anchor} trigger={trigger} onClose={close} />,
};

const sizeControl: FormatControl = {
  id: "size", ...BAR_META.size, rove: ["size"],
  bar: (c) => {
    const cur = c.st.size;
    return <Box c={c} id="size" width={52} text={cur.mixed || cur.value === null ? "" : String(cur.value)} label={c.t("compose.fmt.fontSize")} tip={c.t("compose.fmt.fontSize")} Menu={SizeMenu} />;
  },
  more: (c) => [{ label: c.t("compose.fmt.fontSize"), hint: "›", onClick: () => c.openPicker("size") }],
  picker: (c, anchor, trigger, close) => <SizeMenu c={c} anchor={anchor} trigger={trigger} onClose={close} />,
};

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

export const CONTROLS: readonly FormatControl[] = [
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
  toggle({ id: "bulleted", label: "compose.fmt.bulleted", tip: "compose.fmt.bulletedTip", icon: <List size={IC} />, on: (s) => s.bulletList, run: (c) => void c.editor.chain().focus().toggleBulletList().run() }),
  toggle({ id: "numbered", label: "compose.fmt.numbered", tip: "compose.fmt.numberedTip", icon: <ListOrdered size={IC} />, on: (s) => s.orderedList, run: (c) => void c.editor.chain().focus().toggleOrderedList().run() }),
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
  toggle({ id: "clear", label: "compose.fmt.clear", tip: "compose.fmt.clearTip", icon: <RemoveFormatting size={IC} />, tipParams: () => ({ keys: osNow() === "macos" ? "Cmd+\\" : "Ctrl+Space" }), run: (c) => void clearFormatting(c.editor) }),
];

export const MORE_ITEMS: readonly MoreEntry[] = [
  {
    id: "subscript", variants: ["compose", "compact"],
    item: (c) => ({ label: c.t("compose.fmt.subscript"), icon: <Subscript size={IC} />, hint: kbd("Ctrl+="), checked: isOn(c.st.subscript), onClick: () => void toggleScript(c.editor, "subscript") }),
  },
  {
    id: "superscript", variants: ["compose", "compact"],
    item: (c) => ({ label: c.t("compose.fmt.superscript"), icon: <Superscript size={IC} />, hint: kbd("Ctrl+Shift+="), checked: isOn(c.st.superscript), onClick: () => void toggleScript(c.editor, "superscript") }),
  },
];

export { pushRecent };

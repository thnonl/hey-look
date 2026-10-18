import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n/react";
import type { Key } from "../i18n";
import { placePopover } from "../popoverRoom";
import { toastBox } from "../components/ui";
import { pressIsOutside } from "../pressInside";
import { HIGHLIGHTS, STANDARD, sameColor, themeGrid, type Swatch } from "./colors";

// The colour pickers of the formatting toolbar (spec-rich-text.md 4.2): a popover with the Office palette for the font colour (Automatic, theme
// colours with their tints and shades, standard colours, recent colours, More colors...) and one with the 15 highlight colours of Word.
// Swatches keep their true colours with a hairline outline; the arrow keys move in two dimensions, Enter applies, Esc closes.

const colorKey = (id: string) => `compose.color.${id}` as Key;

/** The name of a swatch for the tooltip and the screen reader: "Blue, lighter 40%". */
export function useSwatchName() {
  const t = useT();
  return (s: Swatch): string => {
    const name = t(colorKey(s.id));
    return s.shade ? t(s.shade.kind === "lighter" ? "compose.fmt.color.lighter" : "compose.fmt.color.darker", { color: name, n: s.shade.n }) : name;
  };
}

/** 2-D arrow-key movement between the buttons of a panel that carry `data-row` / `data-col`. */
function moveFocus(e: React.KeyboardEvent, panel: HTMLElement | null) {
  const key = e.key;
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key) || !panel) return;
  const cells = Array.from(panel.querySelectorAll<HTMLElement>("button[data-row]"));
  const cur = (e.target as HTMLElement).closest<HTMLElement>("button[data-row]");
  const at = cur ? cells.indexOf(cur) : -1;
  if (at < 0) return;
  e.preventDefault();
  const row = Number(cur!.dataset.row);
  const col = Number(cur!.dataset.col);
  const rows = Array.from(new Set(cells.map((c) => Number(c.dataset.row)))).sort((a, b) => a - b);
  const inRow = (r: number) => cells.filter((c) => Number(c.dataset.row) === r);
  const pick = (r: number, wantCol: number) => {
    const list = inRow(r);
    return list.reduce((best, c) => (Math.abs(Number(c.dataset.col) - wantCol) < Math.abs(Number(best.dataset.col) - wantCol) ? c : best), list[0]);
  };
  const ri = rows.indexOf(row);
  let next: HTMLElement | undefined;
  if (key === "ArrowLeft") next = cells[Math.max(0, at - 1)];
  else if (key === "ArrowRight") next = cells[Math.min(cells.length - 1, at + 1)];
  else if (key === "ArrowUp") next = ri > 0 ? pick(rows[ri - 1], col) : cur!;
  else if (key === "ArrowDown") next = ri < rows.length - 1 ? pick(rows[ri + 1], col) : cur!;
  else if (key === "Home") next = cells[0];
  else next = cells[cells.length - 1];
  next?.focus();
}

/** Why a palette closed: a colour was chosen (the focus goes on in the editor), Esc (back to the button), or a press elsewhere (the focus stays where it went). */
export type PaletteClose = "pick" | "esc" | "away";

/** A popover drawn on <body> under `anchor`, kept inside the window; a press outside, Esc or a resize closes it. */
export function Panel({ anchor, onClose, label, children, className }: { anchor: React.RefObject<HTMLElement | null>; onClose: (why: PaletteClose) => void; label: string; children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; max: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const p = ref.current?.getBoundingClientRect();
    const b = anchor.current?.getBoundingClientRect();
    if (!p || !b) return;
    // below the button or above it, inside the window and above a toast; a panel taller than the room scrolls (popoverRoom.ts)
    setPos(placePopover(b, { w: p.width, h: p.height }, { w: window.innerWidth, h: window.innerHeight }, { edge: 8, gap: 4, toasts: toastBox() }));
  }, [anchor]);
  // the focus goes into the palette once it is shown (a hidden element cannot take it): on the current colour, else on the first swatch
  const placed = pos !== null;
  useEffect(() => {
    if (!placed) return;
    (ref.current?.querySelector<HTMLElement>("button.on, button[aria-pressed='true']") ?? ref.current?.querySelector<HTMLElement>("button[data-row]"))?.focus({ preventScroll: true });
  }, [placed]);
  useEffect(() => {
    const down = (e: MouseEvent) => pressIsOutside(e.target, [anchor, ref]) && close.current("away");
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); // Esc closes only this palette (the global Esc and an open dialog must not react as well)
      e.preventDefault();
      close.current("esc");
    };
    const gone = () => close.current("away");
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", gone);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", gone);
    };
  }, [anchor]);
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`popover fmt-pop ${className ?? ""}`}
      style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.max, overflowY: "auto" } : { top: 0, left: 0, visibility: "hidden" }}
      onKeyDown={(e) => moveFocus(e, ref.current)}
    >
      {children}
    </div>,
    document.body,
  );
}

export function Sw({ s, name, row, col, current, onPick }: { s: Swatch; name: string; row: number; col: number; current: boolean; onPick: (hex: string) => void }) {
  return (
    <button
      type="button"
      className={`fmt-sw${current ? " on" : ""}`}
      style={{ background: s.hex }}
      title={name}
      aria-label={name}
      aria-pressed={current}
      data-row={row}
      data-col={col}
      onClick={() => onPick(s.hex)}
    />
  );
}

/**
 * The font colour palette. `current` is the colour of the selection (a ring on its swatch), `recent` the colours used lately;
 * `onPick(null)` is Automatic (no colour in the HTML, so the reader's light or dark mode decides).
 */
export function FontColorPalette({ anchor, current, recent, onPick, onClose }: { anchor: React.RefObject<HTMLElement | null>; current: string | null; recent: string[]; onPick: (hex: string | null) => void; onClose: (why: PaletteClose) => void }) {
  const t = useT();
  const name = useSwatchName();
  const native = useRef<HTMLInputElement>(null);
  const grid = themeGrid();
  const pick = (hex: string | null) => {
    onPick(hex);
    onClose("pick");
  };
  // the native colour dialog: the colour is applied when the dialog is confirmed
  useLayoutEffect(() => {
    const input = native.current;
    if (!input) return;
    const done = () => pick(input.value.toUpperCase());
    input.addEventListener("change", done);
    return () => input.removeEventListener("change", done);
  });
  let row = 0;
  return (
    <Panel anchor={anchor} onClose={onClose} label={t("compose.fmt.fontColor")} className="fmt-pop-color">
      <button type="button" className="fmt-auto" data-row={row++} data-col={0} title={t("compose.fmt.color.automaticTip")} aria-pressed={current === null} onClick={() => pick(null)}>
        <span className="fmt-auto-sw" aria-hidden="true">A</span>
        <span className="fmt-auto-txt">{t("compose.fmt.color.automatic")}</span>
        {current === null && <Check size={13} aria-hidden="true" />}
      </button>
      <div className="fmt-pop-head">{t("compose.fmt.color.theme")}</div>
      <div className="fmt-grid" role="group" aria-label={t("compose.fmt.color.theme")}>
        {grid.map((r) => {
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
      {recent.length > 0 && (
        <>
          <div className="fmt-pop-head">{t("compose.fmt.color.recent")}</div>
          <div className="fmt-grid" role="group" aria-label={t("compose.fmt.color.recent")}>
            {(() => {
              const ri = row++;
              return recent.map((hex, c) => <Sw key={c} s={{ hex, id: "" }} name={hex} row={ri} col={c} current={sameColor(current, hex)} onPick={pick} />);
            })()}
          </div>
        </>
      )}
      <button type="button" className="fmt-more-colors" data-row={row++} data-col={0} onClick={() => native.current?.click()}>
        {t("compose.fmt.color.more")}
      </button>
      <input ref={native} type="color" className="fmt-native" tabIndex={-1} aria-hidden="true" defaultValue={current ?? "#FF0000"} />
    </Panel>
  );
}

/** The 15 highlight colours of Word and "No color". */
export function HighlightPalette({ anchor, current, onPick, onClose }: { anchor: React.RefObject<HTMLElement | null>; current: string | null; onPick: (hex: string | null) => void; onClose: (why: PaletteClose) => void }) {
  const t = useT();
  const name = useSwatchName();
  const pick = (hex: string | null) => {
    onPick(hex);
    onClose("pick");
  };
  return (
    <Panel anchor={anchor} onClose={onClose} label={t("compose.fmt.highlight")} className="fmt-pop-hl">
      <div className="fmt-grid fmt-grid-hl" role="group" aria-label={t("compose.fmt.highlight")}>
        {HIGHLIGHTS.map((s, i) => (
          <Sw key={s.hex} s={s} name={name(s)} row={Math.floor(i / 5)} col={i % 5} current={sameColor(current, s.hex)} onPick={pick} />
        ))}
      </div>
      <button type="button" className="fmt-more-colors" data-row={3} data-col={0} aria-pressed={current === null} onClick={() => pick(null)}>
        {t("compose.fmt.color.none")}
      </button>
    </Panel>
  );
}

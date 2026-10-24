// The mini toolbar on a mouse selection (spec-107-wp3.md W3.3, spec-rich-text.md REQ-52): when it may show, and the box of a selection. Pure (no imports): a plain Node script tests it
// (scripts/test-mini-toolbar.mjs). The listeners that feed it and the toolbar itself are in useMiniShow.ts and MiniToolbar.tsx; the place it takes is popoverRoom.ts `placePopover`
// with `cover: false`.

/** What kind of pointer made the last selection change: "key" is the keyboard (typing, arrows, Ctrl+A, Find ...). */
export type SelectionSource = "mouse" | "touch" | "pen" | "key" | null;
/** "text": a non-empty text selection; "node": a picture; "cells": several table cells; "empty": a caret. */
export type SelectionKind = "text" | "node" | "cells" | "empty";

export interface ShowFlags {
  /** Settings > Composing > Show the mini toolbar when you select text */
  enabled: boolean;
  source: SelectionSource;
  selection: SelectionKind;
  /** the whole selection is inside one link: the link bubble owns that case */
  inOneLink: boolean;
  /** the format painter is on: a mouse selection paints instead */
  painterOn: boolean;
  /** an input method composes */
  composing: boolean;
  /** a menu, palette or popover of the editor's toolbar is open */
  blocked: boolean;
}

/** REQ-3.3.1: it shows when ALL of these hold (room for it is the place it is given: `placePopover` with `cover: false`). */
export function miniShouldShow(f: ShowFlags): boolean {
  return f.enabled && f.source === "mouse" && f.selection === "text" && !f.inOneLink && !f.painterOn && !f.composing && !f.blocked;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The bounding box of the selection's client rects, clipped to the visible part of the editor's scroll area (`clip`; null: no clip). Rects with no size (a collapsed
 * range, a line break) are not counted. Null when nothing is left.
 */
export function selectionBox(rects: readonly Rect[], clip: Rect | null): Rect | null {
  const live = rects.filter((r) => r.right - r.left > 0 && r.bottom - r.top > 0);
  if (!live.length) return null;
  let box: Rect = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const r of live) box = { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top), right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom) };
  if (clip) box = { left: Math.max(box.left, clip.left), top: Math.max(box.top, clip.top), right: Math.min(box.right, clip.right), bottom: Math.min(box.bottom, clip.bottom) };
  return box.right > box.left && box.bottom > box.top ? box : null;
}

/** The keys that leave the mini toolbar where it is: modifiers alone, the formatting keys (Ctrl/Cmd+B, I, U) and Alt+F10 (the way to it). Any other key changes the text or the selection. */
export function keyKeepsMini(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"].includes(e.key)) return true;
  if (e.altKey && e.key === "F10") return true;
  return (e.ctrlKey || e.metaKey) && !e.altKey && ["b", "i", "u"].includes(e.key.toLowerCase());
}

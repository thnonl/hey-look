// Where a popover that sits next to its button (absolute, `left` / `top` from CSS) has to move so that none of it is cut off by the window.
// Pure geometry; the hook that applies it is useFitInWindow in components/ui.tsx.

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * `shift`: how far to move it sideways (negative = left); `maxHeight`: set when it is taller than the room below its top edge
 * (it then scrolls inside), never smaller than `minHeight` so a window that is shorter still shows something usable.
 */
export function fitInWindow(box: Box, vw: number, vh: number, edge = 8, minHeight = 160): { shift: number; maxHeight: number | null } {
  // too far right: back to the edge; then, if that put it past the left edge (window narrower than the popover), the left edge wins
  const shift = Math.max(edge - box.left, Math.min(0, vw - edge - box.right));
  const room = vh - edge - box.top;
  return { shift, maxHeight: box.bottom - box.top > room ? Math.max(room, minHeight) : null };
}

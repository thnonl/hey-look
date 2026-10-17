// How far down a popover or a menu may reach. The window's bottom edge is not the limit while a toast is on show under it: the toast stack is fixed at the bottom
// of the window, above everything in the page, so a popover that ran down to the edge had its footer (the Schedule button of Send later) behind a toast
// (v1.0.6 QA round 2, BUG-A1-4). Pure geometry; the placement code is in components/ui.tsx.

/** The box of the toast stack: only what the popover is compared with. */
export interface ToastBox {
  left: number;
  right: number;
  top: number;
}

/**
 * The lowest y a popover that spans `popLeft`..`popRight` may reach: `vh - edge`, or just above the toast stack when the stack is under it
 * (sideways overlap). `gap`: the space kept between the two.
 */
export function popoverFloor(vh: number, edge: number, popLeft: number, popRight: number, toasts: ToastBox | null, gap = 8): number {
  const bottom = vh - edge;
  if (!toasts || toasts.right <= popLeft || toasts.left >= popRight) return bottom;
  return Math.min(bottom, toasts.top - gap);
}

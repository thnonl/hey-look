// Print a message (1.0.7 W13.14 A10): the frame's print() can take seconds before the print dialog opens (a long message is laid out for the paper first) and blocks the page while it
// does, so the status "Preparing to print…" is painted FIRST (RULE-4) and stays until print() returns, at least 300 ms. A second press while it works does nothing.
import { create } from "zustand";

export const usePrinting = create<{ on: boolean }>(() => ({ on: false }));

const paint = () =>
  new Promise<void>((done) => {
    const guard = setTimeout(done, 120); // (a window that is not painting gets no animation frame)
    requestAnimationFrame(() => setTimeout(() => (clearTimeout(guard), done()), 0));
  });

export async function printFrame(frame: HTMLIFrameElement | null): Promise<void> {
  const win = frame?.contentWindow;
  if (!win || usePrinting.getState().on) return;
  usePrinting.setState({ on: true });
  const since = Date.now();
  try {
    await paint();
    win.print();
  } finally {
    setTimeout(() => usePrinting.setState({ on: false }), Math.max(0, 300 - (Date.now() - since)));
  }
}

// The page side of Print on macOS (W5.3): the message frame says what it was built from, and a press on Print hands the print document (printDoc.ts) to the backend.
import { api } from "./api";
import { t } from "./i18n";
import { buildPrintDoc, type PrintSource } from "./printDoc";
import { usePrinting } from "./printStatus";

const sources = new WeakMap<HTMLIFrameElement, () => PrintSource>();

/** The message frame says what it was built from (a getter, so that it is always the current message). Forgotten with the frame. */
export function setPrintSource(frame: HTMLIFrameElement | null, get: () => PrintSource): void {
  if (frame) sources.set(frame, get);
}

/** Print the message shown in the frame through the backend (macOS). An error becomes the toast of this window; a second press while one is under way does nothing. */
export async function printFrameNative(frame: HTMLIFrameElement | null, toast: (text: string) => void): Promise<void> {
  const get = frame ? sources.get(frame) : undefined;
  if (!get || usePrinting.getState().on) return;
  usePrinting.setState({ on: true });
  const since = Date.now();
  try {
    const src = get();
    await api.printHtml(buildPrintDoc(src), src.subject);
  } catch {
    toast(t("reading.msg.printFailed"));
  } finally {
    setTimeout(() => usePrinting.setState({ on: false }), Math.max(0, 300 - (Date.now() - since)));
  }
}

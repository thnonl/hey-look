// The part of the editor that is loaded on demand: the table nodes (prosemirror-tables is about 40 KB) and the picture node with its alignment and link
// (kitExtensions.ts). The main chunk only holds this loader. The extension set (extensions.ts) takes the nodes from here, so an editor must not be created
// before they are there: `useKit()` is true once they are (Compose and the signature editor wait for it; the loader of the editor chunk, lazyViews.tsx, fetches the kit
// with it, so in practice they never wait).

import type { AnyExtension } from "@tiptap/react";
import { useEffect, useState } from "react";
import type { QuoteOptions } from "./quoteNode";

type Kit = typeof import("./kitExtensions");
let kit: Kit | null = null;
let pending: Promise<void> | null = null;

/** Fetches the kit (once). */
export function loadKit(): Promise<void> {
  pending ??= import("./kitExtensions").then(
    (m) => void (kit = m),
    (e: unknown) => {
      pending = null; // a failure is not remembered: the next try fetches again (WP9d)
      throw e;
    },
  );
  return pending;
}

/** The kit's extensions, or none while it has not arrived (the editor is not made then). `pictures`: the message body has the picture node, the signature editor does not; `quote`: the message body has the quote block of a reply / forward; `find`: the message body has Find and replace (Ctrl+F). */
export const kitExtensions = (o: { pictures: boolean; quote?: QuoteOptions; find?: boolean }): AnyExtension[] => (kit ? kit.kitExtensions(o) : []);

/** True once the kit is loaded; starts loading it. */
export function useKit(): boolean {
  const [ready, setReady] = useState(kit !== null);
  useEffect(() => {
    if (!kit) void loadKit().then(() => setReady(true));
  }, []);
  return ready;
}

// (this module belongs to the editor chunk, which is fetched when the browser is idle after the first paint: the kit comes with it, and the table, link and picture tools of
// insertUi.tsx follow a moment later, so the first click in a link or a table shows its bubble or bar at once - they run after the editor chunk, WP9d)
if (typeof window !== "undefined") {
  setTimeout(() => void loadKit().catch(() => undefined), 800);
  setTimeout(() => void import("./insertUi").catch(() => undefined), 2500);
  setTimeout(() => void import("./MiniToolbar").catch(() => undefined), 2600); // (the mini toolbar over a mouse selection, W3.3)
}

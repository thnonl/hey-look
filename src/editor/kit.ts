// The part of the editor that is loaded on demand: the table nodes (prosemirror-tables is about 40 KB) and the picture node with its alignment and link
// (kitExtensions.ts). The main chunk only holds this loader. The extension set (extensions.ts) takes the nodes from here, so an editor must not be created
// before they are there: `useKit()` is true once they are (Compose and the signature editor wait for it; the chunk is fetched at start-up, long before a person
// opens a message, so in practice they never wait).

import type { AnyExtension } from "@tiptap/react";
import { useEffect, useState } from "react";

type Kit = typeof import("./kitExtensions");
let kit: Kit | null = null;
let pending: Promise<void> | null = null;

/** Fetches the kit (once). */
export function loadKit(): Promise<void> {
  pending ??= import("./kitExtensions").then((m) => void (kit = m));
  return pending;
}

/** The kit's extensions, or none while it has not arrived (the editor is not made then). `pictures`: the message body has the picture node, the signature editor does not. */
export const kitExtensions = (o: { pictures: boolean }): AnyExtension[] => (kit ? kit.kitExtensions(o) : []);

/** True once the kit is loaded; starts loading it. */
export function useKit(): boolean {
  const [ready, setReady] = useState(kit !== null);
  useEffect(() => {
    if (!kit) void loadKit().then(() => setReady(true));
  }, []);
  return ready;
}

// (start-up: the first editor opens a moment later and finds it there; the table, link and picture tools of insertUi.tsx follow, so the first click in a link or a table
// shows its bubble or bar at once)
if (typeof window !== "undefined") {
  setTimeout(() => void loadKit(), 800);
  setTimeout(() => void import("./insertUi"), 2500);
}

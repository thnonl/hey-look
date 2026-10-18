// The compose window's side of its requests to the main window (composeRequests.ts has the kinds). Fire and forget: when the main page is
// busy or reloading the request is lost, which costs a toast or a refresh, never a message (the message is in the outbox or on the server).
import { api } from "../api";
import { CW_PREFIX } from "./composeRequests";

let seq = 0;

export function notifyMain(kind: "toast" | "draft-saved" | "scheduled" | "dialog" | "sync" | "refresh", payload?: unknown): void {
  void api.popoutRequest(`cw${++seq}`, `${CW_PREFIX}${kind}`, payload ?? null).catch(() => undefined);
}

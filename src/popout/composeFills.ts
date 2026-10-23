// The main window's hand-over of finished Replies / Forwards to the windows that opened as a shell (composeFill.ts has the logic and the id; composeHub.ts feeds `listening`).
import { api } from "../api";
import type { ComposeInit } from "../store";
import { FILL_ID, FillHub } from "./composeFill";

export const fills = new FillHub<ComposeInit>((label, init) => void api.popoutReply(label, FILL_ID, true, init, null).catch(() => undefined));

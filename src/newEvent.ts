import { openPopout } from "./popout/open";
import { useStore, type EventInit } from "./store";

/** Opens the New event dialog (the Calendar is loaded when the dialog opens, WP9d). Used by the ribbon, the command bar, the Calendar keys and the views. */
export function newEvent(init?: EventInit) {
  useStore.getState().setDialog({ type: "event", init });
}

/** Shift+click on New event (the ribbon): a new event in a window of its own (W4.6, REQ-4.6.6 c). */
export function newEventWindow(init?: EventInit) {
  void openPopout("event", null, { init });
}

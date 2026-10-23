import { useStore, type EventInit } from "./store";

/** Opens the New event dialog (the Calendar is loaded when the dialog opens, WP9d). Used by the ribbon, the command bar, the Calendar keys and the views. */
export function newEvent(init?: EventInit) {
  useStore.getState().setDialog({ type: "event", init });
}

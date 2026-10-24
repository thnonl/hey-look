// "Search mail for the selection" in the main window (1.0.7 W8.1, REQ-8.1.5): the text menu of the main window and the request of a reader window both end here. (The pure part, the query made from the
// selected text, is selectionSearch.ts.)
import { useStore } from "./store";

/** The search box shows the words, the list shows the results (with the scope the person chose in the search panel, unchanged), the query joins the recent searches, and the focus goes to the list. */
export function searchMailHere(query: string): void {
  void useStore.getState().setSearch(query, true).then(() => {
    const list = document.querySelector<HTMLElement>(".ml-body");
    (list?.querySelector<HTMLElement>(".ml-row.selected, .ml-row") ?? list)?.focus({ preventScroll: true });
  });
}

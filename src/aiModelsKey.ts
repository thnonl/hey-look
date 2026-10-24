// When Settings > AI Assistant asks the endpoint for its model list (1.0.7 W8.2, extended by W8.11): only when what the request depends on changed since the last one. Pure,
// so scripts/test-ai-models-key.mjs runs it with node.
//
// The request depends on the Base URL (and, with a model list URL, on the resolved address of the list and on whether the key goes there) and on the key that is used: the typed
// key when one is typed, else the saved one. Saving moves the typed key to the saved key: the key is the same, so Save asks nothing; a second Save asks nothing; typing and
// then taking the typing back inside the debounce asks nothing.

/** The fetch key of "there is nothing to ask" (no Base URL): no request, nothing in the status slot. */
export const NO_LIST = "none";

/** The saved key as the tab knows it: there is one (`has`), and which one (`tag`: "s" for the one that was there when the tab opened, else the tag of the key saved here). */
export interface SavedKey {
  has: boolean;
  tag: string;
}

/** The identity of a typed key (the text itself, in memory only: it is compared, never shown, stored or sent anywhere). */
export const keyTag = (typed: string): string => `t:${typed.trim()}`;

/** The Base URL as the request sees it: trimmed, no trailing slash (the request adds its own path). */
export const normEndpoint = (endpoint: string): string => endpoint.trim().replace(/\/+$/, "");

/** Which key the request uses: the typed one, else the saved one, else none. */
export function keyIdentity(typed: string, saved: SavedKey): string {
  const t = typed.trim();
  return t ? keyTag(t) : saved.has ? saved.tag : "no-key";
}

/**
 * The key of a model list request: the same text means the same request, so none is made. `list` is what the model list URL adds (W8.11): the resolved address of the list and
 * whether the key is sent there; without one the request is `{Base URL}/models` with the key as today.
 */
export function modelsFetchKey(endpoint: string, typed: string, saved: SavedKey, list?: { url: string; sendKey: boolean }): string {
  const base = normEndpoint(endpoint);
  if (!base) return NO_LIST;
  return list ? `${base}\n${list.url}\n${list.sendKey ? keyIdentity(typed, saved) : "key-not-sent"}` : `${base}\n${keyIdentity(typed, saved)}`;
}

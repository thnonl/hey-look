// The model list URL of Settings > AI Assistant > Advanced (1.0.7 W8.11): where the list of models is asked, and whether the API key goes there. Pure, so
// scripts/test-ai-models-url.mjs runs it. The backend implements the same rules (src-tauri/src/ai.rs `resolve_models_url`); scripts/fixtures/ai-models-url/cases.json is run by both.

/** The longest list URL (characters). */
export const MAX_MODELS_URL = 2000;

/** none: no Base URL, nothing to ask; invalid: the list URL is not one of the three forms; url: the address that is asked. */
export type ModelsUrl = { kind: "none" } | { kind: "invalid" } | { kind: "url"; url: string };

/** The Base URL as the request uses it: trimmed, no trailing slash. */
const baseOf = (base: string): string => base.trim().replace(/\/+$/, "");

/** A web address (scheme http or https, a host), or null. */
function webUrl(text: string): URL | null {
  try {
    const u = new URL(text);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "" ? u : null;
  } catch {
    return null;
  }
}

/**
 * Where the model list is asked:
 * - no Base URL: none;
 * - an empty list URL: the Base URL and /models, as it always was (not parsed);
 * - a value that starts with a single `/`: the Base URL's scheme, user info, host and port with that path and query (the fragment is dropped);
 * - a full http(s) URL: that URL (fragment dropped);
 * - anything else, or longer than 2,000 characters: invalid.
 */
export function resolveModelsUrl(baseUrl: string, listUrl: string): ModelsUrl {
  const base = baseOf(baseUrl);
  if (!base) return { kind: "none" };
  const value = listUrl.trim();
  if (!value) return { kind: "url", url: `${base}/models` };
  if (value.length > MAX_MODELS_URL) return { kind: "invalid" };
  if (value.startsWith("/") && !value.startsWith("//")) {
    const b = webUrl(base);
    if (!b) return { kind: "invalid" };
    try {
      const u = new URL(value, b);
      // (a browser reads "/\\host" like "//host": whatever the rules said, the result must stay on the Base URL's server)
      if (u.origin !== b.origin || u.username !== b.username || u.password !== b.password) return { kind: "invalid" };
      u.hash = "";
      return { kind: "url", url: u.href };
    } catch {
      return { kind: "invalid" };
    }
  }
  const u = webUrl(value);
  if (!u) return { kind: "invalid" };
  u.hash = "";
  return { kind: "url", url: u.href };
}

/** The origin of an address (scheme, host, the port unless it is the default one), or null when it is not an http(s) address. */
export function originOf(url: string): string | null {
  const u = webUrl(url.trim());
  return u ? u.origin : null;
}

/** The server as the tab shows it ("127.0.0.1:31842"): host and port. */
export function hostLabel(url: string): string {
  const u = webUrl(url.trim());
  return u ? u.host : url;
}

/**
 * Is the resolved list on another server than the Base URL's? Only an explicit list URL can be (an empty one is the Base URL's server by definition).
 * False when there is nothing valid to compare.
 */
export function otherServer(baseUrl: string, listUrl: string, resolved: ModelsUrl): boolean {
  if (resolved.kind !== "url" || !listUrl.trim()) return false;
  const a = originOf(baseOf(baseUrl));
  const b = originOf(resolved.url);
  return a !== null && b !== null && a !== b;
}

/**
 * Does the API key go to the list's server? Only to the Base URL's server, or to the one server the person allowed (`keyOrigin`, an origin): never anywhere else.
 * (The backend decides again with the same rule; this is what the tab expects, for its fetch key and its switch.)
 */
export function keyIsSent(baseUrl: string, listUrl: string, resolved: ModelsUrl, keyOrigin: string): boolean {
  if (resolved.kind !== "url") return false;
  if (!otherServer(baseUrl, listUrl, resolved)) return true;
  return keyOrigin !== "" && keyOrigin === originOf(resolved.url);
}

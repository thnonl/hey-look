// The search box text is the single source of truth ("from:ann is:unread budget"): the small helpers that read and change it (SearchBox.tsx and the advanced part, SearchAdvanced.tsx).
export const tokens = (q: string): string[] => q.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
export const hasTok = (q: string, t: string) => tokens(q).includes(t);
export const toggleTok = (q: string, t: string) => (hasTok(q, t) ? tokens(q).filter((x) => x !== t) : [...tokens(q), t]).join(" ");
const dropKey = (q: string, key: string) => tokens(q).filter((x) => !x.toLowerCase().startsWith(`${key}:`));
export const setKey = (q: string, key: string, value: string) => {
  const rest = dropKey(q, key);
  const v = value.trim();
  if (!v) return rest.join(" ");
  return [...rest, `${key}:${/\s/.test(v) ? `"${v}"` : v}`].join(" ");
};
export const getKey = (q: string, key: string) => {
  const t = tokens(q).find((x) => x.toLowerCase().startsWith(`${key}:`));
  return t ? t.slice(key.length + 1).replace(/^"|"$/g, "") : "";
};

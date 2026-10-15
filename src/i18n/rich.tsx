import { Fragment, createElement, type ReactNode } from "react";
import { t, type Key } from "./index.ts";

/**
 * A translated sentence with parts that are React elements: "Raise it in {link}." -> text + the element.
 * Whole sentences stay in the dictionary; `slots` maps a placeholder name to the node that replaces it.
 */
export function tx(key: Key, slots: Record<string, ReactNode>, params?: Record<string, string | number>): ReactNode[] {
  // the slot placeholders are passed through t() untouched, then split out here
  const kept: Record<string, string | number> = { ...(params ?? {}) };
  for (const n of Object.keys(slots)) kept[n] = `{${n}}`;
  return t(key, kept)
    .split(/(\{\w+\})/g)
    .map((part, i) => {
      const m = /^\{(\w+)\}$/.exec(part);
      return createElement(Fragment, { key: i }, m && m[1] in slots ? slots[m[1]] : part);
    });
}

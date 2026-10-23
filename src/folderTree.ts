// The folders of a mailbox as a tree (1.0.7 W13.10, REQ-13.10.2). The backend says, for every folder of the person, its parent, depth and label (`FolderInfo`); this puts them in tree order and
// hides what a collapsed folder holds. Pure: scripts/test-folder-create.mjs loads this file with node.

/** What the tree needs of a folder (a `FolderInfo` has it). */
export interface TreeFolder {
  key: string;
  name: string;
  label?: string;
  parent?: string | null;
}

/** The key under which "this folder is collapsed" is kept in `prefs.collapsed`, like the mailbox groups. */
export const collapsedKey = (accountId: string, folderKey: string) => `${accountId}|${folderKey}`;

/**
 * Tree order: each parent followed by its children, siblings sorted by label, case-insensitive and in the language of the app (`Intl.Collator`, numbers by value). A folder whose parent
 * is not in the list (a parent the server does not list) counts as a top-level one.
 */
export function orderTree<T extends TreeFolder>(folders: readonly T[], locale?: string): T[] {
  let coll: Intl.Collator;
  try {
    coll = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  } catch {
    coll = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  }
  const keys = new Set(folders.map((f) => f.key));
  const kids = new Map<string, T[]>();
  const roots: T[] = [];
  for (const f of folders) {
    if (f.parent && keys.has(f.parent)) {
      const list = kids.get(f.parent);
      if (list) list.push(f);
      else kids.set(f.parent, [f]);
    } else roots.push(f);
  }
  const sorted = (list: T[]) => list.sort((a, b) => coll.compare(a.label ?? a.name, b.label ?? b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: T[] = [];
  const walk = (f: T) => {
    out.push(f);
    for (const k of sorted(kids.get(f.key) ?? [])) walk(k);
  };
  for (const f of sorted(roots)) walk(f);
  return out;
}

/** Does the folder have children in this list? */
export const hasChildren = (folders: readonly TreeFolder[], key: string) => folders.some((f) => f.parent === key);

/** The rows to draw: the folders of `ordered` (tree order) whose ancestors are all expanded. */
export function visibleTree<T extends TreeFolder>(ordered: readonly T[], isCollapsed: (key: string) => boolean): T[] {
  const hidden = new Set<string>();
  return ordered.filter((f) => {
    if (f.parent && (hidden.has(f.parent) || isCollapsed(f.parent))) {
      hidden.add(f.key);
      return false;
    }
    return true;
  });
}

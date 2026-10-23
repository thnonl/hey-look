// The name of a new folder (1.0.7 W13.10, REQ-13.10.5): the rules the "New folder" dialog checks while the person types. The backend checks the same rules again (`check_name` in folders.rs).
// Pure: scripts/test-folder-create.mjs loads this file with node.

/** A name of at most this many characters. */
export const MAX_FOLDER_NAME = 100;

export type NameProblem =
  | { kind: "empty" }
  | { kind: "long" }
  /** the characters found, each once, separated by spaces */
  | { kind: "chars"; chars: string }
  | { kind: "reserved" }
  | { kind: "exists" };

export interface NameCheck {
  /** the name as it will be created: leading and trailing spaces removed */
  name: string;
  problem: NameProblem | null;
}

// control characters (U+0000 to U+001F, U+007F to U+009F)
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * `siblings` = the names a new folder must not repeat (ignoring case): the folders at the same level, and at the top level also the standard folders by their server name and by the name shown
 * in the app ("Archive", "Sent Items"). `delimiter` = the hierarchy delimiter of the server, which a name may not contain.
 */
export function checkFolderName(raw: string, delimiter: string | null | undefined, siblings: readonly string[]): NameCheck {
  const name = raw.trim();
  if (!name) return { name, problem: { kind: "empty" } };
  if ([...name].length > MAX_FOLDER_NAME) return { name, problem: { kind: "long" } };
  const found: string[] = [];
  for (const c of name) {
    const bad = CONTROL.test(c) || c === "*" || c === "%" || c === '"' || c === "\\" || (!!delimiter && [...delimiter].length === 1 && c === delimiter);
    if (bad && !found.includes(c)) found.push(c);
  }
  if (found.length) return { name, problem: { kind: "chars", chars: found.join(" ") } };
  if (name.toLowerCase() === "inbox" || name === "." || name === "..") return { name, problem: { kind: "reserved" } };
  const lower = name.toLowerCase();
  if (siblings.some((s) => s.toLowerCase() === lower)) return { name, problem: { kind: "exists" } };
  return { name, problem: null };
}

// A press on a row of a menu opened from inside a popover must not count as a press outside the popover (F-2: the '...' menu of
// the calendar event popover did nothing when clicked with the mouse). Run: node --experimental-strip-types scripts/test-popover-menu.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { menuOwners, pressIsOutside } from "../src/pressInside.ts";

// a tiny DOM: parent links, contains(), closest(".dd-fixed")
const node = (name, parent = null, cls = "") => {
  const n = { name, parent, cls, contains(o) { for (let x = o; x; x = x.parent) if (x === n) return true; return false; }, closest(sel) { for (let x = n; x; x = x.parent) if (sel === ".dd-fixed" && x.cls === "dd-fixed") return x; return null; } };
  return n;
};
const body = node("body");
const pop = node("popover", body);
const anchor = node("dd wrapper", pop);
const trigger = node("... button", anchor);
const outside = node("calendar grid", body);
const menu = node("menu (portal on body)", body, "dd-fixed"); // NOT a DOM descendant of the popover
const row = node("Edit row", menu);
const other = node("other menu", body, "dd-fixed");
const otherRow = node("its row", other);

const popRef = { current: pop };
// no menu registered: a press on the portalled row is outside (this is the old behaviour that closed the popover on mousedown)
assert.equal(pressIsOutside(row, [popRef]), true);
// the menu registers the anchor it was opened from
menuOwners.set(menu, { current: anchor });
assert.equal(pressIsOutside(row, [popRef]), false, "a press on a row of the popover's own menu is inside");
assert.equal(pressIsOutside(menu, [popRef]), false, "also on the menu itself");
assert.equal(pressIsOutside(trigger, [popRef]), false, "the popover's own content stays inside");
assert.equal(pressIsOutside(outside, [popRef]), true, "a press elsewhere closes the popover");
assert.equal(pressIsOutside(null, [popRef]), true);
// a menu that belongs to something else (anchor outside the popover) is still outside
menuOwners.set(other, { current: outside });
assert.equal(pressIsOutside(otherRow, [popRef]), true, "a foreign menu does not keep the popover open");
// an anchor ref that was cleared (menu closing) does not throw
menuOwners.set(other, { current: null });
assert.equal(pressIsOutside(otherRow, [popRef]), true);
// several roots: inside any of them is inside
assert.equal(pressIsOutside(row, [{ current: outside }, popRef]), false);
assert.equal(pressIsOutside(row, [{ current: null }]), true, "an unmounted root contains nothing");

// the wiring: useOutside decides through pressIsOutside (not a bare contains), and every FloatingMenu registers its anchor
const ui = readFileSync(new URL("../src/components/ui.tsx", import.meta.url), "utf8");
const useOut = ui.slice(ui.indexOf("export function useOutside"), ui.indexOf("export function MenuList"));
assert.ok(useOut.includes("pressIsOutside(e.target, refs)"), "useOutside must use pressIsOutside");
assert.ok(!/\.contains\(e\.target/.test(useOut), "useOutside must not test the DOM tree alone: menus are portalled");
assert.ok(/menuOwners\.set\(el, anchor\)/.test(ui) && /menuOwners\.delete\(el\)/.test(ui), "FloatingMenu must register and unregister its anchor");
assert.ok(/className="dd-fixed"/.test(ui), "the portal element keeps the class pressInside.ts looks for");
// the menu rows run their action on click and keep the item mousedown free of handlers that would swallow it
const menuList = ui.slice(ui.indexOf("export function MenuList"), ui.indexOf("const ITEMS"));
assert.ok(/onClick=/.test(menuList) && !/onMouseDown|onPointerDown/.test(menuList));

// W1.1 / W1.2: every outside-press listener is on document in the CAPTURE phase. A bubble listener never runs for a press inside a dialog (the
// Modal box stops it) or on the Windows title bar (Tauri's drag script stops it).
for (const f of ["src/components/ui.tsx", "src/components/DateTimeFields.tsx", "src/editor/ColorPalette.tsx", "src/components/ContextMenu.tsx"]) {
  const src = readFileSync(new URL("../" + f, import.meta.url), "utf8");
  const adds = [...src.matchAll(/document\.(add|remove)EventListener\("mousedown",\s*(\w+)(,\s*true)?\)/g)];
  assert.ok(adds.length >= 2, f + " must keep its outside-press listener");
  for (const m of adds) assert.ok(m[3], f + ": document." + m[1] + 'EventListener("mousedown", ' + m[2] + ") needs the capture flag (true)");
}
// a press inside a message's frame is relayed to the window's document so the popovers of the main window close
const guard = readFileSync(new URL("../src/contextGuard.ts", import.meta.url), "utf8");
assert.ok(/frame\.dispatchEvent\(new MouseEvent\("mousedown", \{ bubbles: true \}\)\)/.test(guard), "guardFrame must relay a frame press to the parent document");

// W2.20: an independent on/off row (kind "check") is a menuitemcheckbox, a pick-one row keeps menuitemradio, a plain row is a menuitem; all with aria-checked when they have a state
assert.ok(ui.includes('kind?: "check" | "radio"'), "MenuItem has a kind");
assert.ok(menuList.includes('it.checked === undefined ? "menuitem" : it.kind === "check" ? "menuitemcheckbox" : "menuitemradio"'), "MenuList picks the role from the kind");
assert.ok(menuList.includes("aria-checked={it.checked === undefined ? undefined : it.checked}"), "aria-checked follows the state");
// the independent toggles of the message are checkboxes: the More rows of the compose bar and of the formatting bar
const composeSrc = readFileSync(new URL("../src/components/Compose.tsx", import.meta.url), "utf8");
for (const k of ["compose.bar.meeting", "compose.bar.encrypt", "compose.bar.sign", "compose.bar.confidential", "compose.bar.writeWithAi", "compose.bar.signThis", "compose.bar.attachPublicKey"]) {
  const line = composeSrc.split("\n").find((l) => l.includes(`t("${k}")`) && l.includes("checked:"));
  assert.ok(line && line.includes('kind: "check"'), `${k} is a check row`);
}
for (const k of ["mail.importance.high", "mail.importance.low"]) {
  const line = composeSrc.split("\n").find((l) => l.includes(`t("${k}")`) && l.includes("checked:"));
  assert.ok(line && !line.includes("kind:"), `${k} stays a radio row`);
}
const controlsSrc = readFileSync(new URL("../src/editor/controls.tsx", import.meta.url), "utf8");
assert.ok(/compose\.fmt\.subscript[^\n]*kind: "check"/.test(controlsSrc) && /compose\.fmt\.superscript[^\n]*kind: "check"/.test(controlsSrc), "Subscript and Superscript are check rows");
assert.ok(!/compose\.fmt\.alignLeft[^\n]*kind: "check"/.test(controlsSrc) && /ALIGNS\.map\(\(a\) => \(\{[^\n]*checked: c\.st\.align === a\.id/.test(controlsSrc), "alignment stays a radio group");
// the recipient field is a combobox over its suggestions (W2.20, REQ-2.20.3)
for (const part of ['role="combobox"', 'aria-autocomplete="list"', "aria-expanded={sugg.length > 0}", "aria-controls={listId}", "aria-activedescendant={hi >= 0", 'role="listbox" aria-label={label}', "id={`${listId}-${i}`} role=\"option\""]) assert.ok(composeSrc.includes(part), `RecipientField: ${part}`);

console.log("popover menu rules: ok");

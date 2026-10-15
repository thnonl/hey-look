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

console.log("popover menu rules: ok");

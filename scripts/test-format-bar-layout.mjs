// Checks src/editor/toolbarLayout.ts: which controls of the formatting toolbar stay in the one row and which move into "More formatting options"
// (spec-rich-text.md REQ-10, AC-16, AC-17). The numbers are the real ones of the toolbar (BAR_META); the widths are what App.css `.fmt-bar` draws.
// Run: node --experimental-strip-types scripts/test-format-bar-layout.mjs
import assert from "node:assert/strict";
import { BAR_META, GAP, MORE_W, SEP, barWidth, layoutBar } from "../src/editor/toolbarLayout.ts";

const items = (variant) => Object.entries(BAR_META).filter(([, m]) => m.variants.includes(variant)).map(([id, m]) => ({ id, ...m }));
const compose = items("compose");
const compact = items("compact");

// the spec's priority list (4.1): B, I, U, Bulleted, Numbered, Link, Picture, Font color, Highlight, Font, Size, Styles, Align, Increase indent, Decrease indent,
// Strikethrough, (Table), Insert, Clear formatting, Undo, Redo
const byPriority = [...compose].sort((a, b) => a.priority - b.priority).map((i) => i.id);
assert.deepEqual(byPriority, [
  "bold", "italic", "underline", "bulleted", "numbered", "link", "picture", "fontColor", "highlight", "font", "size", "styles", "align", "indentMore", "indentLess", "strike", "table", "insert", "clear", "undo", "redo",
]);
assert.equal(new Set(compose.map((i) => i.order)).size, compose.length, "every control has a place of its own");
assert.equal(new Set(compose.map((i) => i.priority)).size, compose.length, "every control has a priority of its own");

// plenty of room: everything is in the bar, in bar order, nothing in More
{
  const full = layoutBar(compose, 5000);
  assert.deepEqual(full.hidden, []);
  assert.deepEqual(full.visible, [...byPriority].sort((a, b) => BAR_META[a].order - BAR_META[b].order));
  // the bar reads as the spec's picture: Undo Redo | Font Size | B I U S | colours | Bulleted Numbered Decrease Increase | Align | Styles | Link Picture Insert | Clear
  assert.deepEqual(full.visible, ["undo", "redo", "font", "size", "bold", "italic", "underline", "strike", "fontColor", "highlight", "bulleted", "numbered", "indentLess", "indentMore", "align", "styles", "link", "picture", "table", "insert", "clear"]);
  // and exactly as wide as the bar needs
  assert.equal(layoutBar(compose, barWidth(compose)).hidden.length, 0);
  assert.equal(layoutBar(compose, barWidth(compose) - 1).hidden.length, 1, "one pixel less: the least important control (Redo) goes");
  assert.deepEqual(layoutBar(compose, barWidth(compose) - 1).hidden, ["redo"]);
}

// the compact bar (signature, template) has no picture button
assert.ok(!compact.some((i) => i.id === "picture"));
assert.ok(layoutBar(compact, 5000).visible.length === compose.length - 1);

// AC-17: in a compose pane of 360 px (16 px padding each side, the Light / Dark switch as two icons) B I U, Bulleted, Numbered, Link and Picture stay
const pane360 = 360 - 2 * 16 - 66;
{
  const r = layoutBar(compose, pane360);
  for (const id of ["bold", "italic", "underline", "bulleted", "numbered", "link", "picture"]) assert.ok(r.visible.includes(id), `${id} is in the bar at 360 px`);
  assert.ok(r.hidden.includes("fontColor") && r.hidden.includes("font"), "the rest is in More");
  // the hidden ones come in priority order, the most important first
  assert.deepEqual(r.hidden, byPriority.filter((id) => r.hidden.includes(id)));
}

// as the pane gets narrower, controls leave one at a time in reverse priority and never come back out of order
let last = compose.length + 1;
for (let w = 700; w >= 40; w -= 3) {
  const r = layoutBar(compose, w);
  assert.ok(r.visible.length <= last, `widening never happens while narrowing (${w})`);
  last = r.visible.length;
  // what stays is always a prefix of the priority list
  assert.deepEqual([...r.visible].sort(), byPriority.slice(0, r.visible.length).sort(), `visible set at ${w} is the most important controls`);
  if (r.visible.length) assert.ok(barWidth(compose.filter((i) => r.visible.includes(i.id))) <= w, `it fits at ${w}`);
}

// even with no room at all the More button is the one thing that is always there
assert.deepEqual(layoutBar(compose, MORE_W).visible, []);
assert.equal(barWidth([]), MORE_W);
// separators: one between two groups
assert.equal(barWidth([{ id: "a", group: "x", order: 1, priority: 1, width: 28 }, { id: "b", group: "y", order: 2, priority: 2, width: 28 }]), 28 + 28 + MORE_W + SEP + 3 * GAP);
assert.equal(barWidth([{ id: "a", group: "x", order: 1, priority: 1, width: 28 }, { id: "b", group: "x", order: 2, priority: 2, width: 28 }]), 28 + 28 + MORE_W + 2 * GAP);
console.log("format-bar-layout: all checks passed");

// Message importance (F-24): the Compose state rules (src/importance.ts) and the places that carry the choice.
// Run: node --experimental-strip-types scripts/test-importance.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { draftImportance, initialImportance, pressImportance, shownImportance } from "../src/importance.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// 1. Every new message, reply and forward starts Normal; only a reopened draft / scheduled message brings its own.
assert.equal(initialImportance({}), "normal");
assert.equal(initialImportance({ importance: undefined }), "normal");
assert.equal(initialImportance({ importance: null }), "normal");
assert.equal(initialImportance({ importance: "normal" }), "normal");
assert.equal(initialImportance({ importance: "high" }), "high", "a reopened draft restores High");
assert.equal(initialImportance({ importance: "low" }), "low", "a reopened draft restores Low");
assert.equal(initialImportance({ importance: "urgent" }), "normal", "an unknown value is Normal");
// a reply / forward is opened with an init that has no importance (it is not a setting and not inherited from the mail replied to)
const actions = read("src/actions.ts");
assert.ok(!/importance/i.test(actions), "replyTo / forward never set an importance");
const reply = { accountId: "a1", to: ["x@y.z"], subject: "Re: x", isReply: true };
assert.equal(initialImportance(reply), "normal");

// 2. The two toggle buttons: pressing the one that is on goes back to Normal, pressing the other switches over.
assert.equal(pressImportance("normal", "high"), "high");
assert.equal(pressImportance("normal", "low"), "low");
assert.equal(pressImportance("high", "high"), "normal");
assert.equal(pressImportance("low", "low"), "normal");
assert.equal(pressImportance("high", "low"), "low");
assert.equal(pressImportance("low", "high"), "high");

// 3. Normal is not sent (no header); High / Low are.
assert.equal(draftImportance("normal"), undefined);
assert.equal(draftImportance("high"), "high");
assert.equal(draftImportance("low"), "low");

// 4. The mark in the list / reading pane: nothing for Normal or an absent value.
assert.equal(shownImportance("high"), "high");
assert.equal(shownImportance("low"), "low");
assert.equal(shownImportance("normal"), null);
assert.equal(shownImportance(undefined), null);
assert.equal(shownImportance(null), null);

// 5. The choice travels: Compose state -> draft -> reopen (undo / failed send), reopened draft, scheduled message.
const compose = read("src/components/Compose.tsx");
assert.match(compose, /useState<Importance>\(initialImportance\(init\)\)/, "Compose starts from initialImportance(init)");
assert.match(compose, /importance: draftImportance\(importance\),/, "buildDraft sends the choice");
assert.match(compose, /importance: d\.importance,\n/, "reopen (undo / failed send) restores it");
assert.match(compose, /<ImportanceButtons value=\{importance\} onChange=\{\(v\) => \(setImportance\(v\), touch\(\)\)\} \/>/, "the toolbar buttons mark the message changed");
assert.match(compose, /<ImportanceMark level=\{importance\}[^>]*label \/>/, "the chosen level is shown next to the subject");
assert.match(read("src/components/MessageList.tsx"), /importance: m\.importance,/, "a draft opened from the Drafts folder restores it");
assert.match(read("src/components/ScheduledList.tsx"), /importance: d\.importance,/, "a scheduled message opened for editing restores it");
assert.match(read("src/components/ReadingPane.tsx"), /<ImportanceMark level=\{m\.importance\} size=\{13\} label \/>/, "the reading pane names the level");
assert.match(read("src/components/MessageList.tsx"), /<ImportanceMark level=\{t\.importance\} \/>/, "the list row shows the mark");

// 6. Keyboard / assistive technology: the toggles are buttons with a state, a name and a tooltip.
const comp = read("src/components/Importance.tsx");
assert.match(comp, /<button[\s\S]*?type="button"[\s\S]*?aria-pressed=\{on\}[\s\S]*?aria-label=\{name\}[\s\S]*?title=\{tip\}/, "toggle button with aria-pressed, aria-label and title");
assert.match(comp, /role="group" aria-label=\{t\("compose\.bar\.importance"\)\}/);

console.log("importance: all checks passed");

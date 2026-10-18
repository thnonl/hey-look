// A long email is translated in parts (src/translateChunks.ts): cut on paragraph boundaries, then sentences, then at a space or line break,
// then anywhere; pieces of about 8,000 characters; whatever stood between two pieces is kept; the text beyond 60,000 characters is left out.
// Run: node --experimental-strip-types scripts/test-translate-chunks.mjs
import assert from "node:assert/strict";
import { CHUNK_CHARS, MAX_CHARS, capCut, joinParts, planChunks } from "../src/translateChunks.ts";

assert.equal(CHUNK_CHARS, 8000);
assert.equal(MAX_CHARS, 60000);

const lone = (s) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
/** the invariants every plan has: size, no empty piece, no split surrogate pair, seps count, and the pieces + seps rebuild the text */
function check(text, plan, size = CHUNK_CHARS, cap = MAX_CHARS) {
  const src = text.replace(/\r\n?/g, "\n");
  assert.ok(plan.parts.length >= 1);
  assert.equal(plan.seps.length, plan.parts.length - 1);
  for (const p of plan.parts) {
    assert.ok(p.length <= size, `piece of ${p.length} > ${size}`);
    assert.ok(p.length > 0 || src.trim() === "", "no empty piece");
    assert.ok(!lone(p), "no half of a surrogate pair at an edge");
    assert.equal(p, p.trim(), "no white space at the edge of a piece");
  }
  for (const s of plan.seps) assert.ok(/^\s*$/.test(s), `a separator is white space only: ${JSON.stringify(s)}`);
  const rebuilt = plan.parts.map((p, i) => p + (plan.seps[i] ?? "")).join("");
  if (!plan.truncated) assert.equal(rebuilt, src.trim().length ? src.slice(src.indexOf(src.trim()), src.indexOf(src.trim()) + src.trim().length) : rebuilt, "lossless");
  else {
    assert.ok(src.length > cap);
    assert.ok(src.trimStart().startsWith(rebuilt.slice(0, 200)), "the beginning of the text");
    assert.ok(rebuilt.length <= cap, "within the cap");
  }
  assert.equal(joinParts(plan.parts, plan.seps), rebuilt.trimEnd(), "joining the pieces gives the text back");
}

// 1. a short text is one piece, as before
{
  const p = planChunks("Hello there.\n\nSecond paragraph.");
  assert.deepEqual(p.parts, ["Hello there.\n\nSecond paragraph."]);
  assert.deepEqual(p.seps, []);
  assert.equal(p.truncated, false);
  check("Hello there.\n\nSecond paragraph.", p);
  assert.deepEqual(planChunks("").parts, [""]);
  assert.deepEqual(planChunks("  \n\n ").parts, [""]);
  assert.equal(planChunks("x".repeat(8000)).parts.length, 1, "exactly the size: one piece");
  assert.equal(planChunks("x".repeat(8001)).parts.length, 2, "one more: two");
}

// 2. paragraphs first: whole paragraphs are packed, none is cut while a paragraph boundary will do
{
  const para = (n) => `P${n} ` + "word ".repeat(580).trim(); // about 2,900 characters
  const text = [1, 2, 3, 4, 5, 6, 7].map(para).join("\n\n");
  const plan = planChunks(text);
  check(text, plan);
  assert.equal(plan.parts.length, 4, "two paragraphs of about 2,900 fit in 8,000, a third does not: 2 + 2 + 2 + 1");
  for (const part of plan.parts) assert.ok(/^P\d /.test(part) && /word$/.test(part), "every piece starts and ends on a paragraph");
  assert.ok(plan.seps.every((s) => s === "\n\n"), "the blank line is kept between the pieces");
  // the order is the order of the text
  assert.deepEqual(plan.parts.join("\n\n").match(/P\d/g), ["P1", "P2", "P3", "P4", "P5", "P6", "P7"]);
  // blank lines with spaces, several of them, are one break and are kept as they were
  const odd = `${para(1)}\n \n\n${para(2)}`.repeat(1);
  const q = planChunks(odd + "\n\n" + para(3) + "\n   \n   \n" + para(4));
  check(odd + "\n\n" + para(3) + "\n   \n   \n" + para(4), q);
  assert.equal(q.parts.length, 2);
  assert.equal(q.seps[0], "\n\n");
}

// 3. a paragraph longer than a piece is cut between its sentences
{
  const sentence = (n) => `This is sentence number ${n} of a very long paragraph without any blank line.`;
  const text = Array.from({ length: 300 }, (_, i) => sentence(i + 1)).join(" "); // about 22,000 characters
  const plan = planChunks(text);
  check(text, plan);
  assert.ok(plan.parts.length >= 3 && plan.parts.length <= 4, `${plan.parts.length} pieces`);
  for (const part of plan.parts) assert.ok(part.startsWith("This is sentence number") && part.endsWith("blank line."), "pieces start and end at a sentence");
  assert.ok(plan.seps.every((s) => s === " "), "the space of the sentence break is kept");
  // ! ? and closing quotes stay with their sentence
  const q = planChunks(("He said: “Really?” Yes! " + "Fine. ".repeat(5)).repeat(900));
  check(("He said: “Really?” Yes! " + "Fine. ".repeat(5)).repeat(900), q);
  for (const part of q.parts) assert.ok(/[.!?”]$/.test(part), `ends at a sentence: ...${part.slice(-12)}`);
}

// 4. East Asian text has no spaces: cut after the full stop, nothing is added
{
  const text = "これは長い文章です。".repeat(2000); // 20,000 characters, no space
  const plan = planChunks(text);
  check(text, plan);
  assert.equal(plan.parts.length, 3);
  assert.ok(plan.parts.every((p) => p.endsWith("。")));
  assert.ok(plan.seps.every((s) => s === ""), "joined with nothing");
  assert.equal(joinParts(plan.parts, plan.seps), text);
}

// 5. no paragraph and no sentence end: at a line break, else a space, else anywhere (never inside a surrogate pair)
{
  const lines = Array.from({ length: 900 }, (_, i) => `item ${i} - no full stop here`).join("\n"); // about 24,000 characters
  const a = planChunks(lines);
  check(lines, a);
  assert.ok(a.parts.length >= 3);
  assert.ok(a.parts.every((p) => /^item \d+ /.test(p) && /here$/.test(p)), "cut at line breaks");
  assert.ok(a.seps.every((s) => s === "\n"));
  const spaced = "alpha beta gamma ".repeat(1500); // 25,500 characters, spaces only
  const b = planChunks(spaced);
  check(spaced, b);
  assert.ok(b.parts.every((p) => /^(alpha|beta|gamma)( |$)/.test(p) && /(^| )(alpha|beta|gamma)$/.test(p)), "cut at spaces: whole words");
  const solid = "a".repeat(20000);
  const c = planChunks(solid);
  check(solid, c);
  assert.deepEqual(c.parts.map((p) => p.length), [8000, 8000, 4000]);
  assert.deepEqual(c.seps, ["", ""]);
  const emoji = "\u{1F600}".repeat(9000); // 18,000 UTF-16 units, no break of any kind
  const d = planChunks(emoji);
  check(emoji, d);
  assert.ok(d.parts.length >= 3);
  assert.equal(joinParts(d.parts, d.seps), emoji, "no pair was split");
}

// 6. the cap: a text beyond 60,000 characters is cut at a paragraph near the cap and says so
{
  const para = "word ".repeat(300).trim(); // 1,499 characters
  const text = Array.from({ length: 80 }, () => para).join("\n\n"); // about 120,000
  const plan = planChunks(text);
  assert.equal(plan.truncated, true);
  check(text, plan);
  const total = plan.parts.reduce((n, p) => n + p.length, 0) + plan.seps.reduce((n, s) => n + s.length, 0);
  assert.ok(total <= MAX_CHARS && total >= MAX_CHARS * 0.9, `translated ${total} characters`);
  assert.ok(plan.parts.length <= 9);
  assert.ok(plan.parts.every((p) => p.endsWith("word")), "the cut is between paragraphs");
  // exactly at the cap: nothing is left out
  const exact = planChunks("y ".repeat(30000).trim() + "\n");
  assert.equal(exact.truncated, false);
  assert.equal(planChunks("y ".repeat(30001)).truncated, true);
  // no paragraph and no sentence in the last 30%: cut at a space; nothing at all: at the cap
  assert.equal(capCut("z".repeat(70000), 60000), 60000);
  assert.ok(/ $/.test(("z ".repeat(40000)).slice(0, capCut("z ".repeat(40000), 60000) + 1)));
  assert.ok(!lone("\u{1F600}".repeat(40000).slice(0, capCut("\u{1F600}".repeat(40000), 60001))), "never inside a pair");
  // a smaller cap and size work the same way
  const small = planChunks("aaaa bbbb cccc dddd eeee ffff", 10, 20);
  assert.equal(small.truncated, true);
  check("aaaa bbbb cccc dddd eeee ffff", small, 10, 20);
}

// 7. line ends: CRLF and CR become LF
{
  const p = planChunks("one\r\n\r\ntwo\rthree");
  assert.deepEqual(p.parts, ["one\n\ntwo\nthree"]);
}

// 8. joining: the answers are trimmed and put together with what stood between the pieces, in order
{
  assert.equal(joinParts(["Eins\n", "  Zwei", "Drei  "], ["\n\n", " "]), "Eins\n\nZwei Drei");
  assert.equal(joinParts(["Nur eins"], []), "Nur eins");
  assert.equal(joinParts([], []), "");
  assert.equal(joinParts(["A", "B"], []), "A\n\nB", "no separator known: a blank line");
}

// 9. a fuzz run: random mixtures of paragraphs, sentences, long words, CJK and emoji keep every invariant
{
  let seed = 12345;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  const bits = ["Hello world. ", "Wait, what? ", "Done! ", "\n", "\n\n", "\n \n", "x".repeat(3000), "ä ö ü ", "日本語です。", "\u{1F600}", "tail ", " ", "\r\n"];
  for (let round = 0; round < 60; round++) {
    let text = "";
    const target = 500 + rnd(90000);
    while (text.length < target) text += bits[rnd(bits.length)].repeat(1 + rnd(40));
    const size = [50, 300, 8000][rnd(3)];
    const plan = planChunks(text, size, MAX_CHARS);
    check(text, plan, size);
  }
}

console.log("ok - test-translate-chunks");

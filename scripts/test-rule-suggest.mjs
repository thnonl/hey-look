// What the rule dialog fills in from a message (1.0.8, src/ruleSuggest.ts, src/ruleSource.ts, src/ruleStopwords.ts): the subject core, the exact subject, the domain offer, the
// suggested words. Pure code, no browser. Run: node --experimental-strip-types scripts/test-rule-suggest.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bodyForWords, domainOf, hasSubject, offeredDomain, senderLabel, splitValues, stripReplyPrefixes, subjectCore, subjectExact, suggestWords } from "../src/ruleSuggest.ts";
import { STOP_WORDS } from "../src/ruleStopwords.ts";
import { parseRuleSource, pickRuleMessage, ruleSourceOf } from "../src/ruleSource.ts";

let checks = 0;
const eq = (a, b, m) => (assert.deepEqual(a, b, m), checks++);

// 1. the reply / forward prefixes: the table the Rust matcher is tested with
const table = JSON.parse(readFileSync(new URL("./data/rule-prefix-cases.json", import.meta.url), "utf8"));
for (const [subject, want] of table.cases) eq(stripReplyPrefixes(subject), want, `prefixes of ${JSON.stringify(subject)}`);

// 2. the subject core (AC-3.4)
const core = [
  ["Re: [Shop] Your order #48213 shipped on 2026-10-24", "Your order"], // tie with "shipped on": the first wins
  ["Build #1234 failed", "Build #1234 failed"], // both pieces are one word: the whole subject
  ["Weekly report – week 43", "Weekly report – week"],
  ["AW: WG: Rechnung 2026-10 für Projekt Alpha", "für Projekt Alpha"],
  ["回复：会议纪要 10月25日", "会议纪要"],
  ["会议纪要10月25日", "会议纪要"],
  ["Trả lời: Hóa đơn tháng 10", "Hóa đơn tháng"],
  ["Отв: Счёт на оплату №15 от 12.03", "Счёт на оплату"],
  ["Re: Votre facture d’octobre – 2026", "Votre facture d’octobre"],
  ["【お知らせ】3月分の請求書", "お知らせ"],
  ["Newsletter | October edition", "Newsletter | October edition"],
  ["  Hello   world  ", "Hello world"],
];
for (const [subject, want] of core) {
  const got = subjectCore(subject);
  // (whitespace between words is kept as in the subject: compare on single spaces)
  eq(got.replace(/\s+/g, " "), want, `core of ${JSON.stringify(subject)}`);
  assert.ok(stripReplyPrefixes(subject).replace(/\s+/g, " ").includes(got.replace(/\s+/g, " ")) || stripReplyPrefixes(subject).includes(got), `the core is a piece of the real subject: ${got}`);
}
eq(subjectExact("Re: [Shop] Your order #48213 shipped on 2026-10-24"), "[Shop] Your order #48213 shipped on 2026-10-24", "is exactly: prefixes off, tag and numbers stay");
eq(hasSubject(""), false);
eq(hasSubject("   "), false);
eq(hasSubject("(no subject)"), false);
eq(hasSubject("Hi"), true);

// 3. the domain offer (AC-3.3)
eq(domainOf("Deals@Shop.Example"), "shop.example");
eq(offeredDomain("deals@shop.example", false), "shop.example");
eq(offeredDomain("x@gmail.com", false), null, "public domain");
eq(offeredDomain("x@hotmail.co.uk", false), null, "hotmail.*");
eq(offeredDomain("x@yahoo.fr", false), null, "yahoo.*");
eq(offeredDomain("x@mail.ru", false), null);
eq(offeredDomain("x@gmx.de", false), null);
eq(offeredDomain("x@web.de", false), null);
eq(offeredDomain("x@proton.me", false), null);
eq(offeredDomain("x@163.com", false), null);
eq(offeredDomain("me@mycompany.test", true), null, "my own mailbox");
eq(offeredDomain("nobody", false), null, "no domain");
eq(senderLabel("Deals", "deals@shop.example", false), "Deals");
eq(senderLabel("", "deals@shop.example", false), "deals@shop.example");
eq(senderLabel("Deals", "deals@shop.example", true), "@shop.example");
eq(splitValues("a, b，c、d;;  e "), ["a", "b", "c", "d", "e"]);

// 4. the suggested words (AC-3.5)
const body = [
  "Hello,",
  "Please find the invoice attached. The invoice is due soon; payment is expected by Friday.",
  "> Acme quoted line that is not counted: payment payment payment",
  "Acme will send a second invoice. Acme thanks you. Visit https://shop.example/unsubscribe/48213 or write to help@shop.example.",
  "Click here to unsubscribe. The shop team. Order 48213.",
  "shop shop shop",
  "payment again, and thanks for your payment.",
  "-- ",
  "Signature words signature signature signature",
].join("\n");
const src = { subject: "Acme invoice", text: body, senderName: "Deals", senderEmail: "deals@shop.example" };
const chips = suggestWords(src);
eq(chips, ["invoice", "Acme", "payment"], "AC-3.5: exactly these, in this order");
eq(suggestWords(src), chips, "the same message gives the same chips (run 2)");
eq(suggestWords({ ...src }), chips, "run 3");
eq(suggestWords({ ...src, confidential: true }), [], "confidential: none");
eq(suggestWords({ ...src, text: null }), [], "no readable text: none");
assert.ok(!chips.some((w) => /shop|unsubscribe|the|48213|https/i.test(w)), "no sender word, stop word, number or URL");
eq(bodyForWords("a > b\n> quoted\nsee https://x.test/y and mail me@x.test 2026 word\n-- \nsig"), "a > b see and mail 2026 word".split(" ").filter((w) => w !== "2026").join(" "), "quotes, URLs, addresses, digits and the signature are cut");
// the fill-up: fewer than 3 words with a score of 2 take words of score 1 in text order
eq(suggestWords({ subject: "", text: "Garden tomatoes planted yesterday near fences", senderName: "", senderEmail: "x@y.test" }), ["Garden", "tomatoes", "planted"], "score-1 words in text order up to 3");
eq(suggestWords({ subject: "Quarterly roadmap review", text: "", senderName: "", senderEmail: "x@y.test" }), ["Quarterly", "roadmap", "review"], "subject words score 3");
eq(suggestWords({ subject: "Hi", text: "ok", senderName: "", senderEmail: "x@y.test" }), [], "nothing qualifies");
// at most 5, best first, ties by first position
const many = suggestWords({ subject: "alpha bravo charlie delta echo foxtrot golf", text: "", senderName: "", senderEmail: "x@y.test" });
eq(many, ["alpha", "bravo", "charlie", "delta", "echo"]);
const ranked = suggestWords({ subject: "beta", text: "alpha alpha alpha gamma gamma", senderName: "", senderEmail: "x@y.test" });
eq(ranked, ["beta", "alpha", "gamma"], "score 3+0 = 3 (beta), 3 (alpha, written later), 2 (gamma): ties by first position");
// the sender's own words are left out (name, address, domain)
eq(suggestWords({ subject: "Acme Deals weekly", text: "", senderName: "Acme Deals", senderEmail: "x@y.test" }).includes("Acme"), false, "sender name");
// shown as first written
eq(suggestWords({ subject: "Invoice", text: "invoice INVOICE", senderName: "", senderEmail: "x@y.test" })[0], "Invoice");
// words with digits and short words never appear
assert.ok(!suggestWords({ subject: "Q3 b2b ab", text: "q3 q3 q3 b2b b2b ab ab ab", senderName: "", senderEmail: "x@y.test" }).length);
// other languages: Cyrillic, Vietnamese, German, Chinese, Japanese (where the engine has Intl.Segmenter, as Node does)
assert.ok(suggestWords({ subject: "Счёт за услуги", text: "Счёт на оплату услуги. Услуги оказаны. Оплата услуги.", senderName: "", senderEmail: "x@y.test" }).some((w) => w.toLowerCase() === "услуги"), "Cyrillic");
assert.ok(suggestWords({ subject: "Hóa đơn tháng", text: "Gửi bạn hóa đơn. Hóa đơn điện tử đính kèm.", senderName: "", senderEmail: "x@y.test" }).some((w) => w.toLowerCase() === "hóa"), "Vietnamese");
assert.ok(suggestWords({ subject: "Rechnung Oktober", text: "Die Rechnung für Oktober ist da. Rechnung bezahlen.", senderName: "", senderEmail: "x@y.test" }).includes("Rechnung"), "German");
if (typeof Intl.Segmenter === "function") {
  const zh = suggestWords({ subject: "会议纪要", text: "本周会议纪要已发送。请查看会议纪要。", senderName: "", senderEmail: "x@y.test" });
  assert.ok(zh.some((w) => [...w].length >= 2), `Chinese words of 2 or more characters: ${zh}`);
  const ja = suggestWords({ subject: "請求書のお知らせ", text: "請求書をお送りします。請求書をご確認ください。", senderName: "", senderEmail: "x@y.test" });
  assert.ok(ja.length > 0 && ja.every((w) => [...w].length >= 2), `Japanese: ${ja}`);
  checks += 2;
}
// stop words: the common words of the 8 languages never appear
for (const w of ["the", "and", "unsubscribe", "browser", "regards", "bonjour", "gracias", "bitte", "спасибо", "здравствуйте", "cảm", "こちら", "您好"]) {
  assert.ok(STOP_WORDS.has(w.normalize("NFKC").toLowerCase()), `stop word: ${w}`);
  checks++;
}
for (const w of ["invoice", "acme", "payment"]) assert.ok(!STOP_WORDS.has(w), `not a stop word: ${w}`);

// 5. the source of a message
const mine = new Set(["me@x.test"]);
const msg = (over) => ({ accountId: "a1", folder: "inbox", subject: "S", fromName: "N", fromEmail: "deals@shop.example", text: "hello world", html: null, ...over });
eq(ruleSourceOf(msg({}), mine).mine, false);
eq(ruleSourceOf(msg({ fromEmail: " ME@x.test " }), mine).mine, true, "my own mailbox, any case");
eq(ruleSourceOf(msg({ confidential: true }), mine).text, null, "confidential: no text");
eq(ruleSourceOf(msg({ security: { encrypted: true, decryption: "locked" } }), mine).text, null, "encrypted and locked: no text");
eq(ruleSourceOf(msg({ security: { encrypted: true, decryption: "ok" } }), mine).text, "hello world", "decrypted: the text");
eq(ruleSourceOf(msg({ text: "x".repeat(5000) }), mine).text.length, 2000, "2,000 characters");
eq(ruleSourceOf(msg({ text: null, html: "<style>p{}</style><p>Hello&nbsp;<b>there</b></p>" }), mine).text.trim(), "Hello there", "HTML-only mail: its text");
const a = msg({ fromEmail: "bob@x.test" });
const b = msg({ fromEmail: "me@x.test" });
eq(pickRuleMessage([a, b], mine), a, "the newest from someone else");
eq(pickRuleMessage([b, b], mine), b, "all mine: the newest");
eq(pickRuleMessage([], mine), null);
const s = ruleSourceOf(msg({}), mine);
eq(parseRuleSource(JSON.parse(JSON.stringify(s))), s, "round trip between windows");
eq(parseRuleSource({ ...s, accountId: "" }), null);
eq(parseRuleSource({ ...s, subject: 5 }), null);
eq(parseRuleSource(null), null);
eq(parseRuleSource({ ...s, text: "y".repeat(9000) }).text.length, 2000);

console.log(`test-rule-suggest: ok (${checks} checks)`);

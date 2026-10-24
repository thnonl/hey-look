// Search in Settings (1.0.7 W8.12): the registry, the folding of text, the ranking (src/settingsIndex.ts), and the guard that keeps the registry and
// src/components/SettingsDialog.tsx in step. No browser: scripts/test-settings-search.mjs checks the rendered pages and the box.
//   1. fold: Vietnamese tones and đ, fr / es / de accents, ß, Russian ё and й, full-width Latin, half-width kana, katakana to hiragana, the dakuten kept, punctuation, the map back to the text
//   2. the ranking of D-12.5 with a small fixture index: each tier, ties by order, the 3-character rule, the CJK one-character substring
//   3. for the 8 languages x {Windows+tray, macOS+tray, Linux+tray, Linux without a tray} x {no mailbox, 2 mailboxes}: no empty label, no raw key, no "{", every entry is the
//      first result for its own label (or in the top group of the same label), the gates of REQ-8.12.5, the keywords split into terms; the words of AC-8.12.11 to AC-8.12.14
//   4. the source guard (REQ-8.12.15): every Row / OvRow / raw .set-row has a registered id or a reason to be skipped, every registered id is in the source,
//      the registered label is the one the Row shows, the targets that are not a Row are there
//   5. the speed (REQ-8.12.4): a search takes less than 5 ms (95th percentile of 500 queries)
// Run: node --experimental-strip-types scripts/test-settings-index.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { en } from "../src/i18n/en.ts";
import { LANGUAGES, loadLanguage, setLangPref, t } from "../src/i18n/index.ts";
import { buildIndex, fold, foldMap, listSep, optionName, searchSettings } from "../src/settingsIndex.ts";

const read = (f) => readFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
let checks = 0;
const ok = (cond, msg) => (checks++, assert.ok(cond, msg));
const eq = (a, b, msg) => (checks++, assert.deepEqual(a, b, msg));

// ---------------------------------------------------------------------------------------------- 1. fold
{
  eq(fold("UNDO SÉND"), "undo send", "case and accents");
  eq(fold("  undo   send "), "undo send", "spaces collapse and trim");
  eq(fold("Đặt lại — mật khẩu"), "dat lai mat khau", "Vietnamese tones and đ");
  eq(fold("Chữ ký"), "chu ky");
  eq(fold("chữ ký"), fold("chu ky"), "with and without tones");
  eq(fold("Délai d’attente"), "delai d attente", "French accents and the apostrophe");
  eq(fold("Deshacer envío"), "deshacer envio");
  eq(fold("Textgröße"), "textgrosse", "German ö and ß: ö loses its dots, ß is ss");
  eq(fold("Straße"), "strasse");
  eq(fold("grosse"), "grosse");
  eq(fold("Größe"), "grosse", "ö -> o, ß -> ss");
  eq(fold("учётная запись"), "учетная запись", "Russian ё is е");
  eq(fold("Краткий"), "краткии", "Russian й is и");
  eq(fold("ＡＩ Assistant"), "ai assistant", "full-width Latin");
  eq(fold("ﾌﾞﾛｯｸ"), "ぶろっく", "half-width kana (with the dakuten) become normal kana, katakana become hiragana");
  eq(fold("ブロック"), fold("ぶろっく"), "katakana = hiragana");
  ok(fold("ガ") !== fold("カ"), "the dakuten stays: ガ is not カ");
  eq(fold("ガ"), "が");
  eq(fold("が"), "が", "a base kana and a separate dakuten are one letter");
  eq(fold("ダークモード"), "だーくもーど", "the prolonged sound mark stays");
  eq(fold("送信取り消し"), "送信取り消し", "Han and kana are letters");
  eq(fold("撤销发送"), "撤销发送");
  eq(fold("Reply-to address (optional)!"), "reply to address optional", "punctuation is a space");
  eq(fold("+ Add account"), "add account");
  eq(fold("Œuvre æ ø ł ı"), "oeuvre ae o l i", "a few letters that have no accent to remove");
  eq(fold(""), "");
  eq(fold("  ...  "), "", "only punctuation is an empty query");
  eq(fold("İstanbul"), "istanbul", "a capital I with a dot does not leave a mark behind");
  // the map back to the original text (the bold part of a result)
  {
    const f = foldMap("Délai d’attente");
    const at = f.s.indexOf("delai");
    eq([f.from[at], f.to[at + 4]], [0, 5], "the bold range of Délai for delai");
    const g = foldMap("Chữ ký số");
    eq([g.from[g.s.indexOf("ky")], g.to[g.s.indexOf("ky") + 1]], [4, 6], "the range of ký in Chữ ký");
    const h = foldMap("Straße x");
    eq([h.from[h.s.indexOf("ss")], h.to[h.s.indexOf("ss") + 1]], [4, 5], "ß stands for the two letters ss");
    const n = foldMap("école"); // (the accent as a separate mark)
    eq(n.s, "ecole");
    eq([n.from[0], n.to[0]], [0, 2], "a letter and its mark are one piece of the original");
  }
}

// ---------------------------------------------------------------------------------------------- 2. ranking on a fixture
{
  const mk = (label, o = {}) => ({
    id: label, tab: "x", kind: "row", label, hint: o.hint ?? "", kw: o.kw ?? [], places: o.places ?? [], shown: o.places ?? [], line: (o.places ?? []).join(" → "),
    fl: foldMap(label), fh: fold(o.hint ?? ""), fk: fold((o.kw ?? []).join(" ")), fp: fold((o.places ?? []).join(" ")),
  });
  const idx = [
    mk("Mail sound"), // 0 : a word of the label starts with "sound"? no: "mail sound" -> word start, tier 3
    mk("Sound"), // 1 : equals
    mk("Sound when a message is sent"), // 2 : starts with
    mk("Notification volume", { hint: "Plays a short sound" }), // 3 : hint
    mk("Theme", { kw: ["dark mode", "night mode"] }), // 4 : keyword
    mk("Undo send", { places: ["All accounts", "Composing"] }), // 5
    mk("Reply-to address", { places: ["Profile"] }), // 6
    mk("Sending mail", { places: ["Composing"] }), // 7
    mk("Mailbox colour"), // 8 : "mai" inside "mail" at the start of the word
    mk("Fetch new mail every"), // 9
    mk("AI Assistant"), // 10
    mk("Download folder", { places: ["General"] }), // 11
    mk("ブロックした送信者"), // 12
    mk("送信取り消し"), // 13
    mk("Another mail"), // 14
  ];
  const run = (q) => searchSettings(idx, q).map((h) => [idx.indexOf(h.entry), h.tier]);
  eq(run("sound"), [[1, 1], [2, 2], [0, 3], [3, 6]], "tiers 1, 2, 3 and 6 for sound, in this order");
  eq(run("SOUND")[0], [1, 1], "case does not matter");
  eq(run("dark mode"), [[4, 5]], "a keyword is tier 5");
  eq(run("night"), [[4, 5]]);
  eq(run("composing"), [[7, 7], [5, 7]].sort((a, b) => a[0] - b[0]), "a place name is tier 7, the order of the registry within a tier");
  eq(run("ai"), [[10, 2]], "ai: only the word start (mail has ai inside, 2 letters)");
  eq(run("mai").map((r) => r[0]), [0, 8, 7, 9, 14], "mai: the labels that start with it first (tier 2), then the word-start matches (tier 3)");
  eq(run("ail").map((r) => r[0]), [0, 7, 8, 9, 14], "ail: three letters are looked for inside words (mail, mailbox)");
  ok(searchSettings(idx, "il").length === 0, "il: two letters inside a word (mail) are no match");
  eq(run("ndo sen"), [[5, 4]], "a part of two words (3+ characters): tier 4");
  eq(run("undo   SÉND"), [[5, 1]], "spaces, case and accents");
  eq(run("send undo"), [[5, 4]], "all words, any order: tier 4");
  eq(run("undo zzz"), [], "all words must match");
  eq(run("reply to"), [[6, 2]], "the label starts with the query (the hyphen is a space)");
  eq(run("送信").map((r) => r[0]), [13, 12], "a CJK query of 2 characters: the label that starts with it first, then the substring match");
  eq(run("信").map((r) => r[0]), [12, 13], "a CJK query of 1 character too");
  eq(run("ぶろっく").map((r) => r[0]), [12], "hiragana finds katakana");
  eq(run("ＡＩ"), [[10, 2]], "full-width letters");
  eq(run(""), [], "an empty query");
  eq(run("  - ! "), [], "only punctuation is an empty query");
  eq(run("accounts").map((r) => r[0]), [5], "the place of Undo send");
  // the order inside a tier is the order of the registry, and a limit is kept
  const many = Array.from({ length: 80 }, (_, i) => mk(`Item ${i}`));
  eq(searchSettings(many, "item").length, 50, "at most 50 results");
  eq(searchSettings(many, "item", 3).map((h) => h.entry.label), ["Item 0", "Item 1", "Item 2"]);
  // the bold part of the label
  {
    const h = searchSettings([mk("Délai d’attente")], "delai")[0];
    eq(h.ranges, [[0, 5]], "Délai is the bold part");
    const g = searchSettings([mk("Reply-to address")], "address reply")[0];
    eq(g.ranges.map(([a, b]) => "Reply-to address".slice(a, b)), ["Reply", "address"], "each word of the query");
  }
}

// ---------------------------------------------------------------------------------------------- 3. the real index
const kbd = (os) => (l) => (os === "macos" ? l.replace(/\bCtrl\+/g, "Cmd+") : l);
const MBX = [
  { id: "a1", email: "ann@example.com", cal: null },
  { id: "a2", email: "bob@gmail.com", cal: { kind: "google" } },
];
const DAV = [{ id: "a1", email: "ann@example.com", cal: { kind: "dav", label: null } }, { id: "a2", email: "bob@gmail.com", cal: { kind: "google" } }];
const CTXS = [
  ["windows+tray", { os: "windows", tray: true, notifyButtons: true }],
  ["macos+tray", { os: "macos", tray: true, notifyButtons: false }],
  ["linux+tray", { os: "linux", tray: true, notifyButtons: true }],
  ["linux no tray", { os: "linux", tray: false, notifyButtons: false }],
];
const build = (c, accounts = MBX, managed = false) => buildIndex({ ...c, managed, accounts, kbd: kbd(c.os) });

for (const lang of LANGUAGES.map((l) => l.code)) {
  await loadLanguage(lang);
  setLangPref(lang);
  for (const [name, c] of CTXS) {
    for (const [mbx, accounts] of [["no mailbox", []], ["2 mailboxes", MBX], ["dav", DAV]]) {
      const tag = `${lang} ${name} ${mbx}`;
      const idx = build(c, accounts);
      ok(idx.length > 60, `${tag}: the index has entries (${idx.length})`);
      const keys = new Set();
      for (const e of idx) {
        ok(e.label.trim() !== "", `${tag}: ${e.id} has a label`);
        for (const s of [e.label, e.hint, e.line, ...e.kw, ...e.places]) {
          ok(!/^[a-z]+\.[a-zA-Z.]+$/.test(s) && !s.includes("{"), `${tag}: ${e.id} has a raw key or a placeholder: ${s}`);
        }
        ok(e.kw.every((k) => k.trim() !== ""), `${tag}: ${e.id}: empty keyword term`);
        const k = `${e.tab}|${e.section ?? ""}|${e.id}`;
        ok(!keys.has(k), `${tag}: ${k} twice`);
        keys.add(k);
        // every entry is the first result for its own label (or in the top group of entries that have the same label)
        const hits = searchSettings(idx, e.label, 200);
        const top = hits.filter((h) => h.tier === 1);
        ok(top.some((h) => h.entry === e), `${tag}: "${e.label}" (${e.id}) is not in the top group for its own label (${hits.slice(0, 3).map((h) => h.entry.label)})`);
        ok(hits[0].tier === 1 && fold(hits[0].entry.label) === fold(e.label), `${tag}: the first result for "${e.label}" is "${hits[0].entry.label}"`);
        ok(optionName(e).includes(e.label), `${tag}: the name of the option has the label`);
      }
      // the gates of REQ-8.12.5
      const ids = new Set(idx.map((e) => e.id));
      eq(ids.has("notifyButtons"), c.notifyButtons, `${tag}: notification buttons`);
      eq(ids.has("trayBadge"), c.tray, `${tag}: tray badge only with a tray`);
      eq(ids.has("taskbarBadge"), c.os !== "linux", `${tag}: the Taskbar / Dock badge is not on Linux`);
      eq(idx.find((e) => e.id === "taskbarBadge")?.label, c.os === "macos" ? t("settings.tray.dockBadge") : c.os === "windows" ? t("settings.tray.taskbarBadge") : undefined, `${tag}: Dock badge on a Mac, Taskbar badge on Windows`);
      eq(idx.find((e) => e.id === "autostart").label, c.os === "windows" ? t("settings.tray.autostartWindows") : t("settings.tray.autostart"), `${tag}: the autostart words`);
      eq(idx.find((e) => e.id === "pg-tray").label, c.tray ? t("settings.tray.title") : t("settings.tray.titleNoTray"), `${tag}: the page without a tray`);
      eq(idx.find((e) => e.id === "keepRunning").hint, !c.tray ? t("settings.tray.noTray") : c.os === "macos" ? t("settings.tray.keepRunningMac") : t("settings.tray.keepRunningHint"), `${tag}: the keep-running hint`);
      eq(idx.filter((e) => e.id === "replyTo").length, accounts.length, `${tag}: one Reply-to row per mailbox`);
      eq(idx.filter((e) => e.id === "calendar").length, accounts.filter((a) => a.cal).length, `${tag}: a Calendar row for the mailboxes that have one`);
      eq(idx.filter((e) => e.id === "pg-mb").length, accounts.length + 1, `${tag}: All accounts and each mailbox`);
      eq(idx.filter((e) => e.id === "undoSend").length, 1, `${tag}: a setting that a mailbox can override is one result`);
      ok(!idx.some((e) => e.id === "myKey" && e.tab === "mb:all"), `${tag}: My key is for a mailbox`);
    }
  }
  // updates: a copy that a store updates has no button and no switch
  const managed = build(CTXS[0][1], MBX, true);
  ok(!managed.some((e) => e.id === "updateCheck" || e.id === "autoCheck"), `${lang}: a managed copy has no update row`);
  ok(managed.some((e) => e.id === "pg-about"), `${lang}: but the About page`);
}

// the words people type (AC-8.12.4, .11, .13, .14), each in its own language
{
  const win = CTXS[0][1];
  const mac = CTXS[1][1];
  const notray = CTXS[3][1];
  const first = (idx, q, id, n = 3) => {
    const hits = searchSettings(idx, q);
    const i = hits.findIndex((h) => h.entry.id === id);
    ok(i >= 0 && i < n, `"${q}" finds ${id} among the first ${n} (found at ${i}; first: ${hits.slice(0, 3).map((h) => h.entry.label)})`);
  };
  const none = (idx, q) => eq(searchSettings(idx, q).map((h) => h.entry.label), [], `"${q}" finds nothing`);
  await loadLanguage("en");
  setLangPref("en");
  {
    const idx = build(win);
    first(idx, "undo send", "undoSend", 1);
    first(idx, "UNDO SÉND", "undoSend", 1);
    first(idx, "undo  send", "undoSend", 1);
    first(idx, "ndo sen", "undoSend", 1);
    first(idx, "dark mode", "theme", 1);
    first(idx, "startup", "autostart", 1);
    first(idx, "gpg", "pg-pgp", 1);
    first(idx, "model", "aiModel", 3);
    first(idx, "ＡＩ", "pg-ai", 1);
    first(idx, "notification buttons", "notifyButtons", 1);
    first(idx, "taskbar badge", "taskbarBadge", 1);
    first(idx, "start hey look! when i sign in to windows", "autostart", 1);
    none(idx, "dock");
    none(idx, "qqqzz");
    none(idx, "client secret");
    ok(searchSettings(idx, "signature").some((h) => h.entry.id === "sec" && h.entry.section === "signatures"), "the Signatures section is found by signature");
    ok(!searchSettings(idx, "holiday").length, "a signature named Holiday is not in the index (user content)");
    ok(searchSettings(idx, "password").every((h) => h.entry.tab !== "add-account" || h.entry.kind === "page"), "nothing inside the add-account forms");
    // AC-8.12.5: sound
    const sound = searchSettings(idx, "sound").map((h) => [h.entry.id, h.tier]);
    eq(sound.slice(0, 2).map((x) => x[0]), ["notifySound", "sentSound"], "sound: Sound, then Sound when a message is sent");
    ok(sound.slice(2).every((x) => x[1] >= 3), "and then the rows that have sound in their hint");
    // AC-8.12.5: reading
    const reading = searchSettings(idx, "reading").map((h) => h.entry.id);
    eq(reading.slice(0, 2), ["readingPane", "sec"], "reading: Reading pane, then the Reading & sync section");
    for (const id of ["loadRemote", "inlineAuto", "fetchEvery", "push", "maxDownload"]) ok(reading.includes(id), `reading: ${id} follows`);
    // AC-8.12.6: short queries
    eq(searchSettings(idx, "ai")[0].entry.id, "pg-ai", "ai: AI Assistant first");
    ok(searchSettings(idx, "ai").every((h) => h.entry.tab === "ai" || /\bai\b/.test(h.entry.fl.s + " " + h.entry.fh + " " + h.entry.fk + " " + h.entry.fp)), "ai: nothing is listed only because its label contains mail");
    const mai = searchSettings(idx, "mai");
    ok(mai.length > 0 && mai.every((h) => h.tier >= 3), "mai: a word-start match is not tier 1 or 2");
    // AC-8.12.9: per mailbox
    const reply = searchSettings(idx, "reply-to");
    eq(reply.filter((h) => h.entry.id === "replyTo").map((h) => h.entry.line), ["ann@example.com → Profile", "bob@gmail.com → Profile"], "reply-to: one result per mailbox with its address");
    ok(searchSettings(idx, "gmail").some((h) => h.entry.id === "pg-mb" && h.entry.tab === "mb:a2"), "the mailbox itself is a result");
    ok(searchSettings(idx, "example").some((h) => h.entry.id === "incoming" && h.entry.tab === "mb:a1"), "its Incoming server row is listed (the address is a place name)");
    eq(searchSettings(idx, "undo send")[0].entry.line, "All accounts → Composing", "the place of Undo send");
    eq(searchSettings(idx, "weekday").length, 0);
    eq(searchSettings(idx, "attachments").find((h) => h.entry.id === "saveTo")?.entry.line, "General → Attachments", "a group heading is part of the place");
    // the Shortcuts page is also found by the title of the table
    first(idx, "keyboard shortcuts", "pg-shortcuts", 1);
  }
  {
    const idx = build(mac);
    first(idx, "dock", "taskbarBadge", 1);
    ok(searchSettings(idx, "dock")[0].entry.label === t("settings.tray.dockBadge"), "dock finds Dock badge");
    none(idx, "taskbar badge");
    ok(!searchSettings(idx, "notification buttons").some((h) => h.entry.id === "notifyButtons"), "no Notification buttons on macOS");
    eq(searchSettings(idx, "keep running")[0].entry.hint, t("settings.tray.keepRunningMac"), "the Mac keep-running hint");
  }
  {
    const idx = build(notray);
    none(idx, "tray icon badge");
    none(idx, "taskbar");
    none(idx, "dock");
    eq(searchSettings(idx, "keep running")[0].entry.hint, t("settings.tray.noTray"), "No tray area was found");
    ok(searchSettings(idx, "notifications startup").some((h) => h.entry.id === "pg-tray"), "the page is Notifications & startup");
  }
  // the other languages
  const lang = async (code, f) => {
    await loadLanguage(code);
    setLangPref(code);
    f(build(win));
  };
  await lang("vi", (idx) => {
    first(idx, "chu ky", "signature", 3);
    first(idx, "chữ ký", "signature", 3);
    first(idx, "chữ ký", "sec", 6);
  });
  await lang("fr", (idx) => {
    const h = searchSettings(idx, "delai");
    ok(h.length > 0 && h.every((x) => fold(x.entry.label + " " + x.entry.hint + " " + x.entry.kw.join(" ") + " " + x.entry.places.join(" ")).includes("delai")), "fr: delai finds the labels with délai");
    ok(fold(h[0].entry.label).includes("delai"), "fr: the first one has it in its label");
  });
  await lang("de", (idx) => {
    first(idx, "grosse", "textSize", 3);
    first(idx, "Schriftgröße", "textSize", 3);
  });
  await lang("es", (idx) => {
    first(idx, "envio", "undoSend", 3);
    ok(fold(searchSettings(idx, "envio").find((h) => h.entry.id === "undoSend").entry.label).includes("envio"), "es: Deshacer envío");
  });
  await lang("ru", (idx) => {
    const h = searchSettings(idx, "учетн");
    ok(h.length > 0 && h.some((x) => /учётн/.test(x.entry.label)), "ru: учетн finds the rows with учётн");
    first(idx, "автозапуск", "autostart", 1);
  });
  await lang("ja", (idx) => {
    first(idx, "ぶろっく", "pg-blocked", 1);
    first(idx, "送信", "undoSend", 4);
    first(idx, "ダークモード", "theme", 1);
    ok(searchSettings(idx, "送信")[0].entry.label.includes("送信"), "ja: the first one has 送信 in its label");
  });
  await lang("zh-Hans", (idx) => {
    first(idx, "撤销", "undoSend", 3);
    ok(fold(searchSettings(idx, "撤销")[0].entry.label).includes("撤销"), "zh: 撤销");
  });
  // full-width letters are the same as plain ones in every language. AC-8.12.14 also says that ＡＩ finds the AI Assistant "in every language": where the agreed texts have the letters AI
  // (en, vi, zh-Hans, ja, es: label or keyword; fr: its intro) it is found; German writes KI-Assistent and Russian ИИ-помощник and neither has an AI keyword (listed in the report)
  for (const code of LANGUAGES.map((l) => l.code)) {
    await lang(code, (idx) => {
      eq(searchSettings(idx, "ＡＩ").map((h) => h.entry.id), searchSettings(idx, "AI").map((h) => h.entry.id), `${code}: ＡＩ is AI`);
      eq(searchSettings(idx, "ＡＩ").some((h) => h.entry.id === "pg-ai"), !["de", "ru"].includes(code), `${code}: ＡＩ finds the AI Assistant page where its texts have the letters`);
    });
  }
  // listSep: the list of place names for a screen reader
  await lang("ja", () => eq(listSep(), "、", "ja list separator"));
  await lang("zh-Hans", () => eq(listSep(), "、", "zh-Hans list separator"));
  await lang("de", () => eq(listSep(), ", ", "de list separator"));
  await lang("en", (idx) => eq(optionName(idx.find((e) => e.id === "undoSend")), "Undo send, All accounts, Composing", "the name of an option for a screen reader"));
  await lang("zh-Hans", (idx) => ok(optionName(idx.find((e) => e.id === "undoSend")).includes("，"), "zh-Hans: the full-width comma between the setting and its place"));
}

// ---------------------------------------------------------------------------------------------- 4. the source guard (REQ-8.12.15)
{
  await loadLanguage("en");
  setLangPref("en");
  const dialog = read("src/components/SettingsDialog.tsx");
  const updates = read("src/components/Updates.tsx");
  /** The text of the opening tag that starts at `i` (to its `>` outside the braces and strings). */
  const tagAt = (src, i) => {
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      const ch = src[j];
      if (ch === '"' || ch === "'" || ch === "`") {
        for (j++; j < src.length && src[j] !== ch; j++) if (src[j] === "\\") j++;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0 && src[j - 1] !== "=") return src.slice(i, j + 1);
    }
    throw new Error("no end of tag at " + i);
  };
  const lineOf = (src, i) => src.slice(0, i).split("\n").length;
  const rows = [];
  for (const m of dialog.matchAll(/<(Row|OvRow)\b/g)) rows.push({ i: m.index, name: m[1], tag: tagAt(dialog, m.index), line: lineOf(dialog, m.index) });
  ok(rows.length >= 70, `found the Rows (${rows.length})`);
  const skipComment = (r) => /settings-search: skip – \S/.test(r.tag) || /settings-search: skip – \S/.test(dialog.slice(Math.max(0, r.i - 300), r.i).split("\n").slice(-3).join("\n"));
  const dynamic = [/^act-/, /^snooze-/];
  const sourceIds = new Set();
  for (const r of rows) {
    const id = /\bid="([^"]+)"/.exec(r.tag)?.[1];
    const idExpr = /\bid=\{([^}]+)\}/.exec(r.tag)?.[1];
    if (id) sourceIds.add(id);
    if (/\bnoSearch\b/.test(r.tag)) {
      ok(skipComment(r), `SettingsDialog.tsx:${r.line}: a Row with noSearch needs a "// settings-search: skip – <reason>" comment`);
    } else {
      ok(id || idExpr, `SettingsDialog.tsx:${r.line}: <${r.name}> has no id (give it the id of its registry entry, or noSearch with a reason)\n${r.tag.slice(0, 160)}`);
    }
  }
  // the raw .set-row divs: the Row component's own, and the ones that are skipped with a reason
  for (const m of dialog.matchAll(/className="set-row"[^>]*>/g)) {
    const line = lineOf(dialog, m.index);
    if (/\bid=\{id \?/.test(m[0])) continue; // (Row itself)
    ok(/data-search-skip/.test(m[0]), `SettingsDialog.tsx:${line}: a raw .set-row needs data-search-skip`);
    ok(/settings-search: skip – \S/.test(dialog.slice(Math.max(0, m.index - 300), m.index)), `SettingsDialog.tsx:${line}: a raw .set-row needs a "// settings-search: skip – <reason>" comment`);
  }
  // every registered id is in the source
  const wide = [];
  for (const [, c] of CTXS) for (const accounts of [MBX, DAV]) wide.push(...build(c, accounts));
  const en_ = new Map();
  for (const e of wide) en_.set(`${e.id}`, e);
  for (const e of en_.values()) {
    if (e.id.startsWith("pg-")) {
      ok(dialog.includes(`id="set-${e.id}"`), `the page heading id="set-${e.id}" is in SettingsDialog.tsx`);
    } else if (e.id === "sec") {
      ok(dialog.includes('id="set-sec"'), "the section region id=\"set-sec\"");
    } else if (dynamic.some((re) => re.test(e.id))) {
      const prefix = e.id.split("-")[0];
      ok(dialog.includes(`id={\`${prefix}-\${`), `the template id of ${e.id}`);
    } else if (e.kind === "row") {
      ok(sourceIds.has(e.id), `${e.id}: no <Row id="${e.id}"> in SettingsDialog.tsx`);
    } else {
      const src = e.id === "updateCheck" ? updates : dialog;
      ok(src.includes(`id="set-${e.id}"`) || (e.id.startsWith("ai") && src.includes(`id="set-${e.id}"`)), `${e.id}: no id="set-${e.id}" target`);
    }
  }
  // every id in the source is registered (or skipped)
  const registered = new Set([...en_.keys()]);
  for (const id of sourceIds) {
    if (id === "id") continue;
    ok(registered.has(id) || /^[a-z]+Err$/.test(id), `the Row id "${id}" of SettingsDialog.tsx is not in the registry`);
  }
  // the registered label is the one the Row shows (the English text of a key the Row uses; a computed label is left to the browser test)
  for (const r of rows) {
    const id = /\bid="([^"]+)"/.exec(r.tag)?.[1];
    const e = id && en_.get(id);
    if (!e || e.kind !== "row" || id === "calendar") continue;
    const labelPart = /\blabel=(\{[\s\S]*?\}|"[^"]*")/.exec(r.tag)?.[1] ?? "";
    const keys = [...labelPart.matchAll(/"([a-z]+(?:\.[A-Za-z]+)+)"/g)].map((m) => m[1]);
    if (!keys.length) continue;
    // (English is the language in use here; the label of a Row that is made from a computed key is checked in the browser test)
    const seen = [...wide.filter((x) => x.id === id)].map((x) => x.label);
    ok(seen.every((l) => keys.some((k) => t(k) === l)), `${id}: the registry label "${seen[0]}" is not one of ${keys.join(" / ")}`);
    ok(keys.every((k) => en[k] !== undefined), `${id}: the label keys exist`);
  }
  // the Shortcuts row of REQ-8.12.13
  ok(/\["Ctrl\+F", "settings\.search\.label"\]/.test(dialog), "the Shortcuts page lists Ctrl+F — Search settings");
}

// ---------------------------------------------------------------------------------------------- 5. speed
{
  await loadLanguage("ru");
  setLangPref("ru");
  const idx = build(CTXS[0][1], MBX);
  const words = ["и", "уведомл", "почта", "ai", "chat", "настройки", "ключ", "отмена", "Нас", "подпись", "по", "send", "фон"];
  const times = [];
  for (let i = 0; i < 500; i++) {
    const q = words[i % words.length] + (i % 3 === 0 ? " " + words[(i * 7) % words.length] : "");
    const t0 = performance.now();
    searchSettings(idx, q);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  // (a CI machine: 5 ms; the work is the same on every machine, so a slow one is shown by the number)
  ok(p95 < 5, `a search takes ${p95.toFixed(2)} ms (95th percentile of 500), the limit is 5 ms`);
  console.log(`speed: p95 ${p95.toFixed(2)} ms over ${times.length} searches, ${idx.length} entries`);
}
console.log(`test-settings-index: ok (${checks} checks)`);

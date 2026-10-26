#!/usr/bin/env node
// The 8 Microsoft Store screenshots (S1..S8 of the listing md, "## Screenshot scenes") in each of the 8 languages: 64 PNG of 1920x1080.
//   node scripts/store-screenshots.mjs --md <md folder> --out <screens folder> [--lang ja,de] [--only S1,S4] [--debug-dir <folder>]
// How: the dev preview of this checkout (vite dev + the mock backend src/devMock.ts, the same React UI the app shows in WebView2) in a headless Chrome / Edge
// through the Chrome DevTools Protocol, like the UI tests (scripts/cdp-harness.mjs). Not a Tauri build: the window frame is the app's own (?frame=win draws the
// Windows caption buttons), there is no debug banner, and the page has no network (hermetic). `window.__hlShots` (src/devMockShots.ts) replaces the mock mailbox
// by the sample mail of "## Sample mail for screenshots" of the md of that language; the AI stub answers one fixed text (never a call out). The clock is fixed
// (Wednesday 2026-11-04 17:00, HEYLOOK_FAKE_NOW) so the dates read the same in every language and on every run. The UI language is the listing language.
// Output: <out>/<locale column>/S1.png ... S8.png (en-us, vi, fr, zh-hans, es, ja, de, ru: the language columns of the Partner Center export), which
// scripts/store-listing-csv.mjs reads. Needs Node 22.6+ with --experimental-strip-types (24: nothing), and a Chrome / Chromium / Edge (CHROME_PATH).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, languageJs, sleep, arg } from "./cdp-harness.mjs";
import { LOCALES, splitSections } from "./store-listing-csv.mjs";
import { loadDicts } from "./lib/i18n-dicts.mjs";

const W = 1920, H = 1080;
// The clock of the page: Wednesday 2026-11-04, 17:00 local time of the language's own time zone (Thursday is "tomorrow", Saturday and "the 14th" are ahead), so every
// date reads the same on every run and the calendar header names a zone of the language, not the zone of this computer. [zone, UTC offset of that zone on 4 November, in minutes]
const ZONES = { en: ["America/New_York", -300], vi: ["Asia/Ho_Chi_Minh", 420], fr: ["Europe/Paris", 60], "zh-Hans": ["Asia/Shanghai", 480], es: ["Europe/Madrid", 60], ja: ["Asia/Tokyo", 540], de: ["Europe/Berlin", 60], ru: ["Europe/Moscow", 180] };

// What the md does not hold: the sample persona, the calendar events and the text typed in the editor, in each language (the owner's BA reviews them: they are
// part of the picture, not of the listing). The titles are plain words of everyday life; the sample mail itself comes from the md.
const ME = { name: "Nam", name2: "Nam Work", email: "nam@example.com", email2: "nam@example.org" };
const COPY = {
  en: { events: ["Team meeting", "Project review", "Dinner", "Dentist", "Lunch"], thanks: "Thanks for letting me know. I will be there on Thursday at 10:00.", agenda: "Agenda", rows: ["Project plan", "Spring newsletter", "Budget"], hello: "Hello! Here is the agenda for Thursday." },
  vi: { events: ["Họp nhóm", "Xem lại dự án", "Bữa tối", "Khám răng", "Bữa trưa"], thanks: "Cảm ơn bạn đã báo. Mình sẽ có mặt vào thứ Năm lúc 10:00.", agenda: "Chương trình", rows: ["Kế hoạch dự án", "Bản tin mùa xuân", "Ngân sách"], hello: "Xin chào! Đây là chương trình họp thứ Năm." },
  fr: { events: ["Réunion d’équipe", "Revue du projet", "Dîner", "Dentiste", "Déjeuner"], thanks: "Merci de me prévenir. Je serai là jeudi à 10 h 00.", agenda: "Ordre du jour", rows: ["Plan du projet", "Lettre d’information du printemps", "Budget"], hello: "Bonjour ! Voici l’ordre du jour de jeudi." },
  "zh-Hans": { events: ["团队会议", "项目评审", "晚餐", "看牙医", "午餐"], thanks: "谢谢您告知。我周四上午10:00准时到。", agenda: "议程", rows: ["项目计划", "春季简报", "预算"], hello: "您好！这是周四会议的议程。" },
  es: { events: ["Reunión del equipo", "Revisión del proyecto", "Cena", "Dentista", "Almuerzo"], thanks: "Gracias por avisarme. Estaré allí el jueves a las 10:00.", agenda: "Orden del día", rows: ["Plan del proyecto", "Boletín de primavera", "Presupuesto"], hello: "¡Hola! Aquí está el orden del día del jueves." },
  ja: { events: ["チーム会議", "プロジェクトの確認", "夕食", "歯医者", "ランチ"], thanks: "ご連絡ありがとうございます。木曜日の10:00に伺います。", agenda: "議題", rows: ["企画書", "春のニュースレター", "予算"], hello: "こんにちは。木曜日の議題をお送りします。" },
  de: { events: ["Teambesprechung", "Projektbesprechung", "Abendessen", "Zahnarzt", "Mittagessen"], thanks: "Danke für die Info. Ich bin am Donnerstag um 10:00 Uhr dabei.", agenda: "Tagesordnung", rows: ["Projektplan", "Frühlings-Newsletter", "Budget"], hello: "Hallo! Hier ist die Tagesordnung für Donnerstag." },
  ru: { events: ["Встреча команды", "Обзор проекта", "Ужин", "Стоматолог", "Обед"], thanks: "Спасибо, что предупредили. Я буду в четверг в 10:00.", agenda: "Повестка", rows: ["План проекта", "Весенняя рассылка", "Бюджет"], hello: "Здравствуйте! Вот повестка на четверг." },
};
// [index of the title in COPY.events, day of the week (0 = Monday), start h, m, end h, m, invitation?] of the events of the week of "today" (Wednesday 4 November)
const EVENT_SLOTS = [[0, 0, 10, 0, 11, 0, true], [0, 3, 10, 0, 11, 0, true], [1, 1, 14, 0, 15, 0, false], [1, 4, 15, 0, 16, 0, false], [4, 0, 12, 30, 13, 30, false], [4, 2, 12, 30, 13, 30, false], [4, 4, 12, 30, 13, 30, false], [3, 2, 8, 30, 9, 30, false], [2, 5, 19, 0, 21, 0, false]];
// minutes before 17:00 of the 8 sample mail (all this afternoon, the parcel was left at 14:32), and which are unread / have attachments
const AGES = [12, 29, 48, 70, 94, 115, 131, 146];
const UNREAD = new Set([2, 3, 6]);
const ATTACH = { 3: ["lake-sunset.jpg", "lake-morning.jpg"], 4: ["invoice-2026-118.pdf"] };

/** The sample mail of an md: [{ n, fromName, fromEmail, subject, preview }]; an address missing in this language (ja, de) is the English table's. */
function sampleMail(md, enMd, isEn) {
  const rows = (text) => {
    const sec = splitSections(text)["Sample mail for screenshots"] ?? "";
    return sec.split("\n").map((l) => l.trim()).filter((l) => /^\|\s*\d+\s*\|/.test(l)).map((l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  };
  const en = rows(enMd);
  const list = rows(md).map(([n, sender, subject, preview]) => {
    const m = /^(.*?)\s*<([^>]+)>$/.exec(sender);
    const enSender = en.find((r) => r[0] === n)?.[1] ?? "";
    const enEmail = /<([^>]+)>/.exec(enSender)?.[1];
    // a language whose table has no address (ja, de): an address that fits the name, on the domain of the English table (example.com / .org / .net only)
    const name = m ? m[1] : sender;
    const slug = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
    const own = isEn || !enEmail ? enEmail : `${slug.length >= 3 ? slug : `contact${n}`}@${enEmail.split("@")[1]}`;
    return { n: Number(n), fromName: name, fromEmail: m ? m[2] : own, subject, preview };
  });
  if (list.length !== 8) throw new Error(`the sample mail table has ${list.length} rows, expected 8`);
  for (const m of list) if (!m.fromEmail || !m.subject || !m.preview) throw new Error(`sample mail ${m.n}: sender, subject or preview missing`);
  return list;
}

function shotsData(code, list) {
  const c = COPY[code];
  const mails = list.map((m) => ({ ...m, minutesAgo: AGES[m.n - 1], unread: UNREAD.has(m.n), attach: ATTACH[m.n] }));
  // the stub's one answer: the subject and the sentences of the first mail as bullets (so it is in the language of the listing without a translation of mine)
  const first = list[0];
  const sentences = first.preview.split(/(?<=[.!?。！？])\s*/).map((s) => s.trim()).filter(Boolean);
  const answer = ["• " + first.subject, ...sentences.map((s) => "• " + s)].join("\n");
  return { me: ME, mails, events: EVENT_SLOTS.map(([i, day, h, m, endH, endM, invite]) => ({ title: c.events[i], day, h, m, endH, endM, invite })), answer };
}

const mdDir = arg("md"), outDir = arg("out"), debugDir = arg("debug-dir");
const wantLang = arg("lang")?.split(",") ?? null, wantShots = arg("only")?.split(",") ?? null;
if (!mdDir || !outDir) { console.error("usage: node scripts/store-screenshots.mjs --md <md folder> --out <screens folder> [--lang ja,de] [--only S1,S4] [--debug-dir <folder>]"); process.exit(2); }

const dicts = await loadDicts();
const tr = (code, key) => {
  const v = dicts[code]?.[key] ?? dicts.en[key];
  if (typeof v !== "string") throw new Error(`no text ${key} in ${code}`);
  return v;
};

const h = await startHarness("store-screenshots", { vitePort0: 5490 });
const { cdp, evaluate } = h;
let shotsScript = null;

const click = async (x, y, count = 1, button = "left") => {
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let i = 1; i <= count; i++) {
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: button === "left" ? 1 : 2, clickCount: i });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: i });
  }
  await sleep(250);
};
const rect = (sel, nth = 0) => evaluate(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
const clickSel = async (sel, nth = 0) => { const r = await rect(sel, nth); if (!r) throw new Error(`nothing matches ${sel}`); await click(r.cx, r.cy); };
/** The first element (button, menu item, row) whose visible text equals / starts with `text`. */
const findText = (text, scope = "button, [role=menuitem], [role=tab], li, a, .menu-item") => evaluate(`(() => { const t = ${JSON.stringify(text)}; const es = [...document.querySelectorAll(${JSON.stringify(scope)})].filter((e) => { const s = (e.getAttribute('aria-label') || e.textContent || '').replace(/\\s+/g, ' ').trim(); return s === t || s.startsWith(t); }); const e = es.find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); if (!e) return null; const r = e.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
const clickText = async (text, scope) => { const r = await findText(text, scope); if (!r) throw new Error(`no control with the text "${text}"`); await click(r.cx, r.cy); };
const key = async (k, code, vk, modifiers = 0) => { await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers }); await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers }); await sleep(200); };
const typeText = async (text) => { for (const ch of [...text]) { await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch }); await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch }); await sleep(8); } await sleep(80); };
const pasteHtml = (html) => evaluate(`(() => { const ed = document.querySelector('.ProseMirror[contenteditable=true]'); ed.focus(); const dt = new DataTransfer(); dt.setData('text/html', ${JSON.stringify(html)}); dt.setData('text/plain', ${JSON.stringify(html.replace(/<[^>]+>/g, " "))}); ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
const setPrefs = (p) => evaluate(`(async () => { await window.__store.getState().setPrefs(${JSON.stringify(p)}); return true; })()`);

async function shoot(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await evaluate("document.fonts.ready.then(() => true)");
  await sleep(350);
  const r = await cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: W, height: H, scale: 1 }, fromSurface: true });
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
}

/** Loads the preview with the sample mail of one language and waits until the app shows its list. */
async function openApp(code, data, code0) {
  await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const [zone, offMin] = ZONES[code0];
  await cdp("Emulation.setTimezoneOverride", { timezoneId: zone });
  const skew = Date.UTC(2026, 10, 4, 17, 0, 0) - offMin * 60000 - Date.now(); // the page's clock runs on, from that moment
  const clock = `(() => { const Real = Date, off = ${skew}; function FakeDate(...a) { return a.length ? new Real(...a) : new Real(Real.now() + off); } FakeDate.prototype = Real.prototype; FakeDate.UTC = Real.UTC; FakeDate.parse = Real.parse; FakeDate.now = () => Real.now() + off; Object.defineProperty(Real.prototype, 'constructor', { value: FakeDate, writable: true, configurable: true }); window.Date = FakeDate; })();`;
  if (shotsScript) await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: shotsScript });
  shotsScript = (await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `${clock} window.__hlShots = ${JSON.stringify(data)};` })).identifier;
  for (let attempt = 0; attempt < 5; attempt++) {
    await cdp("Page.navigate", { url: "about:blank" });
    await cdp("Page.navigate", { url: `${h.base}?frame=win#smallmailbox&managed=msstore` });
    await sleep(700);
    try {
      await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { const s = window.__store && window.__store.getState(); if (s && s.accounts.length && s.threads.length) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 20000) { clearInterval(t); no(new Error('app did not start')); } }, 100); })`);
      break;
    } catch (e) { if (attempt === 4) throw e; }
  }
  await evaluate(languageJs(code));
  await sleep(500);
}

const dbg = async (name) => { if (!debugDir) return; fs.mkdirSync(debugDir, { recursive: true }); const r = await cdp("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(debugDir, name), Buffer.from(r.data, "base64")); };

/** The scenes. Each starts from the Inbox (the page is reloaded before every scene: no state is carried over). */
const waitFor = (expr, ms = 8000) => evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { let v = false; try { v = (${expr}); } catch { /* not yet */ } if (v) { clearInterval(t); ok(true); } else if (Date.now() - t0 > ${ms}) { clearInterval(t); no(new Error('timeout: ' + ${JSON.stringify(expr)})); } }, 80); })`);
const goInbox = () => evaluate("window.__store.getState().setView('inbox', 'a1').then(() => true)");
const away = () => cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1500, y: 700 });
const CTRL = 2, SHIFT = 8;
const openMail = async (n) => {
  await clickSel(`[data-thread="shot${n}"]`);
  await waitFor(`window.__store.getState().messages.length > 0 && window.__store.getState().selected`);
  await sleep(900);
};
/** A new message: To (a chip), Subject, and the body pasted as formatted text. */
async function newMail(ctx, { to, subject, html, picture = false }) {
  await clickSel("button.rb.primary[data-intent=editor]");
  await waitFor("document.querySelector('.compose-pane .ProseMirror')");
  await sleep(600);
  const inputs = "input:not([type=file]):not(.fmt-size-in)";
  await clickSel(`.compose-pane ${inputs}`, 0);
  await typeText(to);
  await key("Enter", "Enter", 13);
  await clickSel(`.compose-pane ${inputs}`, 1);
  await typeText(subject);
  await pasteHtml(html);
  await sleep(300);
  if (picture) await insertPicture();
  await sleep(300);
}
/** Puts a picture into the open message through the Picture button's file input (a real file, like a person's choice in the file dialog). */
async function insertPicture() {
  const b64 = await evaluate(`(async () => { const img = new Image(); img.src = ${JSON.stringify(LAKE_SMALL)}; await img.decode(); const c = document.createElement('canvas'); c.width = 400; c.height = 225; c.getContext('2d').drawImage(img, 0, 0, 400, 225); return c.toDataURL('image/png').split(',')[1]; })()`);
  const file = path.join(os.tmpdir(), "hl-shots-lake.png");
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
  const { result } = await cdp("Runtime.evaluate", { expression: "document.querySelector('.compose-pane input[type=file][accept^=image]')" });
  if (!result.objectId) throw new Error("no picture input in the message");
  await cdp("DOM.enable");
  await cdp("DOM.setFileInputFiles", { files: [file], objectId: result.objectId });
  await sleep(1200);
}
const LAKE_SMALL = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#2b3a67'/><stop offset='.6' stop-color='#e07a5f'/><stop offset='1' stop-color='#f2cc8f'/></linearGradient></defs><rect width='320' height='110' fill='url(#s)'/><circle cx='215' cy='88' r='17' fill='#fff3c4'/><rect y='110' width='320' height='70' fill='#3d5a80'/><path d='M0 110 L45 78 L85 106 L130 72 L180 110 Z' fill='#1d2a44'/></svg>");
const bodyHtml = (c) => `<p><span style="font-family:Georgia,serif;font-size:18pt;color:#0f6cbd"><b>${c.agenda}</b></span></p><p>${c.hello}</p>` +
  `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse"><tbody><tr><td>10:00</td><td>${c.rows[0]}</td></tr><tr><td>10:30</td><td>${c.rows[1]}</td></tr><tr><td>11:00</td><td>${c.rows[2]}</td></tr></tbody></table>` +
  `<p><span style="color:#c5221f"><b>10:00</b></span> <span style="background-color:#fff3a3">${c.thanks}</span></p>`;

const SCENES = {
  async S1() {
    await setPrefs({ theme: "light" });
    await goInbox();
    await openMail(1);
    await away();
  },
  async S2({ copy, data }) {
    await setPrefs({ theme: "light", pgpEncrypt: "never" });
    await goInbox();
    await newMail(null, { to: data.mails[0].fromEmail, subject: copy.agenda, html: bodyHtml(copy), picture: true });
    await away();
  },
  async S3() {
    await setPrefs({ theme: "dark", mailCanvas: "dark", accent: "#8764b8" });
    await goInbox();
    await openMail(3);
    await away();
  },
  async S4({ loc }) {
    await setPrefs({ theme: "light" });
    await goInbox();
    await openMail(2);
    const r = await rect('[data-thread="shot2"]');
    await click(r.cx, r.cy, 1, "right");
    await sleep(500);
    await clickText(tr(loc.app, "mail.ctx.createRule"));
    await waitFor("document.querySelector('.modal')");
    await sleep(900);
    await away();
  },
  async S5({ copy, data }) {
    await setPrefs({ theme: "dark", mailCanvas: "dark", pgpEncrypt: "never" });
    await goInbox();
    await newMail(null, { to: data.mails[0].fromEmail, subject: copy.agenda, html: bodyHtml(copy) });
    await key("E", "KeyE", 69, CTRL | SHIFT);
    await key("G", "KeyG", 71, CTRL | SHIFT);
    await sleep(500);
    await away();
  },
  async S6({ copy }) {
    await setPrefs({ theme: "light", calView: "week" });
    await evaluate("(async () => { await window.__store.getState().setModule('calendar'); return true; })()");
    await sleep(1500);
    await away();
  },
  async S7() {
    await setPrefs({ theme: "dark", mailCanvas: "dark" });
    await goInbox();
    await openMail(1);
    await key("k", "KeyK", 75, CTRL);
    await waitFor("document.querySelector('.modal.cmd')");
    await sleep(500);
  },
  async S8({ loc }) {
    await setPrefs({ theme: "light" });
    await goInbox();
    await openMail(1);
    await clickText(tr(loc.app, "reading.head.summarize"));
    await waitFor(`document.body.innerText.includes(${JSON.stringify("•")})`, 10000);
    await sleep(900);
    await away();
  },
};

const results = [];
try {
  const enMd = fs.readFileSync(path.join(mdDir, "en.md"), "utf8");
  for (const loc of LOCALES) {
    if (wantLang && !wantLang.includes(loc.col) && !wantLang.includes(loc.md)) continue;
    const md = fs.readFileSync(path.join(mdDir, `${loc.md}.md`), "utf8");
    const data = shotsData(loc.md, sampleMail(md, enMd, loc.md === "en"));
    for (const [name, scene] of Object.entries(SCENES)) {
      if (wantShots && !wantShots.includes(name)) continue;
      await openApp(loc.app, data, loc.md);
      await scene({ loc, data, copy: COPY[loc.md] });
      await dbg(`${loc.col}-${name}.png`);
      await shoot(path.join(outDir, loc.col, `${name}.png`));
      results.push(`${loc.col}/${name}`);
      console.log(`store-screenshots: ${loc.col}/${name}.png`);
    }
  }
} finally {
  await h.shutdown();
}
console.log(`store-screenshots: ${results.length} image(s) in ${outDir}`);

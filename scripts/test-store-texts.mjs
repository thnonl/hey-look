// The texts of the Microsoft Store version (WP14 part 2, WA.3, W14.5, W14.6), no browser. Run: node --experimental-strip-types scripts/test-store-texts.mjs
// The texts were agreed with the 8 language specialists (spec WP14 section 12); this keeps them as they were agreed:
//   - the six app keys exist in all 8 languages; the English ones are exactly the agreed words; the other languages are not English text and say what the key is for
//   - settings.about.privacyStore is the privacy text of a managed copy (settings.about.privacyManaged, word for word) plus the sentences that say the Store updates it and the app does not check
//     (in every language; the GitHub update sentences of settings.about.privacy are not in it)
//   - the two autostart hints name Windows' own place (Settings > Apps > Startup) or the organisation
//   - the website: every language's help page has the section "Content from the AI Assistant" (id ai-report, the two paragraphs, the report address) and the two paragraphs about the Store
//     version in its Updates answer; every download page has the Store block, hidden, with the Store name and the badge text, and docs/assets/site.js shows it only for a 12 character Store ID
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadDicts } from "./lib/i18n-dicts.mjs";
import { LANGS as SITE_LANGS } from "./generate-site-languages.mjs";

const d = await loadDicts();
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CODES = ["en", "vi", "fr", "zh-Hans", "es", "ja", "de", "ru"];
assert.deepEqual(Object.keys(d).sort(), [...CODES].sort());
const KEYS = ["settings.about.privacyPolicy", "settings.about.privacyStore", "settings.about.updatesStore", "settings.tray.autostartOffInWindows", "settings.tray.autostartByPolicy", "settings.ai.report"];
let n = 0;
const check = (label, fn) => {
  try {
    fn();
  } catch (e) {
    e.message = `${label}: ${e.message}`;
    throw e;
  }
  n++;
};

check("the agreed English words", () => {
  assert.equal(d.en["settings.about.privacyPolicy"], "Privacy policy");
  assert.equal(d.en["settings.ai.report"], "Report a problem with AI content");
  assert.equal(d.en["settings.about.updatesStore"], "Updates come from the Microsoft Store.");
  assert.equal(d.en["settings.tray.autostartOffInWindows"], "Turned off in Windows. To use it, turn Hey Look! on again in Windows Settings > Apps > Startup.");
  assert.equal(d.en["settings.tray.autostartByPolicy"], "Your organization manages this setting.");
  assert.equal(
    d.en["settings.about.privacyStore"],
    "All features are always enabled. No license, no subscription, no cloud account. Mail goes directly between this app and your mail servers; AI features use only the endpoint you configure. The Microsoft Store keeps Hey Look! up to date; the app itself does not check for updates.",
  );
});

for (const c of CODES) {
  check(`${c}: the six keys`, () => {
    for (const k of KEYS) {
      assert.equal(typeof d[c][k], "string", k);
      assert.ok(d[c][k].trim().length > 3 && !d[c][k].includes("{") && !/^settings\./.test(d[c][k]), `${k}: ${d[c][k]}`);
      if (c !== "en") assert.notEqual(d[c][k], d.en[k], `${k} is still English`);
    }
    // the Store text starts with the privacy text of a managed copy, word for word, and then says who updates
    const managed = d[c]["settings.about.privacyManaged"];
    const store = d[c]["settings.about.privacyStore"];
    assert.ok(store.startsWith(managed), `privacyStore does not start with privacyManaged:\n${store}\n${managed}`);
    assert.ok(store.length > managed.length + 20 && store.includes("Microsoft Store"), "the Store sentence");
    assert.ok(!store.includes("GitHub") && !store.includes("github.com"), "no GitHub update check in the Store text");
    assert.ok(d[c]["settings.about.updatesStore"].includes("Microsoft Store") && !d[c]["settings.about.updatesStore"].includes("GitHub"));
    // the hints: Windows' own place, and the organisation
    assert.ok(d[c]["settings.tray.autostartOffInWindows"].includes("Hey Look!"), "the app's name");
    assert.ok(/[>›＞]/.test(d[c]["settings.tray.autostartOffInWindows"]) || c === "ja", "the path in Windows Settings");
    assert.notEqual(d[c]["settings.tray.autostartByPolicy"], d[c]["settings.tray.autostartOffInWindows"]);
  });
}

// ---- the website
const DIR = Object.fromEntries(SITE_LANGS.map((l) => [l.hreflang, l.dir ? `${l.dir}/` : ""]));
for (const c of CODES) {
  check(`${c}: help.html and download.html`, () => {
    const folder = DIR[c];
    const help = read(`docs/${folder}help.html`);
    const sec = /<details class="hq" id="ai-report"><summary>([^<]+)<\/summary><div class="hq-a"><p>([^]*?)<\/p><p>([^]*?)<\/p><\/div><\/details>/.exec(help);
    assert.ok(sec, "the AI section id=ai-report with a summary and two paragraphs");
    assert.ok(sec[3].includes("namth.onl@gmail.com"), "the report address");
    // it is the last question of the group "Report a problem" and the group is the one the table of contents lists
    const grp = help.slice(help.indexOf('id="g-report"'));
    assert.ok(grp.indexOf('id="ai-report"') > 0 && grp.indexOf('id="ai-report"') < grp.indexOf("</section>"), "inside the report group");
    // the Updates answer has the Store version's two paragraphs after the existing one
    const upd = /<details class="hq" id="updates">([^]*?)<\/details>/.exec(help)[1];
    assert.equal((upd.match(/<p>/g) ?? []).length, 3, "the Updates answer has three paragraphs (the old one and the two of the Store version)");
    // the privacy answer is unchanged in meaning: still says where the data is (nothing removed)
    const dl = read(`docs/${folder}download.html`);
    const blk = /<div class="asset" id="store-block" hidden><strong>([^<]+)<\/strong><a class="btn btn-ghost" id="store-link" href="https:\/\/apps\.microsoft\.com\/detail\/" rel="noopener"><svg[^>]*><use href="#i-external"\/><\/svg><span class="t">([^<]+)<\/span><\/a><small>([^<]+)<\/small><\/div>/.exec(dl);
    assert.ok(blk, "the Store block of the Windows card, hidden");
    assert.equal(blk[1], "Microsoft Store");
    assert.ok(blk[3].includes("Microsoft Store"), "the text names the Store");
    assert.equal((dl.match(/id="store-block"/g) ?? []).length, 1);
    // inside the Windows card
    const card = dl.slice(dl.indexOf('id="card-windows"'), dl.indexOf("</article>", dl.indexOf('id="card-windows"')));
    assert.ok(card.includes('id="store-block"'), "in the Windows card");
  });
}
check("site.js shows the Store block only for a Store ID", () => {
  const js = read("docs/assets/site.js");
  const m = /var STORE_PRODUCT_ID = '([^']*)';/.exec(js);
  assert.ok(m, "var STORE_PRODUCT_ID = '...';");
  assert.ok(m[1] === "" || /^[0-9A-Z]{12}$/.test(m[1]), "empty (not published yet) or the 12 character Store ID");
  assert.ok(js.includes("/^[0-9A-Z]{12}$/.test(STORE_PRODUCT_ID)") && js.includes("storeBlock.hidden = false"));
  assert.ok(js.includes("https://apps.microsoft.com/detail/' + STORE_PRODUCT_ID"));
});
check("English help: the three paragraphs of the Store version", () => {
  const help = read("docs/help.html");
  assert.ok(help.includes("A Store copy is updated only by the Store, has no updater of its own and does not check GitHub; Settings &gt; About says &ldquo;Updates come from the Microsoft Store.&rdquo;"));
  assert.ok(help.includes("The Store version keeps its own mail, accounts and settings, apart from a copy installed from this website. Use one of them on a computer, not both."));
  assert.ok(help.includes("The AI Assistant sends your request to the AI service you set up in Settings &gt; AI Assistant, and that service writes the answer. Hey Look! does not provide or control the AI model, and text written by AI can be wrong."));
});
console.log(`test-store-texts: ok (${n} checks)`);

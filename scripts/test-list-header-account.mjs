#!/usr/bin/env node
// The mailbox name in the message list header (1.0.8): it sits on a line of its own ABOVE the Focused / Other tabs (before, it sat under the tabs, touching the
// purple underline of the active tab). The Filter stays on the tabs row at the right. Real app in the dev preview (mock backend, #smallmailbox).
//   - one mailbox, Inbox: the name is above the tabs with a gap of >= 8 px between the texts, never overlaps a tab or the Filter, one line, inside the list, no old .ml-sub line;
//   - another folder (Sent), and Focused Inbox off (Inbox title): the same line above the folder title;
//   - all mailboxes: no name line, the tabs start the header; a search: no name line (its summary line stays under the title);
//   - a very long name and a very long address with no name: one line, cut with an ellipsis, the tooltip has the whole text, nothing leaves the list;
//   - messages ticked: the selection bar covers the header (the name line is hidden with the tabs);
//   - light and dark, the list at its minimum (300 px) and at its default (392 px), the 8 languages (--full; default en, de, ru, vi).
//   node scripts/test-list-header-account.mjs [--full] [--font=Verdana] [--spacing=0.04] [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { arg, flag, languageJs, sleep, startHarness } from './cdp-harness.mjs';
import { LIST_HEAD_JS, headVerdict } from './lib/list-head-probe.mjs';

const FULL = flag('full');
const H = await startHarness('test-list-header-account', { vitePort0: 5440 });
const { evaluate, cdp } = H;
// font stress like test-focus-tabs (--font=Verdana, --spacing=0.04): the fallback fonts of macOS / Linux WebKit are wider than this PC's
const FONT = arg('font'), SPACING = arg('spacing');
if (FONT || SPACING) {
  const css = '*,*::before,*::after{' + (FONT ? 'font-family:' + FONT + '!important;' : '') + (SPACING ? 'letter-spacing:' + SPACING + 'em!important;' : '') + '}';
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const sh = new CSSStyleSheet(); sh.replaceSync(${JSON.stringify(css)}); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sh]; })()` });
}
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const S = (js) => `window.__store.getState().${js}`;
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(50); } return false; };
const probe = async () => JSON.parse(await evaluate(LIST_HEAD_JS));
const view = async (folder, acct) => { await evaluate(`${S('setView')}(${JSON.stringify(folder)}, ${acct ? JSON.stringify(acct) : 'null'}); 1`); await sleep(150); await waitFor(`!${S('loading')}`, 10000); await sleep(150); };
const setAcct = (patch) => evaluate(`window.__store.setState({ accounts: ${S('accounts')}.map((a, i) => i === 0 ? { ...a, ...${JSON.stringify(patch)} } : a) }); 1`);
const NAME = 'Thái Hoàng Nam';
const LONG_NAME = 'Alexandra Maria von Habsburg-Lothringen-Esterhazy der Dritte, Geschäftsführerin';
const LONG_MAIL = 'a.very.long.mailbox.address.for.testing@some-extremely-long-company-domain.example.org';

try {
  await H.openApp('lang=en&smallmailbox', 1280, 800);
  await waitFor(`${S('folders')}.some((f) => f.key === 'inbox' && f.unreadFocused !== undefined)`, 15000);
  await setAcct({ displayName: NAME });
  const langs = FULL ? ['en', 'de', 'es', 'fr', 'ja', 'ru', 'vi', 'zh-Hans'] : ['en', 'de', 'ru', 'vi'];

  for (const lang of langs) {
    await evaluate(languageJs(lang));
    for (const theme of ['light', 'dark']) {
      for (const w of FULL ? [300, 392, 600] : [300, 392]) {
        await evaluate(`${S('setPrefs')}({ theme: ${JSON.stringify(theme)}, listW: ${w}, focused: true }); 1`);
        await sleep(100);
        const at = `${lang} ${theme} ${w}px`;
        await check(`${at} Inbox of a mailbox`, async () => {
          await view('inbox', 'a1');
          const p = await probe();
          assert.deepEqual(headVerdict(p, { acct: NAME, tabs: true }), [], JSON.stringify({ gap: p.gap, acct: p.acct?.bottom, tabs: p.tabs.map((t) => t.top) }));
          assert.ok(p.listW >= 300, `list ${p.listW}`);
        });
        if (w !== 300 && !FULL) continue;
        await check(`${at} Sent`, async () => {
          await view('sent', 'a1');
          assert.deepEqual(headVerdict(await probe(), { acct: NAME, tabs: false }), []);
        });
        await check(`${at} all mailboxes`, async () => {
          await view('inbox', null);
          const p = await probe();
          assert.deepEqual(headVerdict(p, { acct: null, tabs: true }), []);
          assert.ok(p.row.top - p.head.top < 14, `the tabs start the header (${p.row.top - p.head.top} px from its top)`);
        });
      }
    }
  }

  await evaluate(languageJs('en'));
  await evaluate(`${S('setPrefs')}({ theme: 'light', listW: 300, focused: true }); 1`);

  await check('Focused Inbox off: the folder title with the name above', async () => {
    await evaluate(`${S('setPrefs')}({ focused: false }); 1`);
    await view('inbox', 'a1');
    const p = await probe();
    assert.deepEqual(headVerdict(p, { acct: NAME, tabs: false }), []);
    assert.equal(p.h2, 'Inbox');
    await evaluate(`${S('setPrefs')}({ focused: true }); 1`);
  });

  await check('a search: no name line, the summary line is under the title', async () => {
    await view('inbox', 'a1');
    await evaluate(`${S('setSearch')}('digest'); 1`);
    await sleep(500);
    const p = await probe();
    assert.deepEqual(headVerdict(p, { acct: null }), []);
    assert.ok(await evaluate(`!!document.querySelector('.msg-list .ml-head .ml-sub')`), 'the search summary shows');
    await evaluate(`${S('setSearch')}(''); 1`);
    await sleep(500);
    assert.equal((await probe()).acct?.text, NAME, 'the name comes back with the list');
  });

  await check('a very long name: one line, ellipsis, tooltip has the whole name and the address', async () => {
    await setAcct({ displayName: LONG_NAME });
    await view('inbox', 'a1');
    const p = await probe();
    assert.deepEqual(headVerdict(p, { acct: LONG_NAME, tabs: true }), []);
    assert.ok(p.acctCut, 'the name is cut at 300 px');
    assert.ok(p.acct.title.startsWith(LONG_NAME) && p.acct.title.includes('@'), `tooltip: ${p.acct.title}`);
    assert.ok(Math.abs(p.headH - (await (async () => { await setAcct({ displayName: NAME }); await view('inbox', 'a1'); return (await probe()).headH; })())) < 1, 'a long name does not change the header height');
  });

  await check('a very long address (no name): one line, ellipsis, the address as tooltip', async () => {
    await setAcct({ displayName: '', email: LONG_MAIL });
    await view('inbox', 'a1');
    const p = await probe();
    assert.deepEqual(headVerdict(p, { acct: LONG_MAIL, tabs: true }), []);
    assert.ok(p.acctCut, 'the address is cut at 300 px');
    assert.equal(p.acct.title, LONG_MAIL);
    await setAcct({ displayName: NAME, email: 'nam@example.com' });
  });

  await check('messages ticked: the selection bar covers the header, the name line is hidden with the tabs', async () => {
    await view('inbox', 'a1');
    await evaluate(`${S('setChecked')}([${S('threads')}[0].threadId]); 1`);
    await sleep(200);
    assert.equal((await probe()).acctVisible, false);
    await evaluate(`${S('setChecked')}([]); 1`);
    await sleep(200);
    assert.equal((await probe()).acctVisible, true);
  });

  await check('the name line is above the tab underline: nothing of the active tab (box and 2.5 px underline) is above the name line bottom', async () => {
    await view('inbox', 'a1');
    const p = await probe();
    assert.ok(p.underline.bottom > p.acct.bottom + 20, `underline ${p.underline.bottom}, name bottom ${p.acct.bottom}`);
  });
} finally {
  await H.shutdown();
}

if (failures.length) { console.error(`test-list-header-account: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-list-header-account: ok');

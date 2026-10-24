#!/usr/bin/env node
// 1.0.7 W5.4 (REQ-5.4.7, AC-5.4.5 page part) in the dev preview, whose mock backend answers `notify_caps` (`#os=` the system, `#noactions` a Linux notification service without buttons):
// Settings > Mailboxes > Notifications shows the Buttons row (three selects) when the system's notifications have buttons (Windows; Linux with the `actions` capability) and otherwise a note:
//   Linux without actions -> "Notifications on this desktop have no buttons..." (8 languages), macOS -> "Notifications on macOS have no buttons..."; never both, never neither once the answer is in
//   node scripts/test-notify-buttons-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-notify-buttons-ui', { vitePort0: 6170 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
// the section buttons of "All accounts" follow its own button in this order: Composing, Signatures, Templates, Filters, Notifications
const toNotifications = async () => {
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:all' }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.settings-body .mb-body')`), 'Settings did not open');
  await sleep(300);
  const label = await evaluate(`(() => { const all = [...document.querySelectorAll('.settings-body button, .settings-nav button, nav button')]; const i = all.findIndex((b) => b.classList.contains('has-sub')); const b = all[i + 5]; const text = b.textContent.trim(); b.click(); return text; })()`);
  assert.ok(await waitFor(`document.querySelector('.settings-body .mb-body')?.getAttribute('aria-label') === ${JSON.stringify(label)}`), 'the Notifications section did not show');
  await sleep(600); // (the answer of notify_caps)
};
const open = async (hash) => {
  await H.openApp(hash, 1280, 800);
  await toNotifications();
};
const state = () => evaluate(`(() => {
  const body = document.querySelector('.settings-body');
  const selects = [...body.querySelectorAll('.three select')].length;
  const notes = [...body.querySelectorAll('.muted.small')].map((n) => n.textContent.trim()).filter((x) => /no buttons|keine Schaltfl|không có nút|pas de boutons|没有按钮|no tienen botones|ボタンがありません|нет кнопок/i.test(x));
  return { selects, notes };
})()`);

try {
  await check('Windows: the Buttons row, no note', async () => {
    await open('lang=en&os=windows');
    const s = await state();
    assert.equal(s.selects, 3, JSON.stringify(s));
    assert.equal(s.notes.length, 0, JSON.stringify(s));
  });
  await check('Linux with a service that has actions: the Buttons row, no note', async () => {
    await open('lang=en&os=linux');
    const s = await state();
    assert.equal(s.selects, 3, JSON.stringify(s));
    assert.equal(s.notes.filter((n) => /no buttons/.test(n)).length, 0, JSON.stringify(s));
  });
  await check('AC-5.4.5 Linux without actions: the note of this desktop, no row, in 8 languages', async () => {
    const want = {
      en: 'Notifications on this desktop have no buttons. Open Hey Look! to act on a message.',
      vi: 'Thông báo trên môi trường desktop này không có nút. Hãy mở Hey Look! để xử lý thư.',
      fr: 'Les notifications de cet environnement de bureau n’ont pas de boutons. Ouvrez Hey Look! pour agir sur un message.',
      'zh-Hans': '此桌面环境上的通知没有按钮。请打开Hey Look!以处理邮件。',
      es: 'Las notificaciones de este escritorio no tienen botones. Abre Hey Look! para actuar sobre un mensaje.',
      ja: 'このデスクトップの通知にはボタンがありません。メッセージを操作するには、Hey Look!を開いてください。',
      de: 'Benachrichtigungen auf diesem Desktop haben keine Schaltflächen. Öffnen Sie Hey Look!, um auf eine Nachricht zu reagieren.',
      ru: 'В уведомлениях этой среды рабочего стола нет кнопок. Откройте Hey Look!, чтобы выполнить действие с письмом.',
    };
    for (const [lang, text] of Object.entries(want)) {
      await open(`lang=${lang}&os=linux&noactions`);
      const s = await state();
      assert.ok(s.notes.includes(text), `${lang}: ${JSON.stringify(s)}`);
      assert.equal(s.selects, 0, `${lang}: no row`);
    }
  });
  await check('macOS: the old note about macOS, no row', async () => {
    await open('lang=en&os=macos');
    const s = await state();
    assert.equal(s.selects, 0, JSON.stringify(s));
    assert.ok(s.notes.some((n) => n.startsWith('Notifications on macOS have no buttons')), JSON.stringify(s));
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-notify-buttons-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-notify-buttons-ui: ok');

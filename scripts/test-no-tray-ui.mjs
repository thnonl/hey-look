#!/usr/bin/env node
// 1.0.7 W5.6 (REQ-5.6.1, REQ-5.6.2, AC-5.6.1 to AC-5.6.3 page part) in the dev preview (`#notray` plays a Linux desktop without a tray host, `#os=` the system):
//   no tray host: the Welcome bullet says "while Hey Look! is open", the quit question's button is "Keep Hey Look! open", Settings' tab is "Notifications & startup" (navigation entry and heading),
//   and none of these screens says "tray" except the disabled keep-running row's hint; with a tray host the old texts are unchanged (regression); macOS Welcome says "menu bar" in 8 languages
//   node scripts/test-no-tray-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness, languageJs } from './cdp-harness.mjs';

const H = await startHarness('test-no-tray-ui', { vitePort0: 6160 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const text = () => evaluate(`document.body.innerText`);
const welcome = async (hash) => {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: 'about:blank' });
  await cdp('Page.navigate', { url: `${H.base}#${hash}` });
  assert.ok(await waitFor(`!!document.querySelector('.welcome-points')`, 20000), 'no Welcome screen');
  await sleep(300);
  return evaluate(`[...document.querySelectorAll('.welcome-points li')].map((l) => l.textContent.trim())`);
};
const settingsTray = async (hash) => {
  await H.openApp(hash, 1280, 800);
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'tray' }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.settings-body h3')`), 'the tray tab did not open');
  await sleep(250);
  return evaluate(`({ nav: [...document.querySelectorAll('.settings-nav button, nav button, .settings-nav .nav-item')].map((b) => b.textContent.trim()), heading: document.querySelector('.settings-body h3').textContent.trim(), body: document.body.innerText })`);
};

try {
  await check('AC-5.6.1 no tray host: the Welcome bullet does not name the tray', async () => {
    const li = await welcome('lang=en&os=linux&notray&noaccounts');
    assert.ok(li.some((x) => x === 'Keeps checking mail while Hey Look! is open, with Undo for every move'), JSON.stringify(li));
    assert.ok(!(await text()).toLowerCase().includes('tray'));
  });
  await check('AC-5.6.2 a tray host: the old bullet (Linux and Windows)', async () => {
    for (const os of ['linux', 'windows']) {
      const li = await welcome(`lang=en&os=${os}&noaccounts`);
      assert.ok(li.includes('Keeps checking mail from the tray, with Undo for every move'), `${os}: ${JSON.stringify(li)}`);
    }
  });
  await check('AC-5.6.3 macOS Welcome says menu bar, in 8 languages', async () => {
    const want = {
      en: 'Keeps checking mail from the menu bar, with Undo for every move', vi: 'Vẫn kiểm tra thư từ thanh menu, có Hoàn tác cho mọi thao tác di chuyển',
      fr: 'Continue de vérifier les messages depuis la barre des menus, avec Annuler pour chaque déplacement', 'zh-Hans': '在菜单栏中持续检查邮件，每次移动邮件都可撤销',
      es: 'Sigue comprobando el correo desde la barra de menús, con Deshacer para cada movimiento', ja: 'メニューバーでメールを確認し続け、どの移動も元に戻せます',
      de: 'Ruft auch in der Menüleiste weiter E-Mails ab, mit „Rückgängig“ für jede Verschiebung', ru: 'Проверяет почту из строки меню, любое перемещение можно отменить',
    };
    for (const [lang, expected] of Object.entries(want)) {
      const li = await welcome(`lang=${lang}&os=macos&noaccounts`);
      assert.ok(li.includes(expected), `${lang}: ${JSON.stringify(li)}`);
    }
  });
  await check('AC-5.6.1 no tray host: Settings tab "Notifications & startup" (entry and heading), the only "tray" is the disabled row\'s explanation', async () => {
    const s = await settingsTray('lang=en&os=linux&notray');
    assert.equal(s.heading, 'Notifications & startup');
    assert.ok(s.nav.includes('Notifications & startup'), JSON.stringify(s.nav));
    assert.ok(!s.nav.includes('Notifications & tray') && !s.body.includes('Notifications & tray'));
    const rows = s.body.split('\n').filter((l) => /tray/i.test(l));
    assert.ok(rows.every((l) => /No tray area was found|Keep running in the tray when the window is closed/.test(l)), `tray named outside the disabled row's hint: ${JSON.stringify(rows)}`);
  });
  await check('AC-5.6.5 the German entry fits the navigation at 960x560', async () => {
    await H.openApp('lang=de&os=linux&notray', 960, 560);
    await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'tray' }); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.settings-body h3')`));
    await sleep(250);
    const r = await evaluate(`(() => { const b = [...document.querySelectorAll('nav button, .settings-nav button')].find((x) => x.textContent.trim() === 'Benachrichtigungen & Autostart'); if (!b) return null; return { clipped: b.scrollWidth > b.clientWidth + 1, right: b.getBoundingClientRect().right, navRight: b.closest('nav, .settings-nav').getBoundingClientRect().right }; })()`);
    assert.ok(r, 'the entry is not there');
    assert.equal(r.clipped, false);
    assert.ok(r.right <= r.navRight + 1);
  });
  await check('with a tray host the tab is "Notifications & tray" as before', async () => {
    const s = await settingsTray('lang=en&os=linux');
    assert.equal(s.heading, 'Notifications & tray');
    assert.ok(s.nav.includes('Notifications & tray'), JSON.stringify(s.nav));
  });
  await check('D-019 Settings > Notifications: the three tray labels say menu bar on a Mac (8 languages) and keep the tray words on Windows and Linux', async () => {
    const mac = {
      en: ['Keep running in the menu bar when the window is closed', 'Menu bar icon badge', 'Starts minimized to the menu bar'],
      vi: ['Tiếp tục chạy trên thanh menu khi đóng cửa sổ', 'Huy hiệu biểu tượng thanh menu', 'Khởi động ở dạng thu nhỏ vào thanh menu'],
      fr: ['Continuer à fonctionner dans la barre des menus à la fermeture de la fenêtre', 'Pastille de l’icône de la barre des menus', 'Démarre réduit dans la barre des menus'],
      'zh-Hans': ['关闭窗口后在菜单栏中继续运行', '菜单栏图标角标', '启动时最小化到菜单栏'],
      es: ['Seguir en la barra de menús al cerrar la ventana', 'Insignia del icono de la barra de menús', 'Se inicia minimizado en la barra de menús'],
      ja: ['ウィンドウを閉じてもメニューバーで実行を続ける', 'メニューバーアイコンのバッジ', 'メニューバーに最小化した状態で起動します'],
      de: ['In der Menüleiste weiterlaufen, wenn das Fenster geschlossen wird', 'Badge am Menüleisten-Symbol', 'Startet minimiert in der Menüleiste'],
      ru: ['Продолжать работу в строке меню при закрытии окна', 'Индикатор на значке в строке меню', 'Запускается свёрнутым в строку меню'],
    };
    const other = {
      en: ['Keep running in the tray when the window is closed', 'Tray icon badge', 'Starts minimized to the tray'],
      de: ['Im Infobereich weiterlaufen, wenn das Fenster geschlossen wird', 'Badge am Infobereich-Symbol', 'Startet minimiert im Infobereich'],
      ja: ['ウィンドウを閉じてもトレイで実行を続ける', 'トレイアイコンのバッジ', 'トレイに最小化した状態で起動します'],
    };
    const seen = async (hash) => { await settingsTray(hash); return evaluate(`document.querySelector('.settings-body').innerText`); };
    for (const [lang, labels] of Object.entries(mac)) {
      const body = await seen(`lang=${lang}&os=macos`);
      for (const l of labels) assert.ok(body.includes(l), `macos ${lang}: "${l}" is not in the tab`);
    }
    for (const os of ['windows', 'linux']) {
      for (const [lang, labels] of Object.entries(other)) {
        const body = await seen(`lang=${lang}&os=${os}`);
        for (const l of labels) assert.ok(body.includes(l), `${os} ${lang}: "${l}" is not in the tab`);
      }
    }
    // the old tray labels are gone from a Mac's tab
    const macEn = await seen('lang=en&os=macos');
    for (const l of other.en) assert.ok(!macEn.includes(l), `macos en still shows "${l}"`);
  });
  await check('AC-5.6.1 the quit question: "Keep Hey Look! open" without a tray host, "Keep running in tray" with one, "in the menu bar" on a Mac', async () => {
    for (const [hash, label] of [['lang=en&os=linux&notray', 'Keep Hey Look! open'], ['lang=en&os=linux', 'Keep running in tray'], ['lang=en&os=macos', 'Keep running in the menu bar'], ['lang=de&os=linux&notray', 'Hey Look! geöffnet lassen']]) {
      await H.openApp(hash, 1280, 800);
      await evaluate(`window.__mockEmit('confirm-quit', { count: 1, next: null }); 1`);
      assert.ok(await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(label)})`), `${hash}: no "${label}" button`);
    }
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-no-tray-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-no-tray-ui: ok');

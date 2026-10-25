import fs from 'node:fs';
const p = 'scripts/test-settings-search.mjs';
let s = fs.readFileSync(p, 'utf8');
s = s.replace("async function keys(c) {", `/** D-113: "tray" is what people type, whatever the system calls the icon (a Mac says menu bar): the Notifications tab and the keep-running, starts-minimized and tray-badge rows are listed */
async function trayWord(c) {
  const entries = await index();
  const want = ['pg-tray', 'keepRunning', 'autostart', 'trayBadge'].map((id) => entries.find((e) => e.id === id)?.label).filter(Boolean);
  check(want.length >= 3, 'the tray entries are in the index');
  await settingsOpen('general');
  await waitFor(\`!!document.getElementById('set-askWhere')\`);
  await ctrlF(c);
  await typeText('tray', 40);
  await sleep(300);
  const opts = (await boxState()).opts.map((o) => o.label);
  for (const l of want) check(opts.includes(l), \`"tray" lists "\${l}" (\${JSON.stringify(opts)})\`);
  await click('.settings-nav .set-clear');
  await sleep(150);
}
async function keys(c) {`);
s = s.replace("    n += await jumps(c);\n    if (c === COMBOS[0]) {", "    n += await jumps(c);\n    await trayWord(c);\n    if (c === COMBOS[0]) {");
fs.writeFileSync(p, s);

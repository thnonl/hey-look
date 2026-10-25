import fs from 'node:fs';
const p = 'scripts/test-settings-index.mjs';
let s = fs.readFileSync(p, 'utf8');
const a = "      eq(idx.find((e) => e.id === \"keepRunning\").hint,";
if (!s.includes(a)) throw new Error('marker');
s = s.replace(a, `      // D-113: people type the English word "tray" in any language and on any system (a Mac says menu bar, a Linux without a tray host has no tray at all): the tab and the
      // keep-running, tray-badge (where it exists) and starts-minimized rows are found by "tray" and by "system tray"
      for (const q of ["tray", "system tray", "TRAY"]) {
        const hits = searchSettings(idx, q).map((h) => h.entry.id);
        for (const id of ["pg-tray", "keepRunning", "autostart", ...(c.tray ? ["trayBadge"] : [])]) ok(hits.includes(id), \`\${tag}: "\${q}" finds \${id} (\${hits})\`);
        ok(searchSettings(idx, q).every((h) => h.entry.tab === "tray"), \`\${tag}: "\${q}" finds only the Notifications tab (\${hits})\`);
      }
` + a);
fs.writeFileSync(p, s);

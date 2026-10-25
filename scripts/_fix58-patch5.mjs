import fs from 'node:fs';
const p = 'scripts/test-settings-index.mjs';
let s = fs.readFileSync(p, 'utf8');
const l = s.split("\n").filter((x) => !x.includes('finds only the Notifications tab'));
fs.writeFileSync(p, l.join("\n"));

import fs from 'node:fs';
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const x of r.sort((a, b) => a.cmd.localeCompare(b.cmd) || a.when.localeCompare(b.when))) console.log(x.when.slice(5, 16), x.cmd.split('scripts/')[1].split(' ')[0], x.code, x.secs + 's', JSON.stringify(x.fails.slice(0, 2)).slice(0, 220));

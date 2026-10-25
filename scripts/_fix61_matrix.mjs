// scratch (fix61): node --experimental-strip-types scripts/_fix61_matrix.mjs <cmds file> <out json> <comma list of fake times> [concurrency]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmdsFile, outFile, times, conc = '4'] = process.argv.slice(2);
const cmds = fs.readFileSync(cmdsFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const whens = times.split(',');
const jobs = [];
for (const c of cmds) for (const w of whens) jobs.push({ cmd: c, when: w });
const results = [];
const flush = () => fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
let next = 0, running = 0, done = 0;
const pre = pathToFileURL(path.join(ROOT, 'scripts/_fix61_fakedate.mjs')).href;
const run = (job) => new Promise((res) => {
  const t0 = Date.now();
  const p = spawn(job.cmd, { cwd: ROOT, shell: true, env: { ...process.env, HEYLOOK_FAKE_NOW: job.when, ...(job.cmd.includes('--require-browser') ? {} : { NODE_OPTIONS: `--import ${pre}` }) } });
  let out = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  const to = setTimeout(() => { try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F']); } catch {} }, 420000);
  p.on('exit', (code) => {
    clearTimeout(to);
    const fails = out.split('\n').filter((l) => /^FAIL|FAILED|failure\(s\)|SKIPPED/.test(l)).slice(0, 6);
    results.push({ ...job, code, secs: Math.round((Date.now() - t0) / 1000), fails, tail: out.split('\n').slice(-4).join('\n') });
    flush(); res();
  });
});
await new Promise((all) => {
  const pump = () => {
    while (running < Number(conc) && next < jobs.length) { const j = jobs[next++]; running++; run(j).then(() => { running--; done++; console.log(`${done}/${jobs.length} ${j.when} ${j.cmd.slice(0, 90)}`); pump(); }); }
    if (done === jobs.length) all();
  };
  pump();
});
console.log('MATRIX DONE', outFile);

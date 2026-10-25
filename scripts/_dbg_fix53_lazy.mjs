// scratch (never committed)
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./test-lazy-views.mjs', import.meta.url), 'utf8')
  .replace("ok(compose.some((n) => /Compose\.tsx/.test(n))", "const all = await resources(); console.log('DBG resources', all.length, 'editorish', JSON.stringify(compose.map(n=>n.replace(/^.*\/\/[^/]+/,'')))); ok(compose.some((n) => /Compose\.tsx/.test(n))");
fs.writeFileSync(new URL('./_dbg_fix53_lazy_run.mjs', import.meta.url), src);

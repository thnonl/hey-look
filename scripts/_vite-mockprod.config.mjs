// scratch (not committed): a production build (React without the development checks, minified) that still contains the dev mock backend, for timing only: DEV is forced on.
import { mergeConfig } from 'vite';
import base from '../vite.config.ts';

export default (env) => mergeConfig(typeof base === 'function' ? base(env) : base, {
  define: { 'import.meta.env.DEV': 'true', 'import.meta.env.PROD': 'false' },
  build: { outDir: 'C:/Users/namth/AppData/Local/Temp/claude/E--hey-mail/5dee273c-ea7d-4367-9fe0-8d27861b3478/scratchpad/mockprod-dist', emptyOutDir: true, minify: true, sourcemap: false },
  preview: { port: 5998, strictPort: false, host: '127.0.0.1' },
});

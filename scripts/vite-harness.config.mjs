// The vite config of the UI test harness (scripts/cdp-harness.mjs): the app's own config, except that the port is only a hint. A test asks for
// `--port <hint>` and takes the port vite actually bound (it moves on when the port is taken), so two tests started together can never share a dev server.
import { mergeConfig } from 'vite';
import base from '../vite.config.ts';

export default (env) => mergeConfig(typeof base === 'function' ? base(env) : base, { server: { strictPort: false, host: '127.0.0.1' } });

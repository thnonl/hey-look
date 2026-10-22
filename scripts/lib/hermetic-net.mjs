// A browser test must not depend on the network (a CI runner is rate-limited by api.github.com, offline, or behind a proxy): every request the page makes
// to a host other than this machine is paused through the DevTools Fetch domain and answered by the test. A request nobody stubbed is refused
// (net::ERR_BLOCKED_BY_CLIENT, a console error the test sees) and listed in `net.external`, so a new external call in a page shows up as a failure of
// the test that opened it, instead of passing on a good day.
//
//   const net = await installHermeticNet({ cdp, on, stub });
//     cdp(method, params)  the page session's send
//     on(handler)          adds a handler for the session's protocol events (handler(message))
//     stub(url)            optional: returns undefined (not stubbed), 'offline' (connection fails), or { status, body, type, delay } (answered, `delay` ms later: a slow server); may change between pages
//   net.requests           every external request seen: { url, how: 'stub' | 'offline' | 'blocked' }
//   net.external           the ones that were blocked because nothing stubbed them
//   net.reset()            clears both lists (call before a page load)
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
export const isLocalUrl = (url) => {
  try {
    const u = new URL(url);
    if (!/^(https?|wss?|ftp):$/.test(u.protocol)) return true; // data:, blob:, about:, chrome-extension: (Chrome's own PDF viewer) ... are not the network
    return LOOPBACK.has(u.hostname) || u.hostname.endsWith('.localhost');
  } catch { return true; }
};

/** The one request the website makes on every load of a download page (docs/assets/site.js), as the site reads it: tag_name, published_at, html_url and assets[{ name, browser_download_url, size }]. */
export const LATEST_RELEASE_URL = 'https://api.github.com/repos/thnonl/hey-look/releases/latest';
export const CANNED_TAG = 'v9.8.7'; // not a version the site could ever show by itself, so a page that shows it read the stub
export function cannedRelease(tag = CANNED_TAG) {
  const v = tag.replace(/^v/, ''), dl = `https://github.com/thnonl/hey-look/releases/download/${tag}/`;
  const asset = (name, size) => ({ name, size, browser_download_url: dl + name });
  return {
    tag_name: tag, name: `Hey Look! ${v}`, published_at: '2030-01-02T03:04:05Z', html_url: `https://github.com/thnonl/hey-look/releases/tag/${tag}`,
    assets: [
      asset(`HeyLook_${v}_windows_x64-setup.exe`, 12582912), asset(`HeyLook_${v}_windows_x64.msi`, 13631488), asset(`HeyLook_${v}_darwin_universal.dmg`, 20971520),
      asset(`HeyLook_${v}_linux_amd64.AppImage`, 15728640), asset(`HeyLook_${v}_linux_amd64.deb`, 9437184), asset(`HeyLook_${v}_linux_x86_64.rpm`, 9437184),
    ],
  };
}
/** A stub for LATEST_RELEASE_URL: `mode` is 'ok' (the canned release), a status number (403 rate limit, 500, 404 ...) or 'offline'. */
export function releaseStub(mode, tag = CANNED_TAG) {
  return (url) => {
    if (url !== LATEST_RELEASE_URL) return undefined;
    if (mode === 'offline') return 'offline';
    if (mode === 'ok') return { status: 200, type: 'application/json', body: JSON.stringify(cannedRelease(tag)) };
    return { status: Number(mode), type: 'application/json', body: JSON.stringify({ message: Number(mode) === 403 ? 'API rate limit exceeded' : 'stubbed failure' }) };
  };
}

export async function installHermeticNet({ cdp, on, stub = () => undefined }) {
  const net = { requests: [], external: [], reset() { this.requests.length = 0; this.external.length = 0; }, stub };
  on((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params, url = request.url;
    const answer = (method, params) => cdp(method, { requestId, ...params }).catch(() => { /* the page went away */ });
    if (isLocalUrl(url)) { answer('Fetch.continueRequest'); return; }
    const s = net.stub(url);
    if (s === 'offline') { net.requests.push({ url, how: 'offline' }); answer('Fetch.failRequest', { errorReason: 'ConnectionFailed' }); }
    else if (s) {
      net.requests.push({ url, how: 'stub' });
      const fulfil = () => answer('Fetch.fulfillRequest', { responseCode: s.status, responseHeaders: [{ name: 'content-type', value: s.type || 'application/json' }, { name: 'access-control-allow-origin', value: '*' }], body: Buffer.from(s.body ?? '').toString('base64') });
      if (s.delay) setTimeout(fulfil, s.delay); else fulfil();
    } else {
      net.requests.push({ url, how: 'blocked' }); net.external.push(url);
      answer('Fetch.failRequest', { errorReason: 'BlockedByClient' });
    }
  });
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  return net;
}

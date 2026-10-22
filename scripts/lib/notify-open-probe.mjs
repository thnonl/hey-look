// Measures, in the page, what a person sees after a click on the notification of a new mail (1.0.7 D-051, scripts/test-notify-open.mjs; WebKit rows WK-F7.03 to .05 in
// webkit-checks-107.md): which Inbox tab is selected, whether the mail's row is in the list, selected and inside the visible part of the list, what the reading pane shows,
// and the notices on screen. DOM only; nothing is added to the page.
//
// `notifyLookJs(threadId)` is an expression that evaluates to a JSON string, so it runs through a CDP `Runtime.evaluate` and through the test bridge's `/eval` alike
// (scripts/test-bridge.md). `notifyEmitJs(threadId)` sends the event the backend sends when the Windows toast is clicked (`open-thread`, shell.rs handle_activation) from the
// page itself, for a debug build under the test bridge on a Mac or Linux, where a native notification does not call the app back:
//   POST /eval { window: "main", js: <notifyEmitJs('<thread id>')> }   then, 1.5 s later,   POST /eval { window: "main", js: <notifyLookJs('<thread id>')> }
// The thread id is the `data-thread` of a row of the list (select the Other tab and read `document.querySelector('.ml-row').dataset.thread`, then go back to Focused).
//   node scripts/lib/notify-open-probe.mjs <thread id>       prints both expressions
//
// The answer of notifyLookJs: { tabs (number of Inbox tabs shown), tab (the selected tab's name), rowThere, rowSelected, rowInView (the whole row is inside the list's box),
//   rowTop / rowBottom / listTop / listBottom (the numbers behind it), pane (the subject in the reading pane), paneBody (the first 40 characters of the mail), toast (the notices) }
export const notifyLookJs = (id) => `(() => {
  const row = document.querySelector('[data-thread=' + ${JSON.stringify(JSON.stringify(id))} + ']'), body = document.querySelector('.ml-body');
  const bb = body && body.getBoundingClientRect(), rb = row && row.getBoundingClientRect();
  const tab = [...document.querySelectorAll('.pivots [role=tab]')].find((t) => t.getAttribute('aria-selected') === 'true');
  const frame = document.querySelector('.msg-frame'), fd = frame && frame.contentDocument;
  return JSON.stringify({
    tabs: document.querySelectorAll('.pivots [role=tab]').length, tab: tab ? tab.textContent.replace(/\\d+\\+?$/, '').trim() : null,
    rowThere: !!row, rowSelected: !!row && row.getAttribute('aria-selected') === 'true',
    rowInView: !!rb && !!bb && rb.top >= bb.top - 1 && rb.bottom <= bb.bottom + 1 && rb.height > 0,
    rowTop: rb ? Math.round(rb.top) : null, rowBottom: rb ? Math.round(rb.bottom) : null, listTop: bb ? Math.round(bb.top) : null, listBottom: bb ? Math.round(bb.bottom) : null,
    pane: (document.querySelector('.rp-head h2') || {}).textContent || null, paneBody: (fd && fd.body ? fd.body.innerText : '').trim().slice(0, 40),
    toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()).join(' | ') });
})()`;

export const notifyEmitJs = (id) => `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'open-thread', payload: { threadId: ${JSON.stringify(id)} } }).then(() => 'sent')`;

if (process.argv[1] && process.argv[1].endsWith('notify-open-probe.mjs')) {
  const id = process.argv[2] || '<thread id>';
  console.log(notifyEmitJs(id));
  console.log(notifyLookJs(id));
}

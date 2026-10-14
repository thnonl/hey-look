// The sandbox of the frame that shows a message. Imports nothing, so a plain Node script can test it (scripts/test-frame-sandbox.mjs).

/**
 * Safari's engine (WKWebView on macOS, WebKitGTK on Linux) does not run event listeners on the document of a frame whose sandbox
 * forbids scripts, even when the listener was added by the parent page. The app hooks link clicks, picture clicks and the "load
 * pictures" placeholders that way, so on that engine a click in a message did nothing (QA BUG-M9: links did not open on macOS).
 * There the sandbox allows scripts; the frame's CSP (`script-src 'none'`, see `frameCsp`) still forbids every script, inline
 * handler and `javascript:` link, and the HTML is sanitized before it gets here. Chromium (WebView2 on Windows) keeps the strict sandbox.
 */
export function frameSandbox(userAgent: string): string {
  const webkit = /AppleWebKit/i.test(userAgent) && !/Chrome|Chromium|Edg\//i.test(userAgent);
  return webkit ? "allow-same-origin allow-modals allow-scripts" : "allow-same-origin allow-modals";
}

/** The frame's Content-Security-Policy: whatever `base` says plus an explicit ban on scripts. */
export const frameCsp = (base: string): string => `${base}; script-src 'none'`;

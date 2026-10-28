// The static style of the message frame (ReadingPane.tsx) and of the document that is printed on macOS (printDoc.ts, W5.3): the font, the pictures, quotes, tables and the placeholders of
// pictures that are blocked or not loaded yet. Pure text, imports nothing. The confidential rules and the colours of the dark presentation are added by the frame only.

/** The box a blocked remote picture is drawn as (the frame, and the quote of the composer: editor/quoteNode.ts). */
export const BLOCKED_PICTURE_CSS = `.hl-bp{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;max-width:100%;box-sizing:border-box;overflow:hidden;border:1px dashed #9aa3af;border-radius:6px;background:#f6f7f9;color:#5b6470;font:12px/1.3 "Segoe UI",system-ui,sans-serif;vertical-align:middle;cursor:default}
.hl-bp-ico{flex:none;width:20px;height:20px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235b6470' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='18' height='18' rx='2'/%3E%3Ccircle cx='9' cy='9' r='2'/%3E%3Cpath d='m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21'/%3E%3C/svg%3E") center/contain no-repeat}.hl-bp-alt{max-width:100%;box-sizing:border-box;padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#5b6470}`;

/**
 * The reading pane's box of a picture it hides (1.0.10): a shield with a picture in it, "Picture hidden for privacy", a hint how to show it, the alt text. A button (role, tabindex),
 * not a broken image and not an error colour. Light and dark (the class of <html>), a focus ring for the keyboard only, quiet while printing.
 */
export const HIDDEN_PICTURE_CSS = `.hl-bpx{cursor:pointer;gap:2px;padding:6px;text-align:center;font:13px/1.3 "Segoe UI Variable","Segoe UI",system-ui,sans-serif;background:#f6f7f9;border:1px dashed #9aa3af;color:#4a525c;outline:none}
.hl-bpx:hover{background:#eceef2}.hl-bpx:focus-visible{outline:2px solid #3b6ea5;outline-offset:2px}
.hl-bpx .hl-bp-ico{width:32px;height:32px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%231f4f86' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath fill='%23dce8f6' d='M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'/%3E%3Crect x='8' y='9' width='8' height='6' rx='1'/%3E%3Cpath d='m8 14.5 2.5-2.2a1 1 0 0 1 1.3 0L16 15'/%3E%3C/svg%3E") center/contain no-repeat}
.hl-bpx[data-tier=mid] .hl-bp-ico{width:24px;height:24px}.hl-bpx[data-tier=small] .hl-bp-ico{width:20px;height:20px}
.hl-bp-main{display:block;max-width:100%;padding:0 6px;box-sizing:border-box;font-weight:600;font-size:13px}.hl-bp-hint{display:block;max-width:100%;padding:0 6px;box-sizing:border-box;font-size:12px;color:#5b6470}
.hl-bpx .hl-bp-alt{font-size:11px;color:#5b6470}
.hl-bpx[data-tier=mid] .hl-bp-hint,.hl-bpx[data-tier=mid] .hl-bp-alt,.hl-bpx[data-tier=small] .hl-bp-main,.hl-bpx[data-tier=small] .hl-bp-hint,.hl-bpx[data-tier=small] .hl-bp-alt{display:none}
.hl-bpx[data-tall=no] .hl-bp-alt{display:none}
.hl-bpx[data-pending]{opacity:.6;cursor:progress}.hl-bpx.bad{border-color:#c4314b;color:#c4314b}
a .hl-bpx{cursor:default}
@media print{.hl-bp-hint{display:none!important}.hl-bpx{cursor:default;outline:none}}`;

/** The dark presentation of that box (the screen frame only: a printed page is always light). */
export const HIDDEN_PICTURE_DARK_CSS = `html.hm-dark .hl-bpx{background:#262a30;border-color:#6b7280;color:#c3c9d1}html.hm-dark .hl-bpx:hover{background:#2d3239}html.hm-dark .hl-bpx:focus-visible{outline-color:#8fb4e3}
html.hm-dark .hl-bp-hint,html.hm-dark .hl-bpx .hl-bp-alt{color:#c3c9d1}html.hm-dark .hl-bpx .hl-bp-ico{background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a9c8f0' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath fill='%2333425a' d='M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'/%3E%3Crect x='8' y='9' width='8' height='6' rx='1'/%3E%3Cpath d='m8 14.5 2.5-2.2a1 1 0 0 1 1.3 0L16 15'/%3E%3C/svg%3E") center/contain no-repeat}`;

/** Everything up to the placeholders of blocked pictures. */
export const MAIL_FRAME_CSS = `body{font:14px/1.5 "Segoe UI Variable","Segoe UI",system-ui,sans-serif;margin:0;padding:10px 12px;word-wrap:break-word;background:var(--hm-bg);color:var(--hm-fg)}
img{max-width:100%;height:auto;cursor:zoom-in}blockquote{margin:0 0 0 .8ex;border-left:2px solid #999;padding-left:1ex}a{color:var(--hm-link)}table{max-width:100%}
.hl-ph{display:flex;align-items:center;gap:10px;max-width:100%;width:360px;padding:12px 14px;border:1px dashed #9aa3af;border-radius:10px;background:#f6f7f9;color:#5b6470;font:13px/1.4 "Segoe UI",sans-serif;cursor:pointer;text-align:left;box-sizing:border-box;flex-wrap:wrap}
.hl-ph:hover{background:#eceef2}.hl-ph b{color:#1f2328}.hl-ph.bad{border-color:#c4314b;color:#c4314b}.hl-ph:disabled{cursor:default}
${BLOCKED_PICTURE_CSS}
${HIDDEN_PICTURE_CSS}`;

/** The spinner of a picture that is being loaded (the frame only: nothing is loaded in a printed page). */
export const MAIL_FRAME_SPIN_CSS = `.hl-spin{width:14px;height:14px;border:2px solid #9aa3af;border-top-color:transparent;border-radius:50%;animation:hlspin 1s linear infinite;flex:none}@keyframes hlspin{to{transform:rotate(360deg)}}`;

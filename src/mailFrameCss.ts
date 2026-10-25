// The static style of the message frame (ReadingPane.tsx) and of the document that is printed on macOS (printDoc.ts, W5.3): the font, the pictures, quotes, tables and the placeholders of
// pictures that are blocked or not loaded yet. Pure text, imports nothing. The confidential rules and the colours of the dark presentation are added by the frame only.

/** The box a blocked remote picture is drawn as (the frame, and the quote of the composer: editor/quoteNode.ts). */
export const BLOCKED_PICTURE_CSS = `.hl-bp{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;max-width:100%;box-sizing:border-box;overflow:hidden;border:1px dashed #9aa3af;border-radius:6px;background:#f6f7f9;color:#5b6470;font:12px/1.3 "Segoe UI",system-ui,sans-serif;vertical-align:middle;cursor:default}
.hl-bp-ico{flex:none;width:20px;height:20px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235b6470' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='18' height='18' rx='2'/%3E%3Ccircle cx='9' cy='9' r='2'/%3E%3Cpath d='m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21'/%3E%3C/svg%3E") center/contain no-repeat}.hl-bp-alt{max-width:100%;box-sizing:border-box;padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#5b6470}`;

/** Everything up to the placeholders of blocked pictures. */
export const MAIL_FRAME_CSS = `body{font:14px/1.5 "Segoe UI Variable","Segoe UI",system-ui,sans-serif;margin:0;padding:10px 12px;word-wrap:break-word;background:var(--hm-bg);color:var(--hm-fg)}
img{max-width:100%;height:auto;cursor:zoom-in}blockquote{margin:0 0 0 .8ex;border-left:2px solid #999;padding-left:1ex}a{color:var(--hm-link)}table{max-width:100%}
.hl-ph{display:flex;align-items:center;gap:10px;max-width:100%;width:360px;padding:12px 14px;border:1px dashed #9aa3af;border-radius:10px;background:#f6f7f9;color:#5b6470;font:13px/1.4 "Segoe UI",sans-serif;cursor:pointer;text-align:left;box-sizing:border-box;flex-wrap:wrap}
.hl-ph:hover{background:#eceef2}.hl-ph b{color:#1f2328}.hl-ph.bad{border-color:#c4314b;color:#c4314b}.hl-ph:disabled{cursor:default}
${BLOCKED_PICTURE_CSS}`;

/** The spinner of a picture that is being loaded (the frame only: nothing is loaded in a printed page). */
export const MAIL_FRAME_SPIN_CSS = `.hl-spin{width:14px;height:14px;border:2px solid #9aa3af;border-top-color:transparent;border-radius:50%;animation:hlspin 1s linear infinite;flex:none}@keyframes hlspin{to{transform:rotate(360deg)}}`;

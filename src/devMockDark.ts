// Dev-only fixtures for the dark mail background (Dark A..F). Open them with the app in the dark theme and use the
// Sun / Moon button of the message to compare with the original colours.

const darkA = "<h2>Plain HTML</h2><p>No colours at all: a <a href='https://example.com'>link</a>, <b>bold</b>, <i>italic</i> and a list:</p><ul><li>one</li><li>two</li></ul><blockquote>Quoted text</blockquote><hr><table border='1'><tr><td>cell</td><td>cell</td></tr></table>";

// NB: sanitizeHtml returns the body only, so <head><style> and <body> attributes of a real mail never reach the frame; the style block is therefore inside the body here.
const darkB = `<div></div><style>
.outer{background:#e9e9ee}.card{background:#ffffff;border:1px solid #d0d0d8;border-radius:6px}.hd{background:linear-gradient(135deg,#ffe28a,#ff9a9e);color:#3a2a00;padding:22px}
.hd2{background:radial-gradient(circle at 20% 20%,#cfe8ff,#7db4f0);color:#08243f;padding:12px}
.muted{color:#767676}.cta{display:inline-block;background:#0f6cbd;color:#fff;padding:9px 18px;border-radius:4px;text-decoration:none}.cta2{display:inline-block;background:#f0f0f0;color:#222;padding:9px 18px;border:1px solid #bbb;text-decoration:none}
.zebra tr:nth-child(even) td{background:#f2f2f2}.zebra td{padding:6px 10px;border-bottom:1px solid #ddd}.warn{background:#fff4ce;border-left:4px solid #b88700;padding:8px 12px;color:#4d3800}
</style><body text="#222222" link="#0645ad" vlink="#6a3fa0" bgcolor="#e9e9ee">
<table class="outer" width="100%" cellpadding="0" cellspacing="0" bgcolor="#e9e9ee" style="background:#e9e9ee"><tr><td align="center" style="padding:16px">
<table class="card" width="560" style="width:560px;max-width:100%;background:#fff" bgcolor="#ffffff"><tr><td class="hd"><h1 style="margin:0;font-size:24px;color:#3a2a00">Designed newsletter</h1><div style="font-size:13px;color:#6b5200">Gradient header with dark text</div></td></tr>
<tr><td style="padding:18px 22px;color:#333;font-size:15px">
<p style="color:#111">Regular dark paragraph with a <a href="https://example.com" style="color:#0b5cad">coloured link</a> and a <a href="https://example.com" style="color:#b3261e">red link</a>.</p>
<p>Highlights: <span style="background:#fff59d;color:#000">yellow</span> <span style="background-color:#f8bbd0;color:#5a0030">pink</span> <span style="background:#c8e6c9;color:#14401a">light green</span> <mark>default mark</mark> <span style="background:#222;color:#fff">white on black</span></p>
<p><font color="#cc0000">font red</font>, <font color="#006600" face="Georgia">font green</font>, <font color="#000080">font navy</font>, <font color="#888888">font grey</font>, <font color="#ff00ff">font magenta</font></p>
<p class="muted">Muted grey text (#767676)</p><p style="color:rgba(0,0,0,.55)">Translucent black text</p>
<div class="warn">Notice box with pale yellow background and a dark amber border.</div><br>
<a class="cta" href="https://example.com">Dark button</a> &nbsp; <a class="cta2" href="https://example.com">Light button</a> &nbsp; <a href="https://example.com" style="background:#ffd54f;color:#000;padding:8px 14px;text-decoration:none;border-radius:20px">Amber pill</a>
<hr style="border:0;border-top:1px solid #ccc"><hr>
<blockquote style="margin:10px 0;padding:6px 14px;border-left:4px solid #999;background:#fafafa;color:#555">A blockquote with a light bar, light bg and grey text.</blockquote>
<div class="hd2" style="margin:12px 0">Radial gradient strip (blue) with navy text</div>
<table class="zebra" width="100%" cellspacing="0"><tr><th style="background:#e0e0e0;color:#000;padding:6px 10px" align="left">Item</th><th style="background:#e0e0e0;color:#000" align="right">Qty</th></tr><tr><td>Apples</td><td align="right">3</td></tr><tr><td>Pears</td><td align="right">5</td></tr><tr><td>Plums</td><td align="right">7</td></tr><tr><td>Figs</td><td align="right">9</td></tr></table>
<p>Inline code <code style="background:#eee;color:#c7254e;padding:2px 4px">npm run build</code></p>
<pre style="background:#f6f8fa;color:#24292f;border:1px solid #d0d7de;padding:10px;overflow:auto">function hello() {\n  return "world";\n}</pre>
<table width="100%" cellspacing="0" bgcolor="#0a3d62"><tr><td style="padding:12px;color:#ffffff">Brand deep blue footer (#0a3d62) with white text</td></tr></table>
<table width="100%" cellspacing="0" bgcolor="#0f6cbd"><tr><td style="padding:12px;color:#ffffff">Brand blue band (#0f6cbd) with white text and <a href="https://example.com" style="color:#cfe6ff">light link</a></td></tr></table>
</td></tr></table></td></tr></table>`;

const darkC = `<div style="background:#121212;padding:20px"><table width="100%" style="background:#1e1e1e;border:1px solid #333"><tr><td style="padding:16px;color:#eeeeee;font-family:Arial">
<h2 style="color:#ffffff;margin:0 0 8px">Already a dark design</h2><p style="color:#b0b0b0">Light grey text on a dark card. <a href="https://example.com" style="color:#8ab4f8">Light-blue link</a>.</p>
<p><span style="background:#3c3c00;color:#fff176">dark highlight</span> <span style="background:#00334d;color:#9fd8ff">blue chip</span></p>
<a href="https://example.com" style="background:#8ab4f8;color:#0b1b30;padding:8px 14px;text-decoration:none">Light button, dark label</a></td></tr></table></div>`;

const darkD = `<p style="color:#000000">Pure black text on no background at all (transparent).</p><p style="color:#222">Near black #222 text.</p>
<div style="background:#ffffff;padding:14px"><p style="color:#cfcfcf;margin:0">Very light grey (#cfcfcf) text on white: contrast 1.6 originally.</p><p style="color:#e8e8e8">Even lighter #e8e8e8 text on white.</p><p style="color:#9a9a9a">Grey #9a9a9a on white.</p></div>
<p style="color:#0000ee">Default-blue style link colour text.</p>`;

const darkE = (svg0: (w: number, h: number, c: string) => string) => { const svg = (w: number, h: number, c: string) => svg0(w, h, c).replace(/'/g, "%27"); return `<table width="100%" cellspacing="0"><tr><td background="${svg(600, 160, "#6a994e")}" bgcolor="#2d4a1f" style="background:#2d4a1f url('${svg(600, 160, "#6a994e")}') center/cover no-repeat;padding:30px;color:#ffffff;font-size:22px" height="160">Headline over a photo (fallback colour dark green)</td></tr>
<tr><td style="background-image:url('${svg(600, 120, "#e8d9a0")}');background-color:#e8d9a0;padding:24px;color:#222">Dark text over a light picture with a light fallback colour</td></tr></table>
<p><img src="${svg(300, 100, "#c60")}" width="300" height="100" alt="orange banner image"> <img alt="Broken image alt text" width="160" height="40" src="data:image/png;base64,AAAA" style="background:#fff;color:#000"></p>`; };

const dataSvg = (w: number, h: number, inner: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${inner}</svg>`).replace(/'/g, "%27")}`;
const logoDark = dataSvg(230, 60, '<circle cx="30" cy="30" r="22" fill="#10264a"/><text x="62" y="38" font-size="26" font-family="Georgia" fill="#10264a">Acme Co</text>');
const logoWhite = dataSvg(230, 60, '<circle cx="30" cy="30" r="22" fill="#ffffff"/><text x="62" y="38" font-size="26" font-family="Georgia" fill="#ffffff">Acme Co</text>');
const logoColour = dataSvg(230, 60, '<circle cx="30" cy="30" r="22" fill="#e8590c"/><text x="62" y="38" font-size="26" font-family="Georgia" fill="#e8590c">Acme Co</text>');
const signature = dataSvg(240, 80, '<path d="M10 55 C 30 5, 50 5, 60 40 S 90 70, 110 30 S 150 10, 170 50 L 230 40" fill="none" stroke="#1a1a1a" stroke-width="4"/>');
const photo = dataSvg(200, 80, '<rect width="200" height="80" fill="#2a6f97"/><text x="10" y="46" font-size="20" fill="#ffffff">photo 200x80</text>');
const darkG = `<p>Dark logo, transparent background (gets a light chip): <img src="${logoDark}" width="230" height="60" alt="Acme dark logo"></p>
<p>White logo, transparent (no chip): <img src="${logoWhite}" width="230" height="60" alt="Acme white logo"></p>
<p>Colour logo, transparent (no chip): <img src="${logoColour}" width="230" height="60" alt="Acme colour logo"></p>
<p>Opaque image (no chip): <img src="${photo}" width="200" height="80" alt="photo"></p>
<p>Handwritten signature, dark on transparent:<br><img src="${signature}" width="240" height="80" alt="signature"></p><p style="color:#444">Regards, A. Sender</p>`;

const darkF = "Plain text mail.\n\nSecond paragraph with a link https://example.com and an indented line:\n    indented\n\n> quoted line\n-- \nSignature";

/** Thread rows for the list (same shape as the mock's `t`). */
export const darkThreadRows = [
  ["dk1", "Dark A: plain simple HTML", "Plain HTML without any colour.", 8],
  ["dk2", "Dark B: designed newsletter", "White card, highlights, font tags, style classes, gradient, zebra table, code.", 9],
  ["dk3", "Dark C: already dark design", "Dark background with light text: must stay as it is.", 10],
  ["dk4", "Dark D: black on none, pale grey on white", "Low contrast originally.", 11],
  ["dk5", "Dark E: image and text overlay", "Background image with a fallback colour and text on it.", 12],
  ["dk6", "Dark F: plain text only", "Plain text mail without html.", 13],
  ["dk7", "Dark G: logos and signature images", "Transparent PNG/SVG images with dark artwork.", 14],
] as const;

/** Messages by thread id; `base` is a complete message to copy the other fields from. */
export function darkMessages(base: Record<string, unknown>, svg: (w: number, h: number, c: string) => string): Record<string, unknown[]> {
  const mk = (n: string, id: string, subject: string, html: string | null, text: string | null) => [{ ...base, id, subject, fromName: "Dark fixtures", fromEmail: `${n}@dark.example`, html, text, attachments: [], canUnsubscribe: false }];
  return {
    dk1: mk("a", "md1", darkThreadRows[0][1], darkA, "Plain HTML"),
    dk2: mk("b", "md2", darkThreadRows[1][1], darkB, "Designed"),
    dk3: mk("c", "md3", darkThreadRows[2][1], darkC, "Dark"),
    dk4: mk("d", "md4", darkThreadRows[3][1], darkD, "Low contrast"),
    dk5: mk("e", "md5", darkThreadRows[4][1], darkE(svg), "Overlay"),
    dk7: mk("g", "md7", darkThreadRows[6][1], darkG, "Logos"),
    dk6: mk("f", "md6", darkThreadRows[5][1], null, darkF),
  };
}

// What the website's <head> says to search engines and social sites: Open Graph, Twitter card, icons and JSON-LD.
// Used by scripts/generate-site-languages.mjs (writes the block between <!-- hl:seo-begin --> and <!-- hl:seo-end -->) and by
// scripts/test-site-seo.mjs. Nothing here is typed by hand per page: the title and description are read from the page itself (they are the
// translator's text, in the page), everything else is derived, so a page and its preview can never disagree.
// No import from the generator (it imports this file): it passes what it knows in `ctx` = { langs, pages, site, urlOf }.

export const BRAND = 'Hey Look!';
export const REPO = 'https://github.com/thnonl/hey-look';
export const OG_IMAGE_PATH = 'assets/og-image.jpg';
export const OG_SIZE = { width: 1200, height: 630 };
export const SCREENSHOT_PATH = 'media/poster-1280.webp'; // the sharper poster of the film (media/poster.webp, 768 px, is the one in the HTML)

// Open Graph locale per language folder, and the alt text of the preview picture (it shows the app window and the English words "Mail without the rent")
export const LOCALE = { en: 'en_US', vi: 'vi_VN', fr: 'fr_FR', zh: 'zh_CN', es: 'es_ES', ja: 'ja_JP', de: 'de_DE', ru: 'ru_RU' };
export const OG_ALT = {
  en: 'The Hey Look! mail app window showing an inbox, next to the words “Mail without the rent”.',
  vi: 'Cửa sổ ứng dụng thư Hey Look! với hộp thư đến, cạnh dòng chữ “Mail without the rent”.',
  fr: 'La fenêtre du client de messagerie Hey Look! avec une boîte de réception, et le slogan anglais « Mail without the rent ».',
  zh: 'Hey Look! 邮件客户端窗口，显示收件箱，旁边是英文标语“Mail without the rent”。',
  es: 'La ventana del cliente de correo Hey Look! con una bandeja de entrada y el lema en inglés «Mail without the rent».',
  ja: '受信トレイを表示したHey Look!のメールクライアントの画面と、英語のキャッチコピー「Mail without the rent」。',
  de: 'Das Fenster des Mailclients Hey Look! mit Posteingang und dem englischen Slogan „Mail without the rent“.',
  ru: 'Окно почтового клиента Hey Look! с папкой «Входящие» и английским слоганом «Mail without the rent».',
};

const ENTITIES = { nbsp: ' ', amp: '&', quot: '"', lt: '<', gt: '>', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', copy: '©', bdquo: '„' };
export const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return e.toLowerCase() in ENTITIES ? ENTITIES[e.toLowerCase()] : m;
});
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// JSON that is safe inside <script type="application/ld+json"> (no "</script>", no "<!--")
const jsonLd = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

/** the page's own <title>, meta description and (first) <h1> text, entities decoded */
export function pageMeta(text) {
  const title = (/<title>([^<]*)<\/title>/.exec(text) || [])[1];
  const desc = (/<meta name="description" content="([^"]*)"/.exec(text) || [])[1];
  if (title == null || desc == null) throw new Error('page has no <title> or <meta name="description">');
  return { title: decode(title), description: decode(desc) };
}
/** "Features - Hey Look!" -> "Features" (the brand is last; the dash is - or the em dash) */
export const pageName = (title) => title.replace(/\s*[-—–]\s*Hey Look!$/, '').trim();
/** the version the English home page shows (<span data-version>1.0.9</span>); the live page replaces it with the latest release */
export const versionOf = (englishIndexText) => (/<span data-version>([^<]+)<\/span>/.exec(englishIndexText) || [])[1];

/** JSON-LD objects for one page (an array: one <script> each is not needed, they go into one @graph) */
export function graphFor(ctx, lang, page, text, version) {
  const { langs, site, urlOf } = ctx;
  const { description } = pageMeta(text);
  const home = urlOf(lang, 'index'), url = urlOf(lang, page);
  const out = [];
  if (page === 'index') {
    out.push({ '@type': 'WebSite', '@id': home + '#site', url: home, name: BRAND, inLanguage: lang.hreflang });
  }
  if (page === 'index' || page === 'download') {
    out.push({
      '@type': 'SoftwareApplication', '@id': home + '#app', name: BRAND, url, description,
      applicationCategory: 'CommunicationApplication', applicationSubCategory: 'Email client',
      operatingSystem: 'Windows 10 or later, macOS 11 or later, Linux',
      softwareVersion: version, isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      downloadUrl: REPO + '/releases/latest', license: REPO + '/blob/main/LICENSE',
      author: { '@type': 'Person', name: 'thnonl', url: 'https://github.com/thnonl' },
      sameAs: [REPO], inLanguage: langs.map((l) => l.hreflang),
      image: site + OG_IMAGE_PATH,
      // the picture of the app window is on the home page (the film's poster); the download page does not show it
      ...(page === 'index' ? { screenshot: site + SCREENSHOT_PATH } : {}),
    });
  }
  // No BreadcrumbList: no page shows a breadcrumb trail, and structured data must describe what the page shows
  return out;
}

/** the generated block (markers added by the caller): robots, Open Graph, Twitter card, icons, JSON-LD */
export function seoLines(ctx, lang, page, text, version) {
  const { langs, site, urlOf } = ctx;
  const { title, description } = pageMeta(text);
  const up = lang.dir ? '../' : '';
  const img = site + OG_IMAGE_PATH, alt = OG_ALT[lang.code];
  const m = (k, v, kind = 'property') => `<meta ${kind}="${k}" content="${esc(v)}">`;
  const lines = [
    '<meta name="robots" content="index, follow, max-image-preview:large">',
    m('og:type', 'website'), m('og:site_name', BRAND), m('og:title', title), m('og:description', description), m('og:url', urlOf(lang, page)),
    m('og:locale', LOCALE[lang.code]), ...langs.filter((l) => l !== lang).map((l) => m('og:locale:alternate', LOCALE[l.code])),
    m('og:image', img), m('og:image:type', 'image/jpeg'), m('og:image:width', String(OG_SIZE.width)), m('og:image:height', String(OG_SIZE.height)), m('og:image:alt', alt),
    m('twitter:card', 'summary_large_image', 'name'), m('twitter:title', title, 'name'), m('twitter:description', description, 'name'), m('twitter:image', img, 'name'), m('twitter:image:alt', alt, 'name'),
    `<link rel="icon" href="${up}assets/icon-48.png" sizes="48x48" type="image/png">`,
    `<link rel="apple-touch-icon" href="${up}assets/apple-touch-icon.png">`,
  ];
  const graph = graphFor(ctx, lang, page, text, version);
  if (graph.length) { // the home page (WebSite + SoftwareApplication) and the download page (SoftwareApplication); the other pages carry none
    const doc = graph.length === 1 ? { '@context': 'https://schema.org', ...graph[0] } : { '@context': 'https://schema.org', '@graph': graph };
    lines.push('<script type="application/ld+json">', jsonLd(doc), '</script>');
  }
  return lines;
}

// Pages whose wording the owner approved as a rewrite of their own (copywriter tables, not a translation of the English page), so they no longer
// mirror docs/<page>.html one to one. Each entry lists exactly what differs, and the site tests accept exactly that and nothing else. A page is added
// here only together with its own approved rewrite; until then it must stay a mirror of the English one.
//
//   omitIds / addIds        ids of the English page that this page no longer has / ids this page has and the English page has not
//   omitLinks / addLinks    link targets (docs-relative path#fragment, with the language folder) of the English page this page no longer links to / links it has in addition
//   headingDelta            heading levels (2 = h2, 3 = h3) this page has more (+) or fewer (-) of than the English page
//   ceiling                 the unit ceiling of test-site-length.mjs for this page (the approved text is longer than factor x English)
//   titleBrandFirst         the title starts with the brand ("Hey Look! - ...") instead of ending with it; titleMax the widest title (test-site-seo.mjs; the description keeps the 160 limit)
//
// The home page (index) no longer has the "honest ledger" section: the limitations text now sits in features.html#limits, download.html (install notes) and help.html.
export const REWRITTEN = {
  vi: {
    index: {
      ceiling: 836, // hard limit = measured size of the final copy (BA 2026-11-01: 880 at most)
      titleBrandFirst: true, titleMax: 62,
    },
    features: {
      addLinks: ['vi/help.html#where', 'vi/help.html#folders'],
      ceiling: 1268, // hard limit = measured size of the final copy
    },
    download: {
      addIds: ['install-notes-h', 'install-windows', 'install-macos'],
      addLinks: ['vi/download.html#install-windows', 'vi/download.html#install-macos', 'vi/help.html#updates'],
      headingDelta: { 2: 1, 3: 1 },
      ceiling: 630, // hard limit = measured size of the final copy
    },
    help: {
      addIds: ['folders'],
      addLinks: ['vi/download.html#install-macos', 'vi/help.html#folders', 'vi/help.html#google-review'],
      ceiling: 1646, // hard limit = measured size of the final copy
    },
  },
};
const NONE = { omitIds: [], addIds: [], omitLinks: [], addLinks: [], headingDelta: {} };
export const rewritten = (code, page) => (REWRITTEN[code] && REWRITTEN[code][page] ? { ...NONE, ...REWRITTEN[code][page] } : null);
export const rewrittenHome = (code) => rewritten(code, 'index');

// English changed first, the other languages follow with their own rewrite: link targets (without language folder) that an English page has and the other languages' page does not have yet.
export const ENGLISH_AHEAD = {};

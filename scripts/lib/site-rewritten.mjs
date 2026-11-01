// Home pages whose wording the owner approved as a rewrite of their own (copywriter table, not a translation of the English page), so they no longer
// mirror docs/index.html one to one. Each entry lists exactly what differs, and the site tests accept exactly that and nothing else. A language is added
// here only together with its own approved rewrite; until then its home page must stay a mirror of the English one.
//
//   omitIds       ids of the English home page that this home page no longer has (the "honest ledger" section moved to features.html#limits and download.html)
//   omitLinks     link targets (docs-relative path#fragment, with the language folder) of the English page that this page no longer links to
//   headingDelta  heading levels (2 = h2, 3 = h3) this page has fewer of than the English page, as a negative count per level
//   ceilingIndex  the unit ceiling of test-site-length.mjs for this home page (the approved text is longer than factor x English)
//   titleBrandFirst  the title starts with the brand ("Hey Look! - ...") instead of ending with it; titleMax / descMax the widest title / description (test-site-seo.mjs)
export const REWRITTEN_HOME = {
  vi: {
    omitIds: ['honest', 'ledger-h', 'not-yet'],
    omitLinks: ['vi/features.html#limits'],
    headingDelta: { 2: -1, 3: -2 },
    ceilingIndex: 880,
    titleBrandFirst: true, titleMax: 62, descMax: 200,
  },
};
export const rewrittenHome = (code) => REWRITTEN_HOME[code] || null;

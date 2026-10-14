// The links at the bottom of Settings > About (opened through openUpdateLink, which reports an open that fails).
// Imports nothing, so a plain Node script can test it (scripts/test-about-links.mjs).

export interface AboutLink {
  text: string;
  url: string;
}

export const ABOUT_LINKS: readonly AboutLink[] = [
  { text: "Website", url: "https://thnonl.github.io/hey-look/" },
  { text: "Buy me a coffee", url: "https://thnonl.github.io/hey-look/support.html" },
  { text: "Source code", url: "https://github.com/thnonl/hey-look" },
];

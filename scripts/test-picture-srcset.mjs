// 1.0.11: srcset of a mail's pictures (src/pictureSrcset.ts). A picture is shown from the data: URI of its src; a srcset left beside it made the webview fetch the remote candidates itself
// (broken picture). The pure part: the first candidate of a srcset, with leading white space, 1.5x / 2x candidates, no candidate. The DOM part (sanitizeHtml blocked and allowed, <picture><source>,
// Show pictures, Show all, Show this picture) is scripts/test-picture-srcset-ui.mjs.
// Run: node --experimental-strip-types scripts/test-picture-srcset.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { firstSrcsetUrl, pictureAddress, remoteUrl } from "../src/pictureSrcset.ts";

// the template of the newsletter that broke: the srcset starts with white space
const logo = "   https://news.example.test/img/logo.png,   https://news.example.test/img/logo_2x.png 1.5x, https://news.example.test/img/logo_2x.png 2x";
assert.equal(firstSrcsetUrl(logo), "https://news.example.test/img/logo.png", "leading spaces, first candidate without a descriptor, followed by a comma");
assert.equal(firstSrcsetUrl("  https://a.test/top.jpg,  https://a.test/top_2x.jpg 1.5x"), "https://a.test/top.jpg");
assert.equal(firstSrcsetUrl("https://a.test/x.png 1x, https://a.test/x2.png 2x"), "https://a.test/x.png", "a descriptor after the first address");
assert.equal(firstSrcsetUrl("\n\t https://a.test/x.png\n 480w, https://a.test/y.png 800w"), "https://a.test/x.png", "tabs, new lines, a width descriptor");
assert.equal(firstSrcsetUrl(", ,https://a.test/x.png"), "https://a.test/x.png", "empty candidates before it");
assert.equal(firstSrcsetUrl("//a.test/x.png, //a.test/x2.png 2x"), "//a.test/x.png", "protocol-relative");
assert.equal(firstSrcsetUrl("https://a.test/x,y.png 2x"), "https://a.test/x,y.png", "a comma inside the address belongs to it");
assert.equal(firstSrcsetUrl(""), "");
assert.equal(firstSrcsetUrl("   "), "");
assert.equal(firstSrcsetUrl(" , "), "");
assert.equal(firstSrcsetUrl(null), "");
assert.equal(firstSrcsetUrl(undefined), "");

assert.equal(remoteUrl(" https://a.test/x.png "), "https://a.test/x.png");
assert.equal(remoteUrl("HTTP://a.test/x.png"), "HTTP://a.test/x.png");
assert.equal(remoteUrl("//a.test/x.png"), "https://a.test/x.png");
assert.equal(remoteUrl("cid:abc"), "");
assert.equal(remoteUrl("data:image/png;base64,AA"), "");
assert.equal(remoteUrl(null), "");

// the address of a picture: its src, else the first candidate of its srcset
assert.equal(pictureAddress("https://a.test/x.png", logo), "https://a.test/x.png", "src wins");
assert.equal(pictureAddress(null, logo), "https://news.example.test/img/logo.png", "no src: the srcset");
assert.equal(pictureAddress("  ", logo), "https://news.example.test/img/logo.png", "a blank src is no src");
assert.equal(pictureAddress(null, null), "");

// the wiring is in place (the behaviour itself: test-picture-srcset-ui.mjs)
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.match(read("src/util.ts"), /firstSrcsetUrl\(ss\)/, "sanitizeHtml reads the srcset");
assert.doesNotMatch(read("src/util.ts"), /\["src", "background", "srcset"\]/, "srcset is no longer left to the loop that needs a bare address");
assert.match(read("src/components/ReadingPane.tsx"), /dropSrcsets\(doc\)/, "inlineImages drops the srcset beside the data: URI");
assert.match(read("src/components/ReadingPane.tsx"), /pictureAddress\(i\.getAttribute\("src"\), i\.getAttribute\("srcset"\)\)/, "remoteImageUrls takes the first candidate when src is missing");

assert.ok(read("src/components/ReadingPane.tsx").includes("settleSources(doc, cachedImage)"), "inlineImages keeps a dark-mode <source> with the data: URI of its fetched picture");
assert.ok(read("src/components/ReadingPane.tsx").includes("isSchemeSource(s)"), "the dark-mode <source> pictures are fetched too");

console.log("test-picture-srcset: ok");

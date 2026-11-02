// Avatar initials: letters and digits only (1.0.12: "Emoji 🎉 Sender 🚀" showed "E" and a box). Run: node --experimental-strip-types scripts/test-initials.mjs
import assert from 'node:assert/strict';
import { initials } from '../src/initials.ts';

const is = (name, want, why) => assert.equal(initials(name), want, `${why ?? name}: ${JSON.stringify(initials(name))}`);
is('Emoji 🎉 Sender 🚀', 'ES', 'an emoji as 2nd word and at the end');
is('Emoji 🎉 Sender', 'ES', 'an emoji as 2nd word');
is('🎉 Party Time', 'PT', 'an emoji first');
is('🎉🚀', '?', 'only emoji');
is('🇻🇳 Vietnam', 'V', 'a flag first, one word with letters');
is('Nam 🇻🇳', 'N', 'a flag last');
is('👩‍💻 Dev', 'D', 'a ZWJ sequence');
is('★ Star ✓', 'S', 'symbols');
is('Linh Tran', 'LT');
is('Linh Van Tran', 'LT', 'first and last word');
is('A', 'A');
is('a', 'A');
is('', '?');
is('   ', '?');
is('<a@b.test>', '?', 'only an address in brackets (the caller has no other name)');
is('Nam <nam@x.test>', 'N', 'a name with its address');
is('Nguyễn Văn Ế', 'NẾ', 'Vietnamese, precomposed');
is('Nguyễn Van', 'NV', 'Vietnamese, accents written after the letter');
is('Ê Van', 'ÊV', 'the accent stays with its letter');
is('Иван Петров', 'ИП', 'Russian');
is('山田 太郎', '山太', 'CJK, two words');
is('山田太郎', '山', 'CJK, one word');
is('田中 🎉', '田', 'CJK and an emoji');
is('9 Lives', '9L', 'a digit');
is('😀', '?', 'a single emoji');
// no half of a surrogate pair ever comes out
for (const n of ['𝒜 Name', '𠮷野 家', 'x 𝔹', '🎉']) assert.ok(!/[\ud800-\udfff]/.test(initials(n).replace(/[\u{10000}-\u{10ffff}]/gu, '')), `a lone surrogate in ${JSON.stringify(initials(n))}`);
console.log('test-initials: ok');

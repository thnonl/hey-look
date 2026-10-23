// 1.0.7 W13.8 (REQ-13.8.1, 13.8.7, 13.8.8; AC-13.8.8, AC-13.8.10): the new-mail sound, without a browser.
//   - scripts/gen-notify-sound.mjs makes src-tauri/sounds/new-mail.wav byte for byte (the file is the one the owner approved: 30,914 bytes, SHA-256 below), twice the same;
//   - the format of the file: WAV, 44.1 kHz, 16-bit, mono, 0.35 s, peak at most -3 dBFS, RMS about -19 dBFS;
//   - the stored setting is read as the new one (src/notifySound.ts): none -> off, mail / default / im / reminder / sms -> on, an unknown value -> on; mergePrefs applies it to "All accounts" and to
//     every mailbox's own value; the default is on;
//   - the old choices and the hint are gone from Settings and from the 8 dictionaries; the three new texts are there (spec-107-wp13 section 3, keys 7 to 9);
//   - the wiring: the command is granted in the three places (generate_handler!, APP_COMMANDS, capabilities/default.json), not to the secondary windows; the Cargo feature; the file is binary for git.
// Run: node --experimental-strip-types scripts/test-notify-sound.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { APPROVED_SHA256, generate, pop } from "./gen-notify-sound.mjs";
import { normNotifySound } from "../src/notifySound.ts";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8").replace(/\r\n/g, "\n");
const sha = (b) => createHash("sha256").update(b).digest("hex");

// ---- the file
const committed = readFileSync(new URL("src-tauri/sounds/new-mail.wav", ROOT));
assert.equal(APPROVED_SHA256, "13d5defb4accc177aefca80270bbb0fb68b318b657f4e216ec07d6148e6de4ad");
assert.equal(committed.length, 30914, "size");
assert.equal(sha(committed), APPROVED_SHA256, "the committed sound is the approved sample");
const made = generate();
assert.ok(made.equals(committed), "the generator reproduces the committed file byte for byte");
assert.ok(generate().equals(made), "and the same bytes on a second run");
assert.ok(committed.length < 40 * 1024, "AC-13.8.10: the installer grows by less than 40 KB");

// ---- its format and level
assert.equal(committed.toString("ascii", 0, 4), "RIFF");
assert.equal(committed.toString("ascii", 8, 12), "WAVE");
assert.equal(committed.readUInt16LE(20), 1, "PCM");
assert.equal(committed.readUInt16LE(22), 1, "mono");
assert.equal(committed.readUInt32LE(24), 44100, "44.1 kHz");
assert.equal(committed.readUInt16LE(34), 16, "16-bit");
assert.equal(committed.readUInt32LE(40), committed.length - 44);
{
  const n = committed.readUInt32LE(40) / 2;
  let peak = 0, sum = 0;
  for (let i = 0; i < n; i++) { const v = committed.readInt16LE(44 + i * 2) / 32768; peak = Math.max(peak, Math.abs(v)); sum += v * v; }
  assert.ok(Math.abs(n / 44100 - 0.35) < 0.001, "0.35 s");
  assert.ok(20 * Math.log10(peak) <= -3 + 0.05, "peak at most -3 dBFS");
  assert.ok(Math.abs(10 * Math.log10(sum / n) + 19) < 0.1, "RMS about -19 dBFS");
  assert.equal(committed.readInt16LE(committed.length - 2), 0, "ends on silence");
  assert.equal(pop().length, n);
}

// ---- the setting (REQ-13.8.1, AC-13.8.8)
for (const [old, want] of [["none", "none"], ["mail", "pop"], ["default", "pop"], ["im", "pop"], ["reminder", "pop"], ["sms", "pop"], ["pop", "pop"], ["", "pop"], ["something else", "pop"], [undefined, "pop"], [null, "pop"], [5, "pop"]]) {
  assert.equal(normNotifySound(old), want, String(old));
}
const prefs = read("src/prefs.ts");
assert.ok(/notifySound: normNotifySound\(p\.notifySound\)/.test(prefs), "mergePrefs reads the stored value of All accounts");
assert.ok(/if \("notifySound" in n\) n\.notifySound = normNotifySound\(n\.notifySound\)/.test(prefs), "and the own value of every mailbox");
assert.ok(/notifySound: "pop",/.test(prefs), "on by default");
assert.ok(!/NOTIFY_SOUNDS/.test(prefs + read("src/components/SettingsDialog.tsx")), "the list of sounds is gone");
assert.ok(!/SoundSelect/.test(read("src/components/SettingsDialog.tsx")), "the select is gone");

// ---- the texts
const dicts = ["ns", ...["vi", "fr", "zh-Hans", "es", "ja", "de", "ru"].map((l) => `locales/${l}`)];
const file = (d) => read(`src/i18n/${d}/settings.ts`);
for (const d of dicts) {
  const s = file(d);
  for (const k of ["settings.notify.soundHint", "settings.sound.mail", "settings.sound.im", "settings.sound.reminder", "settings.sound.sms", "settings.sound.silent"]) assert.ok(!s.includes(`"${k}"`), `${d}: ${k} is retired`);
  assert.ok(s.includes('"settings.notify.soundOnHint"') && s.includes('"settings.notify.playSound"') && s.includes('"settings.notify.playFailed"'), `${d}: the three new keys`);
  assert.ok(!read(`src/i18n/${d}/common.ts`).includes('"common.default"'), `${d}: common.default was only the label of a sound`);
}
const texts = {
  "settings.notify.playSound": { ns: "Play sound", vi: "Phát thử", fr: "Écouter", "zh-Hans": "播放声音", es: "Reproducir", ja: "音を再生", de: "Ton testen", ru: "Прослушать" },
  "settings.notify.playFailed": { ns: "Couldn’t play the sound on this computer.", vi: "Không phát được âm thanh trên máy tính này.", fr: "Impossible de lire le son sur cet ordinateur.", "zh-Hans": "无法在这台电脑上播放声音。", es: "No se pudo reproducir el sonido en este equipo.", ja: "このコンピューターで音を再生できませんでした。", de: "Der Ton konnte nicht abgespielt werden.", ru: "Не удалось воспроизвести звук на этом компьютере." },
};
for (const [k, byLang] of Object.entries(texts)) for (const [l, v] of Object.entries(byLang)) assert.ok(file(l === "ns" ? "ns" : `locales/${l}`).includes(`"${k}": ${JSON.stringify(v)}`), `${l} ${k}`);

// ---- the wiring
const lib = read("src-tauri/src/lib.rs");
assert.ok(/fn play_notify_sound\(/.test(lib) && /^\s+play_notify_sound,$/m.test(lib), "the command is in generate_handler!");
assert.ok(/"test_notification", "play_notify_sound"/.test(read("src-tauri/build.rs")), "and in APP_COMMANDS");
assert.ok(JSON.parse(read("src-tauri/capabilities/default.json")).permissions.includes("allow-play-notify-sound"), "and in the capability of the main window");
assert.ok(!JSON.parse(read("src-tauri/capabilities/popout.json")).permissions.includes("allow-play-notify-sound"), "not in the one of the secondary windows");
assert.ok(/"Win32_Media_Audio"/.test(read("src-tauri/Cargo.toml")), "the windows feature of PlaySoundW");
assert.ok(/^\*\.wav binary$/m.test(read(".gitattributes")), "no line-ending conversion of the sound");
const shell = read("src-tauri/src/shell.rs");
assert.ok(!/Sound::Mail|Sound::SMS|Sound::IM|Sound::Default/.test(shell), "the old Windows sounds are gone");
assert.ok(/notifysound::on_for\(&p, ""\)/.test(shell), "reminders, snoozes and the test follow the switch");

console.log("test-notify-sound: ok");

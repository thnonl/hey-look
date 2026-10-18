// The emoji picker's data (spec-rich-text.md REQ-40): 8 categories of 32 common emoji, no search. Each is a plain Unicode character or a variation sequence
// (no joined sequences: they would show as two pictures on a system that is a few years old). The names of the categories are dictionary keys
// (`compose.emoji.<id>`). In its own chunk (insertUi) with the picker: nothing of it is in the main bundle. Pure (no imports).

export interface EmojiGroup {
  id: "smileys" | "people" | "animals" | "food" | "travel" | "activities" | "objects" | "symbols";
  /** the first one is the tab's icon */
  emoji: readonly string[];
}

const list = (s: string): string[] => s.trim().split(/\s+/);

export const EMOJI_GROUPS: readonly EmojiGroup[] = [
  { id: "smileys", emoji: list("😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😋 😛 😜 🤪 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😢") },
  { id: "people", emoji: list("👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🖐️ 👋 🤚 👏 🙌 👐 🤝 🙏 ✍️ 💪 👀 👂 👃 🧠 👶 👦 👧 👨") },
  { id: "animals", emoji: list("🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦉 🦄 🐝 🦋 🐢 🐍 🐙 🐬 🐳 🌸 🌹 🌻 🌳") },
  { id: "food", emoji: list("🍎 🍌 🍇 🍓 🍉 🍊 🍋 🍒 🍑 🥭 🍍 🥑 🍅 🥕 🌽 🥐 🍞 🧀 🍳 🥞 🍔 🍟 🍕 🌭 🌮 🍣 🍜 🍩 🍪 🎂 ☕ 🍺") },
  { id: "travel", emoji: list("🚗 🚕 🚌 🚓 🚑 🚒 🚲 🛵 🚆 🚄 ✈️ 🚀 🛳️ ⛵ 🏠 🏢 🏥 🏫 ⛪ 🗽 🗼 🏰 ⛰️ 🏖️ 🌍 🌙 ⭐ ☀️ ⛅ ☔ ❄️ 🌈") },
  { id: "activities", emoji: list("⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 ⛳ 🥊 🎯 🎮 🎲 🧩 🎨 🎬 🎤 🎧 🎸 🎹 🥁 🎻 🏆 🥇 🥈 🥉 🏅 🎪 ♟️ 🎳") },
  { id: "objects", emoji: list("📱 💻 🖥️ ⌨️ 🖱️ 💾 📷 📞 📺 🔋 💡 🔦 📚 📖 📝 ✏️ 📎 📌 ✂️ 🔑 🔒 🔓 🔔 📧 📅 📊 📈 💼 🎁 💰 💳 ⏰") },
  { id: "symbols", emoji: list("❤️ 🧡 💛 💚 💙 💜 🖤 💔 ✅ ❌ ❗ ❓ ⚠️ ✔️ ➕ ➖ ➡️ ⬅️ ⬆️ ⬇️ 🔥 ✨ 💯 🎉 🎊 💥 💤 ♻️ 🔴 🟢 🔵 ⭕") },
];

/** The system's own emoji panel: its shortcut, for the hint under the grid. Linux has no one shortcut of its own (null: no hint). */
export function osEmojiKeys(os: string): string | null {
  return os === "windows" ? "Win + ." : os === "macos" ? "Ctrl + Cmd + Space" : null;
}

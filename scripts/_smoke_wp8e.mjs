import { buildIndex, searchSettings } from "../src/settingsIndex.ts";
import { LANGUAGES, loadLanguage, setLangPref } from "../src/i18n/index.ts";
for (const l of LANGUAGES) {
  await loadLanguage(l.code); setLangPref(l.code);
  const idx = buildIndex({ os: "windows", tray: true, managed: false, notifyButtons: true, accounts: [], kbd: (s) => s });
  console.log(l.code, searchSettings(idx, "ＡＩ").slice(0, 5).map((h) => `${h.tier}:${h.entry.label}`));
}

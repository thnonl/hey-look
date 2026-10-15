import { ChevronDown, Globe } from "lucide-react";
import { LANGS, resolveLang } from "../i18n";
import type { Lang } from "../i18n";
import { useT } from "../i18n/react";
import { useStore } from "../store";
import { Dropdown } from "./ui";
import type { MenuItem } from "./ui";

/** More languages than this and the Welcome screen offers a menu instead of one button per language. */
export const CHIPS_MAX = 5;

/**
 * Every language control reads LANGS (src/i18n/languages.ts) and changes the same setting as Settings > General > Language
 * (`setPrefs({ language })`): the whole UI re-renders at once, the choice is saved, and the store mirrors it to the backend (tray
 * menu, notifications). The names are never translated: each language is written in itself, so a person who cannot read the current
 * language can still find theirs.
 */
function useLanguage(): { current: Lang; short: string; name: string; items: MenuItem[]; choose: (code: Lang) => void } {
  const pref = useStore((s) => s.prefs.language);
  const setPrefs = useStore((s) => s.setPrefs);
  const choose = (code: Lang) => code !== pref && setPrefs({ language: code });
  const current = resolveLang(pref);
  const entry = LANGS.find((l) => l.code === current);
  return {
    current,
    short: entry?.short ?? current,
    name: entry?.nativeName ?? current,
    choose,
    items: LANGS.map((l) => ({ label: l.nativeName, lang: l.code, search: l.englishName, checked: pref === l.code, onClick: () => choose(l.code) })),
  };
}

/** Top bar button (globe + short code, never wider than a fixed width) that opens the list of languages: scrolls, Arrow/Home/End/type-ahead. */
export function LanguageMenu() {
  const t = useT();
  const { short, name, items } = useLanguage();
  return (
    <Dropdown className="icon-btn lang-btn" title={t("app.top.languageCurrent", { name })} align="right" caret={false} items={items}>
      <Globe size={16} aria-hidden />
      <span className="lang-code" aria-hidden>{short}</span>
    </Dropdown>
  );
}

/** Language choice for the first-run screen: a button per language while there are few, else one button that opens the same menu. */
export function LanguageChoice() {
  const t = useT();
  const { name, items, choose } = useLanguage();
  const pref = useStore((s) => s.prefs.language);
  if (LANGS.length > CHIPS_MAX) {
    return (
      <div className="lang-choice">
        <Dropdown className="lang-opt lang-select" title={t("app.top.languageCurrent", { name })} caret={false} items={items}>
          <Globe size={15} aria-hidden />
          <span className="lang-name" lang={resolveLang(pref)}>{name}</span>
          <ChevronDown size={12} className="caret" aria-hidden />
        </Dropdown>
      </div>
    );
  }
  return (
    <div className="lang-choice" role="group" aria-label={t("app.top.language")}>
      <Globe size={15} aria-hidden />
      {LANGS.map((l) => (
        <button key={l.code} type="button" className={`lang-opt${pref === l.code ? " on" : ""}`} lang={l.code} aria-pressed={pref === l.code} onClick={() => choose(l.code)}>
          {l.nativeName}
        </button>
      ))}
    </div>
  );
}

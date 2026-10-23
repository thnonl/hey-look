// ru: the dictionary and the date-fns locale of the language, one chunk (loaded by loadLanguage in index.ts when the language is picked or saved).
import { ru as dfRu } from "date-fns/locale/ru";
import { ru } from "./locales/ru/index.ts";
import type { LangPack } from "./types.ts";

export default { dict: ru, df: dfRu } satisfies LangPack;

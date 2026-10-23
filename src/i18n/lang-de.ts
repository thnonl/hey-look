// de: the dictionary and the date-fns locale of the language, one chunk (loaded by loadLanguage in index.ts when the language is picked or saved).
import { de as dfDe } from "date-fns/locale/de";
import { de } from "./locales/de/index.ts";
import type { LangPack } from "./types.ts";

export default { dict: de, df: dfDe } satisfies LangPack;

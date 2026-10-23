// fr: the dictionary and the date-fns locale of the language, one chunk (loaded by loadLanguage in index.ts when the language is picked or saved).
import { fr as dfFr } from "date-fns/locale/fr";
import { fr } from "./locales/fr/index.ts";
import type { LangPack } from "./types.ts";

export default { dict: fr, df: dfFr } satisfies LangPack;

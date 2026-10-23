// ja: the dictionary and the date-fns locale of the language, one chunk (loaded by loadLanguage in index.ts when the language is picked or saved).
import { ja as dfJa } from "date-fns/locale/ja";
import { ja } from "./locales/ja/index.ts";
import type { LangPack } from "./types.ts";

export default { dict: ja, df: dfJa } satisfies LangPack;

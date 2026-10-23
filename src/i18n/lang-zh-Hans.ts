// zh-Hans: the dictionary and the date-fns locale of the language, one chunk (loaded by loadLanguage in index.ts when the language is picked or saved).
import { zhCN as dfZh } from "date-fns/locale/zh-CN";
import { zhHans } from "./locales/zh-Hans/index.ts";
import type { LangPack } from "./types.ts";

export default { dict: zhHans, df: dfZh } satisfies LangPack;

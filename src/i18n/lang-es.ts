// es: the dictionary and the date-fns locale of the language, one chunk (loaded by loadLanguage in index.ts when the language is picked or saved).
import { es as dfEs } from "date-fns/locale/es";
import { es } from "./locales/es/index.ts";
import type { LangPack } from "./types.ts";

export default { dict: es, df: dfEs } satisfies LangPack;

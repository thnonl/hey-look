// vi: the dictionary and the date-fns locale of the language, one chunk (loaded by loadLanguage in index.ts when the language is picked or saved).
import { vi as dfVi } from "date-fns/locale/vi";
import { vi } from "./locales/vi/index.ts";
import type { LangPack } from "./types.ts";

export default { dict: vi, df: dfVi } satisfies LangPack;

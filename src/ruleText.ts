// The words a rule is described with (the Settings list, the toasts after a run, the name a rule gets when the person gives none), 1.0.8.
import type { Rule, RuleCond, RuleField } from "./api";
import { t } from "./i18n";
import type { Key } from "./i18n";

/** How a field reads in the name of a rule: "from contains “x”". */
const FIELD_WORD: Record<RuleField, Key> = {
  from: "settings.filters.wFrom", to: "settings.filters.wTo", subject: "settings.filters.wSubject", any: "settings.filters.wAny",
  body: "settings.rules.kBody", subjectBody: "settings.rules.kSubjectBody",
};
const OP_WORD: Record<RuleCond["op"], Key> = { contains: "settings.filters.opContains", equals: "settings.filters.opEquals" };
export const ACTION_WORD: Record<Rule["action"], Key> = {
  archive: "settings.filters.wArchive", trash: "settings.filters.wTrash", junk: "settings.filters.wJunk", read: "settings.filters.wRead",
  star: "settings.filters.wStar", pin: "settings.filters.wPin", move: "settings.filters.wMove",
};

/** The condition in words: `from contains “x”` (several values: joined with a comma). */
export function condWords(c: RuleCond): string {
  return t("settings.filters.autoName", { field: t(FIELD_WORD[c.field] ?? FIELD_WORD.any), op: t(OP_WORD[c.op] ?? OP_WORD.contains), value: c.values.join(", ") });
}

/** The name of a rule in a list or a toast: the name the person gave, else its first condition in words. */
export function ruleTitle(r: Pick<Rule, "name" | "conditions">): string {
  return r.name.trim() || (r.conditions[0] ? condWords(r.conditions[0]) : "");
}

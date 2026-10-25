// Running a rule on the mail that is already there (1.0.8, REQ-7): "Also move the matching messages" in the rule dialog and "Run now" in Settings. The backend finds the conversations
// (`rule_targets`: local mail only, the newest 5,000 of the folder); the move is the app's own delayed move with Undo (`act`), one run per mailbox.
import { api } from "./api";
import type { Rule } from "./api";
import { t } from "./i18n";
import { accountHasFolder, canMoveToJunk } from "./junk";
import { folderLabelIn, folderTitle } from "./prefs";
import { inSecondaryWindow } from "./popout/route";
import { ruleTitle } from "./ruleText";
import { useStore } from "./store";

/** The folder a rule's move ends in (a role or a folder key), or null when the rule does not move mail. */
function ruleDestination(rule: Pick<Rule, "action" | "arg">): string | null {
  switch (rule.action) {
    case "archive": case "trash": case "junk": return rule.action;
    case "move": return rule.arg || null;
    default: return null;
  }
}

/** Folders that "also apply to the matching messages already in..." is not offered for: mail there is not "in the way". The destination itself is left out too. */
export function runSourceOk(folder: string, rule: Pick<Rule, "action" | "arg">): boolean {
  return !["drafts", "sent", "junk", "trash"].includes(folder) && ruleDestination(rule) !== folder;
}

/** Run the rule on the mail of `folder` (a folder key of every mailbox it applies to). Returns how many conversations it acted on. Errors are shown by the move itself. */
export async function runRule(rule: Rule, folder: string): Promise<number> {
  // the Settings window may not queue a move itself: the main window runs it (its Undo toast), and the number is not known here
  if (inSecondaryWindow()) {
    const { askMain } = await import("./popout/readerBridge");
    await askMain("rule-run", { rule, folder }, 120_000); // (a failure is shown by askMain)
    return 0;
  }
  const st = useStore.getState();
  const dest = ruleDestination(rule);
  if (dest !== null && dest === folder) return 0;
  const scan = await api.ruleTargets(rule, folder);
  let total = 0;
  for (const g of scan.groups) {
    // (a mailbox without the folder, or without Junk, is left out: the rule works wherever its folder is)
    if (rule.action === "junk" && !canMoveToJunk(st.folders, [g.accountId])) continue;
    if (rule.action === "move" && dest && !accountHasFolder(st.folders, g.accountId, dest)) continue;
    const n = g.threadIds.length;
    total += n;
    const name = ruleTitle(rule);
    if (dest !== null) {
      const f = st.folders.find((x) => x.accountId === g.accountId && x.key === dest);
      const where = () => (f ? folderTitle(f, st.folders) : folderLabelIn(st.folders, dest, g.accountId));
      await st.act(g.threadIds, rule.action === "move" ? "move" : rule.action, rule.action === "move" ? dest : undefined, () => t("settings.rules.moved", { name, n, folder: where() }), folder);
    } else {
      await st.act(g.threadIds, rule.action, undefined, () => t("settings.rules.applied", { name, n }), folder);
    }
  }
  return total;
}

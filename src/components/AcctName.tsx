import { accountLabel, Labelled } from "../accountLabel";
import { useT } from "../i18n/react";

/** The label of a mailbox: its display name with the address in the tooltip, else the address (see accountLabel.ts). Truncates with an ellipsis. */
export function AcctName({ account, className = "ellipsis" }: { account: Labelled; className?: string }) {
  const t = useT();
  const l = accountLabel(account);
  return (
    <span className={className} title={l.tip ?? undefined} aria-label={l.name ? t("mail.acct.labelAria", { name: l.name, email: account.email }) : undefined}>
      {l.text}
    </span>
  );
}

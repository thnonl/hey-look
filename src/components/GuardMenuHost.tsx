import { AtSign, Copy, ExternalLink, Link, TextSelect } from "lucide-react";
import { copyToClipboard } from "../open";
import { useT } from "../i18n/react";
import { closeGuardMenu, useGuardMenu } from "../contextGuard";
import { kbd } from "../platform";
import { useStore } from "../store";
import { ContextMenu, CtxItem } from "./ContextMenu";

/**
 * The app's menu for what the webview's own menu used to offer outside of fields that take text (see contextPolicy.ts for when it is shown):
 * the entries of a link, Copy and Select all of text, Copy of an address, and the same Copy / Select all for a read-only field.
 * Mounted once for every window (main.tsx): the main window and the pop-out windows.
 */
export function GuardMenuHost() {
  const t = useT();
  const menu = useGuardMenu((s) => s.menu);
  if (!menu) return null;
  const fail = () => useStore.getState().showToast(() => t("mail.ctx.copyFailed"), undefined, "error");
  const copy = (text: string) => void copyToClipboard(text).then((ok) => ok || fail());
  const link = menu.link;
  const mail = link ? /^mailto:/i.test(link.href) : false;
  const items: CtxItem[] = link
    ? [
        { label: t("reading.body.linkWarnConfirm"), icon: <ExternalLink size={14} />, onClick: link.open },
        { label: mail ? t("mail.ctx.copyEmail") : t("mail.link.copy"), icon: mail ? <AtSign size={14} /> : <Link size={14} />, onClick: () => copy(link.href.replace(/^mailto:/i, "").split("?")[0]) },
        ...(menu.text ? [{ divider: true }, { label: t("common.copy"), icon: <Copy size={14} />, hint: kbd("Ctrl+C"), onClick: () => copy(menu.text) }] : []),
      ]
    : [
        ...(menu.email ? [{ label: t("mail.ctx.copyEmail"), icon: <AtSign size={14} />, onClick: () => copy(menu.email!) }, { divider: true }] : []),
        // greyed (and still in the keyboard order) when nothing is selected: the entry is always where the person looks for it
        { label: t("common.copy"), icon: <Copy size={14} />, hint: kbd("Ctrl+C"), disabled: !menu.text, onClick: () => copy(menu.text) },
        ...(menu.selectAll ? [{ label: t("mail.ctx.selectAll"), icon: <TextSelect size={14} />, hint: kbd("Ctrl+A"), onClick: menu.selectAll }] : []),
      ];
  return <ContextMenu key={`${menu.at.x},${menu.at.y},${menu.keyboard}`} at={menu.at} items={items} label={t("mail.ctx.textMenu")} keyboard={menu.keyboard} returnTo={menu.returnTo} onClose={closeGuardMenu} />;
}

import { AtSign, Copy, ExternalLink, Link, Search, TextSelect, Type } from "lucide-react";
import { copyToClipboard } from "../open";
import { useT } from "../i18n/react";
import { closeGuardMenu, useGuardMenu } from "../contextGuard";
import { kbd } from "../platform";
import { searchMailHere } from "../searchSelection";
import { searchVia, selectionLabel } from "../selectionSearch";
import { useStore } from "../store";
import { ContextMenu, CtxItem } from "./ContextMenu";

/**
 * The app's menu for what the webview's own menu used to offer outside of fields that take text (see contextPolicy.ts for when it is shown):
 * the entries of a link, Copy and Select all of text, Copy of an address, and the same Copy / Select all for a read-only field. In the reading areas it also
 * offers "Copy subject" on the subject heading and "Search mail for ..." for selected text (W8.1).
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
  // the search of the selection: in the main window here, in a reader window through the checked request to the main page (readerBridge.ts)
  const search: CtxItem[] = menu.search
    ? [{ divider: true }, { label: t("mail.ctx.searchSelection", { text: selectionLabel(menu.search) }), icon: <Search size={14} />, onClick: () => (searchVia.run ?? searchMailHere)(menu.search!) }]
    : [];
  // the subject heading: the first entry, then a divider (with or without a selection)
  const subject: CtxItem[] = menu.subject !== null
    ? [{
        label: t("mail.ctx.copySubject"),
        icon: <Type size={14} />,
        onClick: () => void copyToClipboard(menu.subject!).then((ok) => (ok ? useStore.getState().showToast(() => t("reading.msg.copied"), undefined, "success") : fail())),
      }, { divider: true }]
    : [];
  const items: CtxItem[] = link
    ? [
        { label: t("reading.body.linkWarnConfirm"), icon: <ExternalLink size={14} />, onClick: link.open },
        { label: mail ? t("mail.ctx.copyEmail") : t("mail.link.copy"), icon: mail ? <AtSign size={14} /> : <Link size={14} />, onClick: () => copy(link.href.replace(/^mailto:/i, "").split("?")[0]) },
        ...(menu.text ? [{ divider: true }, { label: t("common.copy"), icon: <Copy size={14} />, hint: kbd("Ctrl+C"), onClick: () => copy(menu.text) }, ...search] : []),
      ]
    : [
        ...subject,
        ...(menu.email ? [{ label: t("mail.ctx.copyEmail"), icon: <AtSign size={14} />, onClick: () => copy(menu.email!) }, { divider: true }] : []),
        // greyed (and still in the keyboard order) when nothing is selected: the entry is always where the person looks for it
        { label: t("common.copy"), icon: <Copy size={14} />, hint: kbd("Ctrl+C"), disabled: !menu.text, onClick: () => copy(menu.text) },
        ...(menu.selectAll ? [{ label: t("mail.ctx.selectAll"), icon: <TextSelect size={14} />, hint: kbd("Ctrl+A"), onClick: menu.selectAll }] : []),
        ...search,
      ];
  return <ContextMenu key={`${menu.at.x},${menu.at.y},${menu.keyboard}`} at={menu.at} items={items} label={t("mail.ctx.textMenu")} keyboard={menu.keyboard} returnTo={menu.returnTo} onClose={closeGuardMenu} />;
}

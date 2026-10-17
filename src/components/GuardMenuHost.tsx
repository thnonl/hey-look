import { Copy, ExternalLink, Link } from "lucide-react";
import { copyToClipboard } from "../open";
import { useT } from "../i18n/react";
import { closeGuardMenu, useGuardMenu } from "../contextGuard";
import { useStore } from "../store";
import { ContextMenu, CtxItem } from "./ContextMenu";

/** The app's menu for what the webview's own menu used to offer on selected text and on links (see contextPolicy.ts for when it is shown). */
export function GuardMenuHost() {
  const t = useT();
  const menu = useGuardMenu((s) => s.menu);
  if (!menu) return null;
  const fail = () => useStore.getState().showToast(() => t("mail.ctx.copyFailed"), undefined, "error");
  const copy = (text: string) => void copyToClipboard(text).then((ok) => ok || fail());
  const link = menu.link;
  const items: CtxItem[] = [
    ...(link ? [
      { label: t("reading.body.linkWarnConfirm"), icon: <ExternalLink size={14} />, onClick: link.open },
      { label: t("mail.link.copy"), icon: <Link size={14} />, onClick: () => copy(link.href.replace(/^mailto:/i, "")) },
    ] : []),
    ...(menu.text ? [{ label: t("common.copy"), icon: <Copy size={14} />, onClick: () => copy(menu.text) }] : []),
  ];
  if (items.length === 0) return null;
  return <ContextMenu key={`${menu.at.x},${menu.at.y}`} at={menu.at} items={items} label={items[0].label} keyboard={false} returnTo={menu.returnTo} onClose={closeGuardMenu} />;
}

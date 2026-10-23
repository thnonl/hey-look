import { FormEvent, useEffect, useRef, useState } from "react";
import { accountLabel } from "../accountLabel";
import { api } from "../api";
import { parseCoded } from "../backendErrors";
import { checkFolderName, type NameProblem } from "../folderName";
import { collapsedKey } from "../folderTree";
import { useT } from "../i18n/react";
import { folderLabel } from "../prefs";
import { friendlyError, useStore } from "../store";
import { Modal } from "./ui";

// New folder / New subfolder (1.0.7 W13.10, REQ-13.10.4 to 13.10.7). Opened from the menu of a mailbox heading or of a folder of the person (FolderPane.tsx, AccountReorder.tsx). A chunk of its own
// (lazyViews.tsx). The name is checked while the person types and shown under the field after the first press of Create or when the field loses the focus; the server's refusals come back as coded
// errors and are shown in the same place, with the dialog still open.

const STANDARD = ["inbox", "drafts", "sent", "archive", "junk", "trash"];

export function FolderDialog({ accountId, parentKey }: { accountId: string; parentKey: string | null }) {
  const t = useT();
  const { accounts, folders, setDialog, addFolder, showToast, sync } = useStore();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; // (also after the second run of the effect in development)
    return () => void (alive.current = false);
  }, []);
  // the focus goes into the field one tick after the dialog is drawn: the menu that opened the dialog gives the focus back to its row as it closes, and Modal notes that row to return to
  useEffect(() => {
    const id = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(id);
  }, []);

  const account = accounts.find((a) => a.id === accountId);
  const mine = folders.filter((f) => f.accountId === accountId);
  const parent = parentKey ? mine.find((f) => f.key === parentKey) : undefined;
  const mailbox = account ? accountLabel(account).text : "";
  const where = parent ? `${parent.label ?? folderLabel(parent.key, parent.name)} — ${mailbox}` : mailbox;
  const delimiter = mine.find((f) => f.delimiter)?.delimiter ?? null;
  // what a new name must not repeat: the folders at the same level, and at the top level the standard folders by their server name and by the name the app shows
  const siblings = parentKey
    ? mine.filter((f) => f.parent === parentKey).map((f) => f.label ?? f.name)
    : [
        ...mine.filter((f) => f.key.startsWith("f:") && !f.depth).map((f) => f.label ?? f.name),
        ...mine.filter((f) => STANDARD.includes(f.key) && f.listed !== false).flatMap((f) => [f.label ?? f.name, folderLabel(f.key)]),
      ];
  const check = checkFolderName(name, delimiter, siblings);
  const problemText = (p: NameProblem): string =>
    p.kind === "empty" ? t("mail.folder.errEmpty")
    : p.kind === "long" ? t("mail.folder.errLong")
    : p.kind === "chars" ? t("mail.folder.errChars", { chars: p.chars })
    : p.kind === "reserved" ? t("mail.folder.errReserved")
    : t("mail.folder.errExists");
  const shown = server ?? (touched && check.problem ? problemText(check.problem) : null);

  /** The words for what the backend answered: its coded refusals, else the app's friendly text. */
  const serverText = (e: unknown): string => {
    const raw = String(e).replace(/^Error:\s*/, "").trim();
    const c = parseCoded(raw);
    if (c?.code === "FOLDER_EXISTS") return t("mail.folder.errExists");
    if (c?.code === "FOLDER_NOPERM") return t("mail.folder.errNoPerm");
    if (c?.code === "FOLDER_NAME") {
      const r = c.params.reason;
      if (r === "empty") return t("mail.folder.errEmpty");
      if (r === "long") return t("mail.folder.errLong");
      if (r === "chars") return t("mail.folder.errChars", { chars: c.params.chars ?? "" });
      if (r === "reserved") return t("mail.folder.errReserved");
    }
    return t("mail.folder.errFailed", { error: c ? c.text : friendlyError(e) });
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setTouched(true);
    if (check.problem) {
      input.current?.focus();
      return;
    }
    setServer(null);
    setBusy(true);
    try {
      const info = await api.createMailFolder(accountId, parentKey, check.name);
      // (also when the dialog was closed meanwhile: a CREATE that was sent is not undone)
      addFolder(info);
      showToast(() => t("mail.folder.created", { name: info.label ?? check.name }), undefined, "success");
      setTimeout(() => void sync(), 2000); // (the sync shows the folder when the server's LIST was late)
      if (alive.current) {
        setDialog(null);
        // the new row gets the keyboard focus (it is not opened)
        const sel = `[data-fkey="${CSS.escape(collapsedKey(accountId, info.key))}"]`;
        requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(sel)?.focus({ preventScroll: false })));
      }
    } catch (err) {
      if (alive.current) {
        setServer(serverText(err));
        input.current?.focus();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <Modal title={t(parentKey ? "mail.folder.dlgTitleSub" : "mail.folder.dlgTitle")} onClose={() => setDialog(null)} width={440}>
      <form className="form fd-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="fd-loc">
          <div className="fd-lbl" id="fd-loc-lbl">{t("mail.folder.location")}</div>
          <div className="fd-where ellipsis" aria-labelledby="fd-loc-lbl" title={where}>{where}</div>
        </div>
        <div className="field">
          <label htmlFor="fd-name">{t("mail.folder.name")}</label>
          <input
            id="fd-name"
            ref={input}
            value={name}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!shown}
            aria-describedby={shown ? "fd-err" : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setServer(null);
            }}
            onBlur={() => name.trim() && setTouched(true)}
            onKeyDown={(e) => {
              // Enter creates; with the field empty it says what is missing (the button is off then, which would also turn off the implicit submit of the form)
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {shown && <div id="fd-err" className="fd-err err" role="alert">{shown}</div>}
        </div>
        <div className="row-inline fd-actions">
          <button type="button" className="btn" onClick={() => setDialog(null)}>{t("common.cancel")}</button>
          <button type="submit" className="btn primary" disabled={!name.trim()} aria-busy={busy || undefined}>
            {busy && <span className="spin" aria-hidden />}
            <span>{t("mail.folder.create")}</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

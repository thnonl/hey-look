// The Find and replace panel of the message body (spec-rich-text.md REQ-44, design 4.1): above the text, Find (Ctrl+F) with Match case, Previous / Next and
// "{n} of {total}", and with Ctrl+H the Replace row with Replace and Replace all. The search is in findReplace.ts. A chunk of its own, fetched on first use.

import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useT } from "../i18n/react";
import { clearSearch, getFind, replaceAll, replaceCurrent, selectedWord, setSearch, stepSearch, type FindState } from "./findReplace";

export type FindMode = "find" | "replace";

export function FindBar({ editor, mode, nonce, onClose }: { editor: Editor; mode: FindMode; nonce: number; onClose: () => void }) {
  const t = useT();
  const showToast = useStore((s) => s.showToast);
  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(() => selectedWord(editor.state));
  const [replaceWith, setReplaceWith] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [state, setState] = useState<FindState>(() => getFind(editor.state));
  const [note, setNote] = useState("");

  // opened (again): the search box takes the focus with its text selected; Ctrl+H goes to the Replace box
  useEffect(() => {
    const el = mode === "replace" ? replaceRef.current ?? findRef.current : findRef.current;
    el?.focus();
    el?.select();
  }, [mode, nonce]);
  // the search runs while the text of the box changes; the document changing under the panel (typing, undo) is followed
  useEffect(() => {
    setState(setSearch(editor.view, query, matchCase));
    setNote("");
  }, [editor, query, matchCase]);
  useEffect(() => {
    const follow = () => setState(getFind(editor.state));
    editor.on("transaction", follow);
    return () => {
      editor.off("transaction", follow);
    };
  }, [editor]);
  // closing takes the highlights away
  useEffect(
    () => () => {
      if (!editor.isDestroyed) clearSearch(editor.view);
    },
    [editor],
  );

  const total = state.hits.length;
  const count = !query ? "" : total ? t("compose.find.count", { n: state.current + 1, total }) : t("compose.find.none");
  const step = (dir: 1 | -1) => setState(stepSearch(editor.view, dir));
  const back = () => {
    onClose();
    editor.commands.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      back();
    } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (e.currentTarget === replaceRef.current && mode === "replace") setState(replaceCurrent(editor.view, replaceWith));
      else step(e.shiftKey ? -1 : 1);
    }
  };
  const doReplaceAll = () => {
    const n = replaceAll(editor.view, replaceWith);
    setState(getFind(editor.state));
    setNote(t("compose.find.replaced", { n }));
    if (n === 0) showToast(() => t("compose.find.none"), undefined, "info");
  };

  return (
    <div className="find-bar" role="search" aria-label={t("compose.find.find")} onKeyDown={onKey}>
      <div className="find-row">
        <input ref={findRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("compose.find.find")} placeholder={t("compose.find.find")} spellCheck={false} />
        <span className="find-count" role="status" aria-live="polite">{count}</span>
        <button type="button" className="icon-btn" title={t("compose.find.prev")} aria-label={t("compose.find.prev")} disabled={!total} onClick={() => step(-1)}><ChevronUp size={14} aria-hidden="true" /></button>
        <button type="button" className="icon-btn" title={t("compose.find.next")} aria-label={t("compose.find.next")} disabled={!total} onClick={() => step(1)}><ChevronDown size={14} aria-hidden="true" /></button>
        <label className="find-case"><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> {t("compose.find.matchCase")}</label>
        <button type="button" className="icon-btn find-close" title={t("common.close")} aria-label={t("common.close")} onClick={back}><X size={14} aria-hidden="true" /></button>
      </div>
      {mode === "replace" && (
        <div className="find-row">
          <input ref={replaceRef} type="text" value={replaceWith} onChange={(e) => setReplaceWith(e.target.value)} aria-label={t("compose.find.replaceWith")} placeholder={t("compose.find.replaceWith")} spellCheck={false} />
          <button type="button" className="btn small" disabled={!total} onClick={() => setState(replaceCurrent(editor.view, replaceWith))}>{t("compose.find.replace")}</button>
          <button type="button" className="btn small" disabled={!total} onClick={doReplaceAll}>{t("compose.find.replaceAll")}</button>
          <span className="find-count" role="status" aria-live="polite">{note}</span>
        </div>
      )}
    </div>
  );
}

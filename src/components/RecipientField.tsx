import { Lock, LockOpen, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { api, Contact, RecipientStatus } from "../api";
import { useStore } from "../store";
import { isEmail, singleLabelHostsOf } from "../addresses";
import { addRecipients, addressOf, chipLabel, formatRecipient, isImeEvent, openAtEnd, splitRecipients, type RcptField } from "../recipients";
import { keyProblemKey } from "../keyStatus";
import { useT } from "../i18n/react";
import { usePinnedBelow, useOutside } from "./ui";
import { GhostChips } from "./GhostChips";

// The recipient box of the composer and of the event dialog. Kept apart from Compose.tsx (the editor stack, loaded on demand, WP9d) so the Calendar does not pull the editor in.

/** Whether this is an address the composer accepts (see addresses.ts: `qa@localhost` and the account hosts count). */
export const EMAIL = { test: (a: string) => isEmail(a, singleLabelHostsOf(useStore.getState().accounts)) };
export const bareAddress = addressOf;

/** The chip being dragged between the fields of one message (W2.21): which message (`scope`), the field it comes from and the recipient. Only mouse drags set it. */
let chipDrag: { scope: string; from: RcptField; chip: string } | null = null;
const CHIP_DRAG = "application/x-heylook-recipient";

/** Recipient input with chips, address validation and keyboard-friendly suggestions. */
export function RecipientField({
  label, values, onChange, autoFocus, onTouch, onPending, keys, onKeyAction, hideLabel, field, dragScope, onChipDrop, ghosts,
}: {
  label: string;
  /** the label is only for screen readers (the caller shows its own) */
  hideLabel?: boolean;
  values: string[];
  onChange: (v: string[]) => void;
  autoFocus?: boolean;
  onTouch?: () => void;
  /** what is typed in the box and not yet a chip (tells the crash-recovery snapshot about an address that was typed and not confirmed) */
  onPending?: (text: string) => void;
  /** PGP key status per address (lower case); shown on the chips while Encrypt is on */
  keys?: Record<string, RecipientStatus>;
  onKeyAction?: (a: "import" | "paste") => void;
  /** which field of the message this is, and the id of the message: the chips can be dragged to another field of the same message (To, Cc, Bcc) */
  field?: RcptField;
  dragScope?: string;
  /** a chip of another field was dropped here (the caller moves it) */
  onChipDrop?: (chip: string, from: RcptField) => void;
  /** recipients drawn invisibly, only to take their room (the shell of a Reply: the row has the height of the finished message, GhostChips.tsx) */
  ghosts?: readonly string[];
}) {
  const t = useT();
  const [keyPop, setKeyPop] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState(false);
  const popRef = useRef<HTMLSpanElement>(null);
  useOutside(popRef, () => setKeyPop(null), keyPop !== null);
  const [text, setText] = useState("");
  const pendingRef = useRef(onPending);
  pendingRef.current = onPending;
  useEffect(() => {
    pendingRef.current?.(text);
  }, [text]);
  const [sugg, setSugg] = useState<Contact[]>([]);
  const [hi, setHi] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId(); // (the suggestions: a combobox of its own per field)
  const fieldRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const suggRef = useRef<HTMLDivElement>(null);
  // the popovers of the field are fixed: the header of the compose pane scrolls in a low window, and a scroll box would cut off an absolute one
  usePinnedBelow(popRef, fieldRef, keyPop !== null, { inset: 62 });
  usePinnedBelow(suggRef, fieldRef, sugg.length > 0, { inset: 62, match: true }, sugg);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  // many recipients: the box has a height of its own (App.css .chips) and shows the end, where the next one is typed
  useEffect(() => {
    const c = chipsRef.current;
    if (c && document.activeElement === input.current) c.scrollTop = c.scrollHeight;
  }, [values.length]);

  const commit = (raw: string) => {
    // one parser for typing, paste and drop (recipients.ts): a comma inside a quoted name does not end the recipient
    const parts = splitRecipients(raw);
    if (parts.length === 0) return /^[\s,;]*$/.test(raw) ? setText("") : undefined; // nothing but separators: the box is emptied
    onChange(addRecipients(values, parts)); // each address once, upper / lower case alike; the first spelling stays
    onTouch?.();
    setText("");
    setSugg([]);
    setHi(-1);
  };
  const pick = (c: Contact) => commit(formatRecipient(c.name ?? "", c.email));

  const onInput = (v: string, composing: boolean) => {
    // not while an input method is composing (its punctuation is part of the word), and not inside a quoted name
    if (!composing && /[,;]\s*$/.test(v) && !openAtEnd(v.replace(/[,;]\s*$/, ""))) return commit(v);
    setText(v);
    setHi(-1);
    if (v.trim().length >= 2) void api.suggestContacts(v.trim()).then(setSugg).catch(() => setSugg([]));
    else setSugg([]);
  };

  return (
    <div
      className={`cf-field rcpt${dropOver ? " drop-target" : ""}`}
      ref={fieldRef}
      onClick={() => input.current?.focus()}
      // a chip of this message dragged from another field is dropped here (a drag of anything else, text included, is left to the input)
      onDragOver={(e) => {
        const d = chipDrag;
        if (!field || !onChipDrop || !d || d.scope !== dragScope || !e.dataTransfer.types.includes(CHIP_DRAG)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = d.from === field ? "none" : "move";
        setDropOver(d.from !== field);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOver(false);
      }}
      onDrop={(e) => {
        setDropOver(false);
        if (!field || !onChipDrop || !chipDrag || chipDrag.scope !== dragScope || !e.dataTransfer.types.includes(CHIP_DRAG)) return;
        e.preventDefault();
        e.stopPropagation();
        const d = chipDrag;
        chipDrag = null;
        if (d.from !== field) onChipDrop(d.chip, d.from);
      }}
    >
      {!hideLabel && <label>{label}</label>}
      <div className="chips" ref={chipsRef}>
        <GhostChips values={ghosts} />
        {values.map((v) => {
          const addr = bareAddress(v).toLowerCase();
          const ks = keys?.[addr];
          const noKey = !!ks && ks.status !== "ok";
          return (
          <span
            key={v}
            data-email={EMAIL.test(bareAddress(v)) ? bareAddress(v) : undefined}
            draggable={!!field && !!onChipDrop}
            onDragStart={(e) => {
              if (!field || !onChipDrop) return;
              chipDrag = { scope: dragScope ?? "", from: field, chip: v };
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData(CHIP_DRAG, v); // (no text flavour: dropped in another program or on the message text it does nothing)
            }}
            onDragEnd={() => {
              chipDrag = null;
              setDropOver(false);
            }}
            className={`rchip ${EMAIL.test(bareAddress(v)) ? "" : "bad"} ${noKey ? "nokey" : ""}`} title={EMAIL.test(bareAddress(v)) ? (noKey ? t(keyProblemKey(ks?.status, "chipTitle"), { addr }) : v) : t("compose.rcpt.notAddress")}>
            {ks && (ks.status === "ok" ? (
              <span className="rchip-key ok" title={t("compose.rcpt.keyFound")} role="img" aria-label={t("compose.rcpt.keyFoundFor", { addr })}><Lock size={11} /></span>
            ) : (
              <button type="button" className="rchip-key missing" aria-label={t("compose.rcpt.noKeyOptions", { addr })} aria-haspopup="dialog" aria-expanded={keyPop === addr} onClick={(e) => (e.stopPropagation(), setKeyPop(keyPop === addr ? null : addr))}>
                <LockOpen size={11} />
              </button>
            ))}
            <span className="ellipsis">{chipLabel(v)}</span>
            <button
              type="button"
              aria-label={t("compose.rcpt.remove", { name: chipLabel(v) })}
              onClick={(e) => {
                e.stopPropagation();
                onChange(values.filter((x) => x !== v));
                onTouch?.();
              }}
            >
              <X size={11} />
            </button>
          </span>
          );
        })}
        <input
          ref={input}
          value={text}
          aria-label={label}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={sugg.length > 0}
          aria-controls={listId}
          aria-activedescendant={hi >= 0 && sugg[hi] ? `${listId}-${hi}` : undefined}
          placeholder={values.length === 0 && !ghosts?.length ? "name@example.com" : undefined}
          onChange={(e) => onInput(e.target.value, !!(e.nativeEvent as InputEvent).isComposing)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (/[,;\n\r\t<]/.test(pasted)) {
              e.preventDefault();
              commit(text + pasted);
            }
          }}
          onDrop={(e) => {
            // text dragged into the box (a list of addresses from another program) becomes chips like a paste
            const dropped = e.dataTransfer.getData("text");
            if (dropped && /[,;\n\r\t<@]/.test(dropped)) {
              e.preventDefault();
              e.stopPropagation();
              commit(text + dropped);
            }
          }}
          onBlur={() => {
            setTimeout(() => setSugg([]), 120);
            commit(text);
          }}
          onKeyDown={(e) => {
            // Enter / Tab / `,` that belong to an input method (it confirms a half-converted word) do not make a chip
            if (isImeEvent(e)) return;
            if (e.key === "ArrowDown" && sugg.length) {
              e.preventDefault();
              setHi((h) => Math.min(h + 1, sugg.length - 1));
            } else if (e.key === "ArrowUp" && sugg.length) {
              e.preventDefault();
              setHi((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter" || e.key === "Tab" || e.key === ";" || e.key === ",") {
              // Tab turns what is typed into a recipient and then moves on to the next field as usual (it used to stay here, so the
              // subject was typed into this box: QA BUG-M2); Enter, `;` and `,` keep the focus here for the next address
              const moveOn = e.key === "Tab";
              if (hi >= 0 && sugg[hi]) {
                if (!moveOn) e.preventDefault();
                pick(sugg[hi]);
              } else if (text.trim()) {
                // a `,` or `;` typed inside a quoted name is part of the name
                if ((e.key === "," || e.key === ";") && openAtEnd(text)) return;
                if (!moveOn) e.preventDefault();
                commit(text);
              }
            } else if (e.key === "Backspace" && !text && values.length) {
              onChange(values.slice(0, -1));
              onTouch?.();
            } else if (e.key === "Escape") setSugg([]);
          }}
        />
      </div>
      {keyPop && keys?.[keyPop] && (
        <span className="suggest pinned popover" role="dialog" aria-label={t("compose.rcpt.keyDialog", { addr: keyPop })} ref={popRef} style={{ width: 340, padding: 12, gap: 8, display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}><TriangleAlert size={15} className="warn-ico" /><b>{t(keyProblemKey(keys[keyPop].status, "chipTitle"), { addr: keyPop })}</b></span>
          <span className="muted small">{t(keyProblemKey(keys[keyPop].status, "chipHelp"))}</span>
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="btn small primary" onClick={() => (setKeyPop(null), onKeyAction?.("import"))}>{t("compose.rcpt.importKey")}</button>
            <button className="btn small" onClick={() => (setKeyPop(null), onKeyAction?.("paste"))}>{t("compose.rcpt.pasteKey")}</button>
            <button className="btn small" onClick={() => { const a = keyPop; setKeyPop(null); onChange(values.filter((x) => bareAddress(x).toLowerCase() !== a)); onTouch?.(); }}>{t("compose.rcpt.removeRecipient")}</button>
          </span>
        </span>
      )}
      {sugg.length > 0 && (
        <div className="suggest pinned" id={listId} role="listbox" aria-label={label} ref={suggRef}>
          {sugg.map((c, i) => (
            <div key={c.email} id={`${listId}-${i}`} role="option" aria-selected={i === hi} className={i === hi ? "hl" : ""} onMouseDown={(e) => (e.preventDefault(), pick(c))} onMouseEnter={() => setHi(i)}>
              {c.name ? `${c.name} ` : ""}
              <span className="muted">&lt;{c.email}&gt;</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

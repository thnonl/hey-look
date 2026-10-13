import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { fullErrorFor, useStore } from "../store";

/** Stack of toasts; a toast with Undo stays until its window ends. */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  // Esc closes the newest toast that asks for it ("a new version is available") when focus is on its buttons, unless a dialog, the command bar or a question is open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const st = useStore.getState();
      if (st.dialog || st.ask || st.passphrase || st.commandOpen) return;
      // only while keyboard focus is on one of the toast's own buttons: an Esc that closed the command bar or a menu is not meant for it
      if (!(document.activeElement instanceof Element) || !document.activeElement.closest(".toasts")) return;
      const t = [...st.toasts].reverse().find((x) => x.escCloses);
      if (!t) return;
      st.dismissToast(t.id);
      t.onDismiss?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}${t.sticky ? " sticky" : ""}`} style={t.sticky ? undefined : { ["--ttl" as string]: `${t.ttl}ms` }}>
          <span className="toast-ico">
            {t.kind === "error" ? <AlertTriangle size={16} /> : t.kind === "success" ? <CheckCircle2 size={16} /> : <Info size={16} />}
          </span>
          <span className="toast-text" title={fullErrorFor(t.text)}>{t.text}</span>
          {t.undo && (
            <button
              className="toast-undo"
              onClick={() => {
                t.undo?.();
                dismiss(t.id);
              }}
            >
              Undo
            </button>
          )}
          {t.actions?.map((a) => (
            <button
              key={a.label}
              className="toast-act"
              onClick={() => {
                dismiss(t.id);
                a.run();
              }}
            >
              {a.label}
            </button>
          ))}
          <button
            className="toast-x"
            aria-label={t.closeLabel ?? (t.onDismiss ? "Later" : "Dismiss")}
            onClick={() => {
              dismiss(t.id);
              t.onDismiss?.();
            }}
          >
            <X size={14} />
          </button>
          {!t.sticky && <span className="toast-bar" />}
        </div>
      ))}
    </div>
  );
}

/** Replaces the browser's native confirm(): one component for every question the app asks. */
export function AskHost() {
  const ask = useStore((s) => s.ask);
  const resolve = useStore((s) => s.resolveAsk);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!ask) return;
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") resolve(ask.choices[0].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ask, resolve]);
  if (!ask) return null;
  return (
    <div className="modal-back ask-back" onMouseDown={() => resolve(ask.choices[0].id)}>
      <div className="ask" role="alertdialog" aria-modal="true" aria-label={ask.title} onMouseDown={(e) => e.stopPropagation()}>
        <h3>{ask.title}</h3>
        {ask.body && <p className="muted">{ask.body}</p>}
        <div className="ask-actions">
          {ask.choices.map((c, i) => (
            <button
              key={c.id}
              ref={i === 0 ? first : undefined}
              className={`btn ${c.kind === "primary" ? "primary" : c.kind === "danger" ? "danger-fill" : ""}`}
              onClick={() => resolve(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: React.ReactNode; title: string; text?: string; action?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-art">{icon}</div>
      <div className="empty-title">{title}</div>
      {text && <div className="muted">{text}</div>}
      {action}
    </div>
  );
}

export function SkeletonRows({ n = 8 }: { n?: number }) {
  return (
    <div className="skeleton-list" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <div className="sk-row" key={i}>
          <div className="sk sk-av" />
          <div className="sk-lines">
            <div className="sk sk-l1" style={{ width: `${48 + ((i * 17) % 38)}%` }} />
            <div className="sk sk-l2" style={{ width: `${70 + ((i * 11) % 25)}%` }} />
            <div className="sk sk-l3" style={{ width: `${55 + ((i * 7) % 35)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

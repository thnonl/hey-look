import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useStore } from "../store";

/** Stack of toasts; a toast with Undo stays until its window ends. */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} style={{ ["--ttl" as string]: `${t.ttl}ms` }}>
          <span className="toast-ico">
            {t.kind === "error" ? <AlertTriangle size={16} /> : t.kind === "success" ? <CheckCircle2 size={16} /> : <Info size={16} />}
          </span>
          <span className="toast-text">{t.text}</span>
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
          <button className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
          <span className="toast-bar" />
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

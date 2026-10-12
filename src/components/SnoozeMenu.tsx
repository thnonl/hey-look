import { useState } from "react";
import { useStore } from "../store";
import { snoozePresets } from "../util";

export function SnoozeMenu({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const act = useStore((s) => s.act);
  const [custom, setCustom] = useState("");
  const go = async (ts: number, label: string) => {
    onClose();
    await act(ids, "snooze", String(ts), `Snoozed until ${label}`);
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal small" onClick={(e) => e.stopPropagation()}>
        <h3>Snooze until…</h3>
        {snoozePresets().map((p) => (
          <button key={p.label} className="menu-item" onClick={() => go(p.ts, p.label)}>
            {p.label}
          </button>
        ))}
        <div className="row-inline">
          <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <button
            className="btn primary"
            disabled={!custom}
            onClick={() => go(Math.floor(new Date(custom).getTime() / 1000), new Date(custom).toLocaleString())}
          >
            Set
          </button>
        </div>
      </div>
    </div>
  );
}

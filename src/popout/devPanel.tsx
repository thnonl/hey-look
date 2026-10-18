// What a placeholder window shows with the dev flag (see route.ts `popoutDevEnabled`): what it knows about itself, and buttons that open
// more windows. Never shown to a person, so its words are not translated (scripts/test-i18n.mjs skips this file like devMock.ts).
import { currentFlushHandlers } from "./flush";
import { openPopout } from "./open";
import type { PopoutViewProps } from "./views";

export function DevPanel({ kind, label, keyOf, init }: PopoutViewProps) {
  return (
    <>
      <h3>{kind} window: not implemented yet</h3>
      <dl className="popout-dev">
        <dt>label</dt>
        <dd>{label}</dd>
        <dt>key</dt>
        <dd>{keyOf ?? "(none)"}</dd>
        <dt>hand-off data</dt>
        <dd>{init === null || init === undefined ? "(none)" : JSON.stringify(init)}</dd>
        <dt>flush handlers</dt>
        <dd>{currentFlushHandlers().length}</dd>
      </dl>
      <p>
        <button className="btn" onClick={() => void openPopout("compose")}>open a compose window</button>{" "}
        <button className="btn" onClick={() => void openPopout("reader")}>open a reader window</button>
      </p>
    </>
  );
}

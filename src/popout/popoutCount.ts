// How many secondary windows exist, as the backend last said (`popout-count`, popout.rs): the support reminder is not shown while a message
// is being written in a window (REQ-W15), so "composing" is more than the inline pane.
let counts = { compose: 0, reader: 0, settings: 0 };

export function setPopoutCounts(c: { compose?: number; reader?: number; settings?: number } | null | undefined): void {
  counts = { compose: Math.max(0, Number(c?.compose) || 0), reader: Math.max(0, Number(c?.reader) || 0), settings: Math.max(0, Number(c?.settings) || 0) };
}

/** Is the Settings window open? Then every way of opening Settings goes to it (W4.6, REQ-4.6.9). */
export const settingsWindowOpen = (): boolean => counts.settings > 0;

export const composeWindowsOpen = (): number => counts.compose;

// Timing marks of an opening mail (W13.6 step 1): `performance.mark` calls that cost nothing unless a check set `window.__hlMarks` (scripts/measure-open-mail.mjs, the kit's probes).
export const hlMark = (name: string): void => {
  try {
    if ((window as unknown as { __hlMarks?: boolean }).__hlMarks) performance.mark(name);
  } catch {
    /* no performance API: nothing to mark */
  }
};

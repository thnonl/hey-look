import { useEffect, useRef, useState } from "react";

/**
 * A busy signal that does not flash: true once `on` has been true for `after` ms (a fast open never shows it; 100 ms, so that it is on screen within the 150 ms of REQ-13.7.1), and once shown it stays for at least `min` ms (it does
 * not flicker away the moment the work ends). REQ-13.6.1 / REQ-13.7.1: the status of a draft that is being opened (150 ms / 300 ms).
 */
export function useDelayedFlag(on: boolean, after = 100, min = 300): boolean {
  const [shown, setShown] = useState(false);
  const since = useRef(0);
  useEffect(() => {
    if (on) {
      const id = setTimeout(() => {
        since.current = Date.now();
        setShown(true);
      }, after);
      return () => clearTimeout(id);
    }
    if (!shown) return;
    const id = setTimeout(() => setShown(false), Math.max(0, min - (Date.now() - since.current)));
    return () => clearTimeout(id);
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  return shown;
}

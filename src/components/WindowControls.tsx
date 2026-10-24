import { ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useT } from "../i18n/react";
import { publishCaptionColors, useStore } from "../store";
import { frameAction, useFrame, Zone } from "../winframe";

// Fluent-style 10x10 glyphs (the same shapes as Segoe Fluent Icons E921 / E922 / E923 / E8BB)
const ICON: Record<Zone | "restore", ReactNode> = {
  min: <path d="M0 5.5h10" />,
  max: <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" />,
  restore: (
    <>
      <rect x="0.5" y="2.5" width="7" height="7" rx="1.3" />
      <path d="M2.5 2.5V1.8A1.3 1.3 0 0 1 3.8 0.5h4.4a1.3 1.3 0 0 1 1.3 1.3v4.4a1.3 1.3 0 0 1-1.3 1.3h-.7" />
    </>
  ),
  close: <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />,
};

/**
 * Minimize / maximize-restore / close for the frameless Windows window. Rendered only when the backend removed the OS
 * frame. The OS hit-tests this group (see src-tauri/src/winframe.rs): that is what lets Windows 11 show the Snap Layouts
 * flyout on the maximize button. While it does, the webview gets no pointer events here, so hover / pressed come from
 * the `frame-caption` events (`native`); otherwise (Windows 10 without the overlay, keyboard) plain DOM buttons work.
 */
export function WindowControls() {
  const t = useT();
  const zoneLabel = (z: Zone, maximized: boolean) =>
    z === "min" ? t("app.window.minimize") : z === "max" ? (maximized ? t("app.window.restore") : t("app.window.maximize")) : t("common.close");
  const { custom, native, maximized, fullscreen, focused, caption } = useFrame();
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Zone | null>(null);

  // tell the backend where the buttons are, now and whenever they move or the scale changes
  useEffect(() => {
    const el = box.current;
    if (!custom || !el) return;
    let raf = 0;
    let alive = true;
    const send = () => {
      const r = el.getBoundingClientRect(); // all zeros while hidden (fullscreen): the backend then removes the hit-test window
      publishCaptionColors(useStore.getState().prefs); // (the caption of the other windows takes the band's colour where these buttons are: it moves with the width)
      api
        .frameCaptionRect({ x: r.left, y: r.top, w: r.width, h: r.height })
        .then((ok) => alive && useFrame.setState({ native: ok }))
        .catch(() => alive && useFrame.setState({ native: false }));
    };
    const soon = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(send);
    };
    soon();
    const ro = new ResizeObserver(soon);
    ro.observe(el);
    ro.observe(document.documentElement);
    window.addEventListener("resize", soon);
    // A media query on the current scale fires once when the scale changes (window moved to another monitor, display
    // scaling changed); a new one is armed for the new scale each time.
    let dpr: MediaQueryList | null = null;
    const onScale = () => {
      soon();
      arm();
    };
    const arm = () => {
      dpr?.removeEventListener("change", onScale);
      if (!alive) return;
      dpr = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dpr.addEventListener("change", onScale);
    };
    arm();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", soon);
      dpr?.removeEventListener("change", onScale);
    };
  }, [custom, fullscreen, maximized]);

  // OS-hit-tested buttons have no DOM hover, so their tooltip is drawn here after a short delay
  useEffect(() => {
    setTip(null);
    if (!native || !caption.hot || caption.down) return;
    const timer = setTimeout(() => setTip(caption.hot), 500);
    return () => clearTimeout(timer);
  }, [native, caption.hot, caption.down]);

  if (!custom) return null;

  const btn = (z: Zone, run: () => void) => {
    const label = zoneLabel(z, maximized);
    const cls = ["wc", `wc-${z}`, caption.hot === z ? "hot" : "", caption.down === z ? "down" : ""].filter(Boolean).join(" ");
    return (
      <button type="button" className={cls} aria-label={label} title={label} onClick={run}>
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          {ICON[z === "max" && maximized ? "restore" : z]}
        </svg>
      </button>
    );
  };

  return (
    <div
      ref={box}
      className={`window-controls${native ? " native" : ""}${fullscreen ? " wc-hidden" : ""}`}
      role="group"
      aria-label={t("app.window.controls")}
      data-active={focused}
      data-tauri-drag-region="false"
    >
      {btn("min", frameAction.minimize)}
      {btn("max", frameAction.toggleMaximize)}
      {btn("close", frameAction.close)}
      {tip && (
        <div className={`wc-tip wc-tip-${tip}`} role="tooltip">
          {zoneLabel(tip, maximized)}
        </div>
      )}
    </div>
  );
}

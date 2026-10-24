// The stored theme and accent, before the first paint (index.html loads this blocking; the CSP has no inline scripts). applyPrefs (src/store.ts) keeps a copy
// in localStorage["heylook.boot"]. "system" sets nothing: the CSS follows the OS, except on Linux where the backend says what the OS is (b.os, W5.2).
(function () {
  try {
    var b = JSON.parse(localStorage.getItem("heylook.boot") || "null");
    var r = document.documentElement;
    if (b && (b.theme === "dark" || b.theme === "light")) r.setAttribute("data-theme", b.theme);
    else if (b && b.theme === "system" && (b.os === "dark" || b.os === "light")) r.setAttribute("data-theme", b.os);
    if (b && typeof b.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(b.accent)) r.style.setProperty("--accent-base", b.accent);
  } catch (e) {
    /* storage unavailable or not ours: the OS theme and the default accent */
  }
})();

// The stored theme and accent, before the first paint (index.html loads this file first, blocking; the CSP has no inline scripts).
// The preferences live in the backend's database, which only an asynchronous call can read, so applyPrefs (src/store.ts) keeps a copy of the
// two things the start screen needs in localStorage["heylook.boot"]. "system" (or nothing stored yet) sets nothing: the CSS follows the OS.
(function () {
  try {
    var b = JSON.parse(localStorage.getItem("heylook.boot") || "null");
    var r = document.documentElement;
    if (b && (b.theme === "dark" || b.theme === "light")) r.setAttribute("data-theme", b.theme);
    if (b && typeof b.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(b.accent)) r.style.setProperty("--accent-base", b.accent);
  } catch (e) {
    /* storage unavailable or not ours: the OS theme and the default accent */
  }
})();

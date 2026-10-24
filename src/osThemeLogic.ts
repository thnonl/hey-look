// The pure rule of osTheme.ts, apart from it so that a plain Node script can test it (scripts/test-os-theme.mjs): osTheme.ts imports the backend's api.

/**
 * The theme a page shows for a setting, pure: `dark` / `light` are what the person chose; `system` follows the OS, which is `osDark` (backend value or media query).
 */
export function resolveSystemTheme(setting: "system" | "light" | "dark", osDark: boolean): "light" | "dark" {
  return setting === "dark" ? "dark" : setting === "light" ? "light" : osDark ? "dark" : "light";
}

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error a plain .mjs next to the other scripts: the files of PDF.js that the PDF viewer needs (W5.1)
import { pdfjsAssets } from "./scripts/vite-pdfjs-assets.mjs";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), pdfjsAssets()],
  // PDF.js is first imported when a PDF is previewed: pre-bundle it with the server so that the first preview does not make the dev server optimise it and reload the page
  optimizeDeps: { include: ["pdfjs-dist"] },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

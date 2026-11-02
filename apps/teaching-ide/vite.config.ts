import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer build. Output is loaded by the Electron main process via loadFile,
// so the base must be relative. Everything bundles locally — no CDN, offline.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    target: "chrome130",
  },
});

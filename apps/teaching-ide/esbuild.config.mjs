// Builds the Electron main process and preload bridge as CommonJS bundles.
// CJS is required for a sandboxed preload script. Dependencies that belong to
// the Electron runtime itself stay external; everything else is bundled.
import { build } from "esbuild";

await build({
  entryPoints: ["electron/main.ts", "electron/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outdir: "dist/main",
  external: ["electron", "playwright-core"],
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

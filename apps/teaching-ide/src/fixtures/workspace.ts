// Bundled synthetic workspace fixture. Contents are static text compiled into
// the renderer (offline, deterministic) — never executed, never installed.
import type { WorkspaceManifest } from "../model/workspace.ts";
import packageJsonRaw from "../../fixtures/workspace/package.json?raw";
import serverTsRaw from "../../fixtures/workspace/src/server.ts?raw";
import routesTsRaw from "../../fixtures/workspace/src/routes.ts?raw";
import indexHtmlRaw from "../../fixtures/workspace/public/index.html?raw";
import stylesCssRaw from "../../fixtures/workspace/public/styles.css?raw";
import readmeMdRaw from "../../fixtures/workspace/README.md?raw";

export const workspaceManifest: WorkspaceManifest = {
  rootLabel: "demo-node-app",
  files: [
    { path: "package.json", language: "json", content: packageJsonRaw },
    { path: "src/server.ts", language: "typescript", content: serverTsRaw },
    { path: "src/routes.ts", language: "typescript", content: routesTsRaw },
    { path: "public/index.html", language: "html", content: indexHtmlRaw },
    { path: "public/styles.css", language: "css", content: stylesCssRaw },
    { path: "README.md", language: "markdown", content: readmeMdRaw },
  ],
};

/** Static HTML shown by the browser/result panel (sandboxed, scriptless). */
export const browserPreviewHtml = indexHtmlRaw;

export const DEFAULT_LESSON_FIXTURE = "dev-server";
export const SENTINEL_LESSON_FIXTURE = "side-effect-safety";
export const INVALID_LESSON_FIXTURE = "invalid-corrupt";
export const EDITOR_LESSON_FIXTURE = "editor-typing";

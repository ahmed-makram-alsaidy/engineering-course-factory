// Repository/output path resolution for the compiler CLI.
// No machine path is ever hard-coded or embedded in compiled output: the
// repository root is located structurally (ancestor containing the committed
// architecture manifest), and outputs go to the generated-artifacts area.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repository root, located by walking up from this module to the ancestor
 * containing config/architecture.json (the committed architecture manifest).
 * Machine-specific relocation is configured elsewhere (config/paths.json) and
 * is a runtime concern of later phases — the compiler only ever writes under
 * the repository's generated-artifacts area.
 */
export function findRepositoryRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "config", "architecture.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("cannot locate the repository root (no ancestor contains config/architecture.json)");
    }
    dir = parent;
  }
}

/**
 * Default output location: <repoRoot>/runtime/compiled/<lesson_id>/compiled-lesson.json
 * — runtime/ is the generated-artifacts area (git-ignored, regenerable), so a
 * default compile never writes into a source directory.
 */
export function defaultOutputPath(repositoryRoot: string, lessonId: string): string {
  return join(repositoryRoot, "runtime", "compiled", lessonId, "compiled-lesson.json");
}

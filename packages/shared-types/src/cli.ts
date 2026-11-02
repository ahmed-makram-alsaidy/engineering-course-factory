// CLI: validate a lesson.yaml file.
//   node packages/shared-types/src/cli.ts path/to/lesson.yaml
// Exit codes: 0 = valid, 1 = invalid, 2 = usage error.

import { validateLessonFile } from "./validate.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: node packages/shared-types/src/cli.ts <path/to/lesson.yaml>");
  process.exit(2);
}

const result = validateLessonFile(file);
if (result.ok) {
  console.log(`${file}: VALID`);
  process.exit(0);
}

console.log(`${file}: INVALID`);
for (const issue of result.issues) {
  console.log(`  - path:   ${issue.path}`);
  console.log(`    code:   ${issue.code}`);
  console.log(`    reason: ${issue.message}`);
}
process.exit(1);

// Public surface of @course-factory/lesson-compiler

export * from "./version.ts";
export * from "./ir.ts";
export { compileLesson } from "./compile.ts";
export { canonicalJsonV1, serializeCompiledLesson, sha256Hex, sortKeysDeep, sourceHash } from "./canonical.ts";
export { defaultOutputPath, findRepositoryRoot } from "./paths.ts";

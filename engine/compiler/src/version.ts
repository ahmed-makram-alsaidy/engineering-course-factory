// Compiler + IR identity. Each version below is independent of the others and
// of the repository commit SHA:
//   - COMPILER_VERSION   — the compiler implementation itself (keep in sync
//                          with package.json "version"; asserted by a test)
//   - COMPILED_IR_VERSION— the compiled OUTPUT contract version
//   - (source schema version "1.1" lives in @course-factory/shared-types)

export const COMPILER_NAME = "course-factory-lesson-compiler";
export const COMPILER_VERSION = "0.1.0";
export const COMPILED_IR_VERSION = "1.0";

// Lesson YAML validation — thin loader around the Zod authority in schema.ts.

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { LessonSchema, formatPath, SCHEMA_VERSION } from "./schema.ts";
import type { Lesson, ValidationIssue, ValidationResult } from "./schema.ts";

export type { Lesson, ValidationIssue, ValidationResult };
export { SCHEMA_VERSION };

function nativeCode(message: string, fallback: string): { code: string; message: string } {
  // Custom schema issues carry a leading machine token: "[TOKEN] human message"
  const match = message.match(/^\[([A-Z_]+)\]\s*(.*)$/);
  if (match) return { code: match[1], message: match[2] };
  return { code: fallback, message };
}

/**
 * Map a Zod error to the stable { path, code, message } issue shape.
 * Exported (P3) so downstream contracts (the compiled-lesson IR) reuse the
 * exact same issue mapping instead of growing a second implementation.
 */
export function formatZodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => {
    if (issue.code === "custom") {
      const { code, message } = nativeCode(issue.message, "CUSTOM");
      return { path: formatPath(issue.path), code, message };
    }
    return { path: formatPath(issue.path), code: issue.code, message: issue.message };
  });
}

export function validateLessonData(data: unknown): ValidationResult {
  const result = LessonSchema.safeParse(data);
  if (result.success) {
    return { ok: true, issues: [] };
  }
  return { ok: false, issues: formatZodIssues(result.error) };
}

/**
 * Parse + validate lesson data and return the schema-normalized lesson object
 * (defaults applied) on success. Additive API (P3): lets downstream consumers
 * (the lesson compiler) reuse THE validation authority without re-parsing,
 * while keeping the exact same issue mapping as validateLessonData.
 */
export interface LessonParseResult extends ValidationResult {
  /** Schema-normalized lesson document (defaults applied) — present only when ok. */
  lesson?: Lesson;
}

export function parseLessonData(data: unknown): LessonParseResult {
  const result = LessonSchema.safeParse(data);
  if (result.success) {
    return { ok: true, issues: [], lesson: result.data };
  }
  return { ok: false, issues: formatZodIssues(result.error) };
}

export function parseLessonSource(source: string, sourceName = "(input)"): LessonParseResult {
  let data: unknown;
  try {
    data = parseYaml(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      issues: [{ path: "(root)", code: "YAML_SYNTAX_ERROR", message: `${sourceName}: YAML parsing failed: ${message}` }],
    };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      issues: [
        {
          path: "(root)",
          code: "YAML_ROOT_NOT_OBJECT",
          message: `${sourceName}: lesson document must be a YAML mapping (key: value), got ${data === null ? "null" : Array.isArray(data) ? "a list" : typeof data}`,
        },
      ],
    };
  }
  return parseLessonData(data);
}

export function parseLessonFile(filePath: string): LessonParseResult {
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      issues: [{ path: "(root)", code: "FILE_READ_ERROR", message: `cannot read lesson file '${filePath}': ${message}` }],
    };
  }
  return parseLessonSource(source, filePath);
}

export function validateLessonSource(source: string, sourceName = "(input)"): ValidationResult {
  const result = parseLessonSource(source, sourceName);
  return { ok: result.ok, issues: result.issues };
}

export function validateLessonFile(filePath: string): ValidationResult {
  const result = parseLessonFile(filePath);
  return { ok: result.ok, issues: result.issues };
}

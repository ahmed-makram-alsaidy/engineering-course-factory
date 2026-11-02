// Operation descriptors — display metadata for a compiled operation.
// PURE: an operation goes in, a plain description comes out. Nothing is
// executed, typed, opened, fetched, or navigated — ever. The `panel` field
// only tells the UI which pane to visually highlight.

import type { CompiledOperation } from "./ir.ts";

export type PanelName = "terminal" | "browser" | "editor" | null;

export interface OperationDescriptor {
  /** Exact authored operation type. */
  type: string;
  /** Derived family from the compiled IR. */
  family: string;
  /** Human one-liner for status/inspector. */
  title: string;
  /** Key/value metadata rows for the inspector. */
  meta: [string, string][];
  /** Which pane this operation CONCERNS (highlight only — never acts). */
  panel: PanelName;
}

/** Marker appended to terminal/browser metadata: these are DATA, not actions. */
export const NOT_EXECUTED_NOTE = "display metadata only — not executed (P4)";

export function compileOperationDescriptor(operation: CompiledOperation): OperationDescriptor {
  const parameters = operation.parameters as Record<string, unknown>;
  const value = (key: string): string => (parameters[key] === undefined ? "" : String(parameters[key]));
  const meta: [string, string][] = [];
  let title = operation.type;
  let panel: PanelName = null;

  switch (operation.type) {
    case "terminal_run": {
      title = `terminal_run (${value("mode")})`;
      meta.push(["command", value("command")]);
      if (parameters.cwd !== undefined) meta.push(["cwd", value("cwd")]);
      if (parameters.process_id !== undefined) meta.push(["process_id", value("process_id")]);
      if (parameters.timeout_seconds !== undefined) meta.push(["timeout", `${value("timeout_seconds")}s`]);
      if (parameters.expected_exit_code !== undefined) meta.push(["expected exit", value("expected_exit_code")]);
      panel = "terminal";
      break;
    }
    case "terminal_stop": {
      meta.push(["process_id", value("process_id")]);
      panel = "terminal";
      break;
    }
    case "wait": {
      title = `wait until ${value("until")}`;
      if (parameters.seconds !== undefined) meta.push(["seconds", value("seconds")]);
      if (parameters.port !== undefined) meta.push(["port", value("port")]);
      if (parameters.host !== undefined) meta.push(["host", value("host")]);
      if (parameters.process_id !== undefined) meta.push(["process_id", value("process_id")]);
      if (parameters.text !== undefined) meta.push(["expects output", value("text")]);
      if (parameters.timeout_seconds !== undefined) meta.push(["timeout", `${value("timeout_seconds")}s`]);
      break;
    }
    case "browser_open": {
      meta.push(["url", value("url")]);
      panel = "browser";
      break;
    }
    case "browser_click":
    case "browser_fill": {
      const selector = parameters.selector as { strategy?: string; value?: string; name?: string } | undefined;
      if (selector) {
        meta.push(["selector", `${selector.strategy}: ${selector.value}${selector.name ? ` (${selector.name})` : ""}`]);
      }
      if (parameters.value !== undefined) meta.push(["value", value("value")]);
      panel = "browser";
      break;
    }
    case "browser_press": {
      meta.push(["key", value("key")]);
      panel = "browser";
      break;
    }
    case "browser_refresh": {
      panel = "browser";
      break;
    }
    case "browser_wait":
    case "browser_assert": {
      for (const key of ["url_contains", "selector_text", "text_visible", "text"]) {
        if (parameters[key] !== undefined) meta.push([key, String(parameters[key])]);
      }
      if (parameters.timeout_seconds !== undefined) meta.push(["timeout", `${value("timeout_seconds")}s`]);
      panel = "browser";
      break;
    }
    case "file_open":
    case "file_create":
    case "file_save":
    case "type_code":
    case "replace_code":
    case "highlight": {
      meta.push(["path", value("path")]);
      if (operation.type === "type_code") {
        const content = String(parameters.content ?? "");
        meta.push(["payload", `${content.length} chars — shown in inspector only, never typed`]);
      }
      if (operation.type === "replace_code") {
        if (parameters.occurrences !== undefined) meta.push(["occurrences", value("occurrences")]);
      }
      if (operation.type === "highlight" && parameters.line !== undefined) {
        meta.push(["line", value("line") + (parameters.line_end !== undefined ? `–${value("line_end")}` : "")]);
      }
      panel = "editor";
      break;
    }
    default: {
      meta.push(["parameters", JSON.stringify(parameters)]);
    }
  }

  return { type: operation.type, family: operation.family, title, meta, panel };
}

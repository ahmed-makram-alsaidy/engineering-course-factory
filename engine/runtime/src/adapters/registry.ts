// P8.4 Engine Adapter Registry
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 10 & Section 32, and ADR-0013.
// Enforces a closed, static 1:1 mapping between canonical EngineFamily and registered adapters.
//
// Registered Families:
// - editor      → EditorRuntimeAdapter
// - terminal    → TerminalRuntimeAdapter
// - browser     → BrowserRuntimeAdapter
// - wait        → WaitRuntimeAdapter
// - narration   → NarrationRuntimeAdapter (SimulatedNarrationAdapter)
// - visual      → VisualRuntimeAdapter
//
// Orchestrator Family Rule:
// - "orchestrator" is an internal control plane family, NOT an external engine.
//   Attempting to retrieve an adapter for "orchestrator" fails closed immediately.
//
// Dynamic module loading by string is strictly forbidden.

import type { EngineFamily } from "../protocol.ts";
import { RuntimeError } from "../errors.ts";
import type { EngineAdapter } from "./adapter.ts";

// ---------------------------------------------------------------------------
// EngineAdapterRegistry Options
// ---------------------------------------------------------------------------

export interface EngineAdapterRegistryOptions {
  readonly editor: EngineAdapter;
  readonly terminal: EngineAdapter;
  readonly browser: EngineAdapter;
  readonly wait: EngineAdapter;
  readonly narration: EngineAdapter;
  readonly visual: EngineAdapter;
}

export const CANONICAL_EXTERNAL_FAMILIES: readonly EngineFamily[] = [
  "editor",
  "terminal",
  "browser",
  "wait",
  "narration",
  "visual",
] as const;

// ---------------------------------------------------------------------------
// EngineAdapterRegistry Implementation
// ---------------------------------------------------------------------------

export class EngineAdapterRegistry {
  private readonly adapters: ReadonlyMap<EngineFamily, EngineAdapter>;

  constructor(options: EngineAdapterRegistryOptions) {
    if (!options.editor || options.editor.family !== "editor") {
      throw new RuntimeError({
        code: "ENGINE_UNAVAILABLE",
        message: "Editor adapter must be registered with family 'editor'",
      });
    }
    if (!options.terminal || options.terminal.family !== "terminal") {
      throw new RuntimeError({
        code: "ENGINE_UNAVAILABLE",
        message: "Terminal adapter must be registered with family 'terminal'",
      });
    }
    if (!options.browser || options.browser.family !== "browser") {
      throw new RuntimeError({
        code: "ENGINE_UNAVAILABLE",
        message: "Browser adapter must be registered with family 'browser'",
      });
    }
    if (!options.wait || options.wait.family !== "wait") {
      throw new RuntimeError({
        code: "ENGINE_UNAVAILABLE",
        message: "Wait adapter must be registered with family 'wait'",
      });
    }
    if (!options.narration || options.narration.family !== "narration") {
      throw new RuntimeError({
        code: "ENGINE_UNAVAILABLE",
        message: "Narration adapter must be registered with family 'narration'",
      });
    }
    if (!options.visual || options.visual.family !== "visual") {
      throw new RuntimeError({
        code: "ENGINE_UNAVAILABLE",
        message: "Visual adapter must be registered with family 'visual'",
      });
    }

    const map = new Map<EngineFamily, EngineAdapter>();
    map.set("editor", options.editor);
    map.set("terminal", options.terminal);
    map.set("browser", options.browser);
    map.set("wait", options.wait);
    map.set("narration", options.narration);
    map.set("visual", options.visual);

    this.adapters = map;
  }

  getAdapter(family: EngineFamily): EngineAdapter {
    if (family === "orchestrator") {
      throw new RuntimeError({
        code: "ENGINE_UNAVAILABLE",
        message: "Engine family 'orchestrator' is an internal orchestrator control plane, not an external engine adapter",
      });
    }

    const adapter = this.adapters.get(family);
    if (!adapter) {
      throw new RuntimeError({
        code: "ENGINE_UNAVAILABLE",
        message: `Engine family '${family}' is unavailable or not registered`,
      });
    }

    return adapter;
  }

  hasAdapter(family: EngineFamily): boolean {
    if (family === "orchestrator") return false;
    return this.adapters.has(family);
  }

  listRegisteredFamilies(): readonly EngineFamily[] {
    return CANONICAL_EXTERNAL_FAMILIES;
  }

  async resetAll(generation: number): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.reset(generation);
    }
  }

  async closeAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.close();
    }
  }
}

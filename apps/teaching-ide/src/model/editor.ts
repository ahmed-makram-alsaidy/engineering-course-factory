// Editor pane state — open tabs, active file, in-memory buffers, dirty flags.
// Pure functions over plain state. No persistence, no automation: the only
// thing that ever changes editor content is explicit user typing.

export interface EditorTabsState {
  /** Open file paths in open order. */
  open: readonly string[];
  active: string | null;
  /** Current buffer contents per open path (in-memory only). */
  buffers: Readonly<Record<string, string>>;
  /** Paths modified since open (in-memory only). */
  dirty: readonly string[];
}

export const initialEditorState: EditorTabsState = { open: [], active: null, buffers: {}, dirty: [] };

/** Open a file (or focus it if already open) and seed its buffer once. */
export function openFile(state: EditorTabsState, path: string, content: string): EditorTabsState {
  const alreadyOpen = state.open.includes(path);
  const buffers = alreadyOpen ? state.buffers : { ...state.buffers, [path]: state.buffers[path] ?? content };
  return { open: alreadyOpen ? state.open : [...state.open, path], active: path, buffers, dirty: state.dirty };
}

/** Close a tab; activate the right-hand neighbour, else the left-hand one.
 * Buffers are retained in memory so reopening restores the last state. */
export function closeTab(state: EditorTabsState, path: string): EditorTabsState {
  const index = state.open.indexOf(path);
  if (index === -1) return state;
  const open = state.open.filter((candidate) => candidate !== path);
  let active = state.active;
  if (state.active === path) {
    active = open[Math.min(index, open.length - 1)] ?? null;
  }
  return { open, active, buffers: state.buffers, dirty: state.dirty };
}

export function setActive(state: EditorTabsState, path: string): EditorTabsState {
  if (!state.open.includes(path)) return state;
  return { ...state, active: path };
}

/** Records explicit user typing only. */
export function setUserBuffer(state: EditorTabsState, path: string, content: string): EditorTabsState {
  if (!state.open.includes(path)) return state;
  const alreadyDirty = state.dirty.includes(path);
  return {
    ...state,
    buffers: { ...state.buffers, [path]: content },
    dirty: alreadyDirty ? state.dirty : [...state.dirty, path],
  };
}

export function bufferOf(state: EditorTabsState, path: string): string | undefined {
  return state.buffers[path];
}

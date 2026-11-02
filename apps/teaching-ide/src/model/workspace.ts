// Workspace model — the synthetic fixture file tree and its deterministic
// ordering. Pure data: no filesystem access; the file contents are bundled
// fixture text.

export interface WorkspaceFile {
  /** Project-relative POSIX path, e.g. src/server.ts */
  path: string;
  /** Editor language id (monaco language ids). */
  language: string;
  content: string;
}

export interface WorkspaceManifest {
  rootLabel: string;
  files: WorkspaceFile[];
}

export type TreeNodeKind = "dir" | "file";

export interface TreeNode {
  name: string;
  path: string;
  kind: TreeNodeKind;
  language?: string;
  children?: TreeNode[];
}

export function fileLanguage(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "ts":
      return "typescript";
    case "tsx":
      return "typescript";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
      return "json";
    case "html":
      return "html";
    case "css":
      return "css";
    case "py":
      return "python";
    case "md":
      return "markdown";
    default:
      return "plaintext";
  }
}

function dirSort(a: TreeNode, b: TreeNode): number {
  // Deterministic ordering: directories first, then files; alphabetical within
  // each group (UTF-16 code-unit order).
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Build a nested tree from a flat file list. Deterministic; pure. */
export function buildTree(manifest: WorkspaceManifest): TreeNode {
  const root: TreeNode = { name: manifest.rootLabel, path: "", kind: "dir", children: [] };
  for (const file of manifest.files) {
    const segments = file.path.split("/");
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const dirPath = segments.slice(0, i + 1).join("/");
      let child = node.children?.find((candidate) => candidate.kind === "dir" && candidate.path === dirPath);
      if (!child) {
        child = { name: segments[i], path: dirPath, kind: "dir", children: [] };
        node.children?.push(child);
      }
      node = child;
    }
    node.children?.push({
      name: segments[segments.length - 1],
      path: file.path,
      kind: "file",
      language: file.language ?? fileLanguage(file.path),
    });
  }
  const sortDeep = (node: TreeNode): void => {
    if (node.children) {
      node.children.sort(dirSort);
      node.children.forEach(sortDeep);
    }
  };
  sortDeep(root);
  return root;
}

/** Depth-first flattened view of the tree; directories in `collapsed` are closed. */
export interface TreeRow {
  node: TreeNode;
  depth: number;
}

export function flattenTree(node: TreeNode, collapsed: ReadonlySet<string>, depth = 0, rows: TreeRow[] = []): TreeRow[] {
  rows.push({ node, depth });
  if (node.kind === "dir" && node.children && (depth === 0 || !collapsed.has(node.path))) {
    for (const child of node.children) flattenTree(child, collapsed, depth + 1, rows);
  }
  return rows;
}

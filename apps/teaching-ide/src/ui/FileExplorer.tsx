// File explorer: deterministic tree over the bundled synthetic workspace.
// Clicking a file loads its static content into the editor pane.
import { useMemo } from "react";
import { buildTree, flattenTree, type WorkspaceManifest } from "../model/workspace.ts";

interface Props {
  manifest: WorkspaceManifest;
  activeFile: string | null;
  dirtyFiles: readonly string[];
  collapsed: ReadonlySet<string>;
  onToggleDir(path: string): void;
  onOpenFile(path: string): void;
}

const FILE_ICONS: Record<string, string> = {
  typescript: "TS",
  javascript: "JS",
  json: "{}",
  html: "<>",
  css: "#",
  python: "PY",
  markdown: "M",
  plaintext: "·",
};

export function FileExplorer(props: Props): React.JSX.Element {
  const tree = useMemo(() => buildTree(props.manifest), [props.manifest]);
  const rows = useMemo(() => flattenTree(tree, props.collapsed), [tree, props.collapsed]);

  return (
    <section className="panel" aria-label="File explorer">
      <div className="panel-header">
        Explorer — {tree.name}
      </div>
      <div className="panel-body">
        <ul className="tree">
          {rows.map(({ node, depth }) => {
            const indent = { paddingLeft: `${12 + depth * 14}px` };
            if (node.kind === "dir") {
              const expandedNow = !props.collapsed.has(node.path);
              return (
                <li
                  key={node.path || node.name}
                  className="tree-row dir"
                  style={indent}
                  onClick={() => props.onToggleDir(node.path)}
                >
                  <span className="icon">{expandedNow ? "▾" : "▸"}</span>
                  <span>{node.name}</span>
                </li>
              );
            }
            const isActive = node.path === props.activeFile;
            const isDirty = props.dirtyFiles.includes(node.path);
            return (
              <li
                key={node.path}
                className={`tree-row ${isActive ? "active" : ""}`}
                style={indent}
                onClick={() => props.onOpenFile(node.path)}
                title={node.path}
              >
                <span className="icon">{FILE_ICONS[node.language ?? "plaintext"] ?? "·"}</span>
                <span>{node.name}</span>
                {isDirty && <span className="dirty-mark">●</span>}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

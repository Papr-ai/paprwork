/**
 * Build a nested folder tree from flat workspace file paths.
 */

import type { WorkspaceFileEntry } from "../../hooks/useAppWorkspace";

export interface FileTreeNode {
  id: string;
  name: string;
  path: string;
  kind: "folder" | "file";
  fileKind?: WorkspaceFileEntry["kind"];
  readOnly?: boolean;
  children?: FileTreeNode[];
}

function insertPath(
  root: FileTreeNode[],
  entry: WorkspaceFileEntry,
  parts: string[],
  parentPath: string,
): void {
  if (parts.length === 1) {
    root.push({
      id: entry.path,
      name: parts[0],
      path: entry.path,
      kind: "file",
      fileKind: entry.kind,
      readOnly: entry.readOnly,
    });
    return;
  }

  const [head, ...rest] = parts;
  const folderPath = parentPath ? `${parentPath}/${head}` : head;
  let folder = root.find(
    (node) => node.kind === "folder" && node.path === folderPath,
  );

  if (!folder) {
    folder = {
      id: folderPath,
      name: head,
      path: folderPath,
      kind: "folder",
      children: [],
    };
    root.push(folder);
  }

  insertPath(folder.children ?? [], entry, rest, folderPath);
  folder.children = folder.children ?? [];
}

export function buildFileTree(entries: WorkspaceFileEntry[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const entry of entries) {
    const parts = entry.path.split("/");
    insertPath(root, entry, parts, "");
  }

  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] =>
    [...nodes]
      .sort((a, b) => {
        if (a.kind !== b.kind) {
          return a.kind === "folder" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      })
      .map((node) =>
        node.children
          ? { ...node, children: sortNodes(node.children) }
          : node,
      );

  return sortNodes(root);
}

export function collectFolderPaths(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === "folder") {
      paths.push(node.path);
      if (node.children) {
        paths.push(...collectFolderPaths(node.children));
      }
    }
  }
  return paths;
}

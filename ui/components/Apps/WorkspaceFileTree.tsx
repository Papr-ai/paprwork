/**
 * WorkspaceFileTree — nested folder tree for app/job workspace files.
 */

import React, { useEffect, useMemo, useState } from "react";
import {
  buildFileTree,
  collectFolderPaths,
  type FileTreeNode,
} from "../../utils/workspaceFileTree";
import type {
  WorkspaceFileEntry,
  WorkspaceFileKind,
  WorkspaceFileTarget,
} from "../../hooks/useAppWorkspace";
import "./WorkspaceFileTree.css";

interface WorkspaceFileTreeProps {
  entries: WorkspaceFileEntry[];
  scope: "app" | "job";
  appId: string;
  jobId?: string;
  selectedKey: string | null;
  onSelect: (target: WorkspaceFileTarget) => void;
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      {open ? (
        <path
          d="M4 7h5l2 2h9v10a2 2 0 01-2 2H4a2 2 0 01-2-2V7z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M4 7h5l2 2h9a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V7z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function FileIcon({ kind }: { kind?: WorkspaceFileKind }) {
  if (kind === "database") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <ellipse cx="12" cy="6" rx="7" ry="3" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <path
          d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      </svg>
    );
  }

  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M8 4h7l3 3v13a2 2 0 01-2 2H8a2 2 0 01-2-2V6a2 2 0 012-2z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M15 4v4h4" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function toTarget(
  node: FileTreeNode,
  scope: "app" | "job",
  appId: string,
  jobId?: string,
): WorkspaceFileTarget {
  if (scope === "job" && jobId) {
    return {
      scope: "job",
      jobId,
      path: node.path,
      kind: node.fileKind ?? "file",
      readOnly: node.readOnly ?? false,
    };
  }
  return {
    scope: "app",
    appId,
    path: node.path,
    kind: node.fileKind ?? "file",
    readOnly: node.readOnly ?? false,
  };
}

function targetKey(target: WorkspaceFileTarget): string {
  if (target.scope === "app") {
    return `app:${target.path}`;
  }
  return `job:${target.jobId}:${target.path}`;
}

interface TreeBranchProps {
  nodes: FileTreeNode[];
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  scope: "app" | "job";
  appId: string;
  jobId?: string;
  selectedKey: string | null;
  onSelect: (target: WorkspaceFileTarget) => void;
}

function TreeBranch({
  nodes,
  depth,
  expanded,
  onToggle,
  scope,
  appId,
  jobId,
  selectedKey,
  onSelect,
}: TreeBranchProps) {
  return (
    <ul className="workspace-file-tree__list">
      {nodes.map((node) => {
        if (node.kind === "folder") {
          const isOpen = expanded.has(node.path);
          return (
            <li key={node.id} className="workspace-file-tree__item">
              <button
                type="button"
                className="workspace-file-tree__folder"
                style={{ paddingLeft: `${12 + depth * 14}px` }}
                onClick={() => onToggle(node.path)}
              >
                <FolderIcon open={isOpen} />
                <span>{node.name}</span>
              </button>
              {isOpen && node.children ? (
                <TreeBranch
                  nodes={node.children}
                  depth={depth + 1}
                  expanded={expanded}
                  onToggle={onToggle}
                  scope={scope}
                  appId={appId}
                  jobId={jobId}
                  selectedKey={selectedKey}
                  onSelect={onSelect}
                />
              ) : null}
            </li>
          );
        }

        const target = toTarget(node, scope, appId, jobId);
        const active = selectedKey === targetKey(target);
        return (
          <li key={node.id} className="workspace-file-tree__item">
            <button
              type="button"
              className={
                active
                  ? "workspace-file-tree__file workspace-file-tree__file--active"
                  : "workspace-file-tree__file"
              }
              style={{ paddingLeft: `${12 + depth * 14}px` }}
              onClick={() => onSelect(target)}
            >
              <FileIcon kind={node.fileKind} />
              <span className="workspace-file-tree__file-name">{node.name}</span>
              {node.fileKind === "database" ? (
                <span className="workspace-file-tree__badge">db</span>
              ) : null}
              {node.readOnly && node.fileKind !== "database" ? (
                <span className="workspace-file-tree__badge">read-only</span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function WorkspaceFileTree({
  entries,
  scope,
  appId,
  jobId,
  selectedKey,
  onSelect,
}: WorkspaceFileTreeProps) {
  const tree = useMemo(() => buildFileTree(entries), [entries]);
  const defaultExpanded = useMemo(() => new Set(collectFolderPaths(tree)), [tree]);
  const [expanded, setExpanded] = useState<Set<string>>(defaultExpanded);

  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const path of defaultExpanded) {
        next.add(path);
      }
      return next;
    });
  }, [defaultExpanded]);

  const onToggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <TreeBranch
      nodes={tree}
      depth={0}
      expanded={expanded}
      onToggle={onToggle}
      scope={scope}
      appId={appId}
      jobId={jobId}
      selectedKey={selectedKey}
      onSelect={onSelect}
    />
  );
}

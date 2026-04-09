/**
 * ContextPills - Display active context artifacts
 * Reference: Paprwork v1 context pills
 */

import React from "react";
import type { Artifact } from "../../stores/artifactsStore";
import "./ContextPills.css";

interface ContextPillsProps {
  artifacts: Artifact[];
  onRemove: (id: string) => void;
  onAddClick: () => void;
}

export function ContextPills({
  artifacts,
  onRemove,
  onAddClick,
}: ContextPillsProps) {
  return (
    <div className="context-pills">
      <button className="context-pill context-pill--add" onClick={onAddClick}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 5v14M5 12h14"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        <span>Add context</span>
      </button>

      {artifacts.map((artifact) => (
        <div key={artifact.id} className="context-pill">
          <span className="context-pill__icon">
            {artifact.type === "file" ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path
                  d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path
                  d="M14 2v6h6M9 15h6M9 11h6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            ) : artifact.type === "document" ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path
                  d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <rect
                  x="3"
                  y="3"
                  width="7"
                  height="7"
                  rx="1"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <rect
                  x="14"
                  y="3"
                  width="7"
                  height="7"
                  rx="1"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <rect
                  x="3"
                  y="14"
                  width="7"
                  height="7"
                  rx="1"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <rect
                  x="14"
                  y="14"
                  width="7"
                  height="7"
                  rx="1"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            )}
          </span>
          <span className="context-pill__title">{artifact.title}</span>
          <button
            className="context-pill__remove"
            onClick={() => onRemove(artifact.id)}
            aria-label="Remove"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

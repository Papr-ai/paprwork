/**
 * ContextDropdown - Searchable artifact selector for chat context
 * Reference: Paprwork v1 app.js lines 6970-7094
 */

import React, { useState, useEffect, useRef } from "react";
import { useArtifacts } from "../../hooks/useArtifacts";
import type { Artifact } from "../../stores/artifactsStore";
import "./ContextDropdown.css";

interface ContextDropdownProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectArtifact: (artifact: Artifact) => void;
  selectedIds: string[];
}

export function ContextDropdown({
  isOpen,
  onClose,
  onSelectArtifact,
  selectedIds,
}: ContextDropdownProps) {
  const { artifacts, loading } = useArtifacts();
  const [searchQuery, setSearchQuery] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Filter artifacts based on search
  const filteredArtifacts = artifacts.filter((a) => {
    const matchesSearch = searchQuery
      ? a.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        a.tags?.some((tag) =>
          tag.toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : true;
    return matchesSearch && !selectedIds.includes(a.id);
  });

  // Handle click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, onClose]);

  // Focus search input when opened
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="context-dropdown" ref={dropdownRef}>
      <div className="context-dropdown__header">
        <input
          ref={searchInputRef}
          type="text"
          className="context-dropdown__search"
          placeholder="Search artifacts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="context-dropdown__content">
        {loading && (
          <div className="context-dropdown__loading">Loading artifacts...</div>
        )}

        {!loading && filteredArtifacts.length === 0 && (
          <div className="context-dropdown__empty">
            {searchQuery ? "No matching artifacts" : "No artifacts available"}
          </div>
        )}

        {!loading && filteredArtifacts.length > 0 && (
          <div className="context-dropdown__list">
            {filteredArtifacts.map((artifact) => (
              <button
                key={artifact.id}
                className="context-dropdown__item"
                onClick={() => {
                  onSelectArtifact(artifact);
                  setSearchQuery("");
                }}
              >
                <span className="context-dropdown__item-icon">
                  {artifact.type === "document" ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                      <path
                        d="M14 2v6h6"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
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
                <div className="context-dropdown__item-content">
                  <span className="context-dropdown__item-title">
                    {artifact.title}
                  </span>
                  <span className="context-dropdown__item-type">
                    {artifact.type === "document" ? "Document" : "App"}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

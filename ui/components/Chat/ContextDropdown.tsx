/**
 * ContextDropdown - Compact artifact & file selector for chat context
 * Matches ChatHistoryDropdown design for consistency
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
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // Handle file upload - create artifact from file path
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // For each selected file, create an artifact with the file path
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // Use the file's path (available in Electron) or name
      const filePath = (file as any).path || file.name;
      
      // Create a pseudo-artifact representing the file
      const fileArtifact: Artifact = {
        id: `file-${Date.now()}-${i}`,
        title: file.name,
        type: "document",
        content: `File path: ${filePath}`,
        tags: ["file-upload"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // Store file path in metadata so LLM can access it
        metadata: {
          filePath,
          fileSize: file.size,
          fileType: file.type || "unknown",
        },
      };

      onSelectArtifact(fileArtifact);
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="context-dropdown" ref={dropdownRef}>
      {/* Search Input */}
      <div className="context-dropdown-search">
        <input
          ref={searchInputRef}
          type="text"
          className="context-dropdown-search-input"
          placeholder="Search..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          autoFocus
        />
      </div>

      {/* File Upload Button - below search */}
      <div className="context-dropdown-upload">
        <button
          className="context-dropdown-upload-btn"
          onClick={() => fileInputRef.current?.click()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path
              d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Attach or Upload File</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleFileUpload}
          accept=".txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.java,.c,.cpp,.h,.css,.html,.xml,.yaml,.yml,.sh,.sql,.go,.rs,.rb,.php,.swift,.kt"
        />
      </div>

      {/* Artifacts List */}
      <div className="context-dropdown-list">
        {loading && (
          <div className="context-dropdown-empty">Loading artifacts...</div>
        )}

        {!loading && filteredArtifacts.length === 0 && (
          <div className="context-dropdown-empty">
            {searchQuery ? "No matching artifacts" : "No artifacts available"}
          </div>
        )}

        {!loading && filteredArtifacts.length > 0 && (
          <>
            {filteredArtifacts.map((artifact) => (
              <button
                key={artifact.id}
                className="context-dropdown-item"
                onClick={() => {
                  onSelectArtifact(artifact);
                  setSearchQuery("");
                }}
              >
                <div className="context-dropdown-item-content">
                  <div className="context-dropdown-item-header">
                    <span className="context-dropdown-item-icon">
                      {artifact.type === "document" ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
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
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
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
                    <span className="context-dropdown-item-title">
                      {artifact.title}
                    </span>
                  </div>
                  <span className="context-dropdown-item-type">
                    {artifact.type === "document" ? "Document" : "App"}
                  </span>
                </div>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

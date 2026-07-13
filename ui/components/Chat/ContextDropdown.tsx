/**
 * ContextDropdown - Compact artifact & file selector for chat context
 * Matches ChatHistoryDropdown design for consistency
 */

import React, { useState, useEffect, useRef } from "react";
import { useArtifacts } from "../../hooks/useArtifacts";
import {
  artifactTypeLabel,
  type Artifact,
} from "../../stores/artifactsStore";
import { createArtifactsFromIncomingFiles } from "../../utils/chatAttachmentFiles";
import "./ContextDropdown.css";

interface ContextDropdownProps {
  chatId: string;
  isOpen: boolean;
  onClose: () => void;
  onSelectArtifact: (artifact: Artifact) => void;
  selectedIds: string[];
}

export function ContextDropdown({
  chatId,
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

    const artifacts = await createArtifactsFromIncomingFiles(
      Array.from(files),
      chatId,
    );
    for (const fileArtifact of artifacts) {
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
          accept=".txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.java,.c,.cpp,.h,.css,.html,.xml,.yaml,.yml,.sh,.sql,.go,.rs,.rb,.php,.swift,.kt,.pdf,.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp,.tif,.tiff,image/*,application/pdf"
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
                    {artifactTypeLabel(artifact.type)}
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

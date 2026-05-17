/**
 * DocumentView - TipTap document editor with slash commands and bubble menu
 *
 * Features:
 *  - Slash commands (type "/" for formatting menu)
 *  - Bubble menu on text selection (Bold, Italic, Underline, Strike)
 *  - Inline editable title
 *  - Auto-save (debounced 1s)
 *  - Version history + DOCX export in top-right header
 *  - File-change watching (reloads on external bash edits)
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { CustomMarkdown } from "./CustomMarkdown";
import { DocumentMarkdownItTables } from "./DocumentMarkdownItTables";
import { SlashCommandExtension } from "./SlashCommandExtension";
import { useDocument } from "../../hooks/useDocuments";
import { gateway } from "../../src/lib/gateway";
import { VersionHistory } from "./VersionHistory";
import "./DocumentView.css";

interface DocumentViewProps {
  documentId: string;
}

export function DocumentView({ documentId }: DocumentViewProps) {
  const {
    document,
    loading,
    error,
    saving,
    debouncedSave,
    updateTitle,
    loadDocument,
    versions,
    loadVersions,
    getVersion,
    restoreVersion,
  } = useDocument(documentId);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState("");
  const [showVersions, setShowVersions] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const isLoadingContent = useRef(false);
  const [showBubbleMenu, setShowBubbleMenu] = useState(false);
  const [bubbleMenuPos, setBubbleMenuPos] = useState({ top: 0, left: 0 });
  const editorWrapperRef = useRef<HTMLDivElement>(null);
  const [currentWordCount, setCurrentWordCount] = useState(0);

  // Calculate word count from text
  const calculateWordCount = useCallback((text: string): number => {
    if (!text.trim()) return 0;
    return text.trim().split(/\s+/).length;
  }, []);

  // TipTap editor with slash commands
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      DocumentMarkdownItTables,
      Underline,
      Placeholder.configure({
        placeholder: 'Start typing or press "/" for commands...',
      }),
      CustomMarkdown,
      SlashCommandExtension,
    ],
    content: "",
    onUpdate: ({ editor: ed }) => {
      if (isLoadingContent.current) return;
      const markdown =
        (ed.storage.markdown?.getMarkdown() as string) ?? ed.getText();
      
      // Update word count in real-time
      setCurrentWordCount(calculateWordCount(markdown));
      
      debouncedSave(markdown);
    },
  });

  // Bubble menu: show on text selection, hide on empty selection (V1 pattern)
  useEffect(() => {
    if (!editor) return;

    const MENU_WIDTH = 280; // approximate width of the bubble menu
    const MENU_HEIGHT = 40;
    const GAP = 8; // space between menu and selection

    const updateBubbleMenu = () => {
      const { from, to, empty } = editor.state.selection;
      if (empty) {
        setShowBubbleMenu(false);
        return;
      }

      const wrapper = editorWrapperRef.current;
      if (!wrapper) return;

      const start = editor.view.coordsAtPos(from);
      const end = editor.view.coordsAtPos(to);
      const wrapperRect = wrapper.getBoundingClientRect();

      // Ideal center between selection start and end, relative to wrapper
      const idealCenter = (start.left + end.left) / 2 - wrapperRect.left;
      const halfMenu = MENU_WIDTH / 2;

      // Clamp so menu stays within the wrapper bounds (with 8px padding)
      const minLeft = halfMenu + 8;
      const maxLeft = wrapperRect.width - halfMenu - 8;
      const clampedLeft = Math.max(minLeft, Math.min(maxLeft, idealCenter));

      // Position above the selection; if too close to top, show below instead
      const topAbove =
        start.top - wrapperRect.top + wrapper.scrollTop - MENU_HEIGHT - GAP;
      const topBelow = end.bottom - wrapperRect.top + wrapper.scrollTop + GAP;
      const top = topAbove < 0 ? topBelow : topAbove;

      setBubbleMenuPos({ top, left: clampedLeft });
      setShowBubbleMenu(true);
    };

    editor.on("selectionUpdate", updateBubbleMenu);
    editor.on("update", updateBubbleMenu);

    return () => {
      editor.off("selectionUpdate", updateBubbleMenu);
      editor.off("update", updateBubbleMenu);
    };
  }, [editor]);

  // Sync document content into editor without yanking the user's scroll position.
  useEffect(() => {
    if (!document || !editor) return;

    const currentMarkdown =
      (editor.storage.markdown?.getMarkdown() as string) ?? editor.getText();
    if (currentMarkdown !== document.content) {
      const wrapper = editorWrapperRef.current;
      const scrollTop = wrapper?.scrollTop ?? 0;
      const { from, to } = editor.state.selection;

      isLoadingContent.current = true;
      editor.commands.setContent(document.content || "", false, {
        preserveWhitespace: "full",
      });
      if (from <= editor.state.doc.content.size && to <= editor.state.doc.content.size) {
        editor.commands.setTextSelection({ from, to });
      }
      isLoadingContent.current = false;

      // TipTap/ProseMirror may scroll the selection into view after setContent.
      // Restore on the next frames so auto-save/file refreshes don't jump upward.
      if (wrapper) {
        wrapper.scrollTop = scrollTop;
        requestAnimationFrame(() => {
          wrapper.scrollTop = scrollTop;
          requestAnimationFrame(() => {
            wrapper.scrollTop = scrollTop;
          });
        });
      }
      
      // Update word count when loading new content
      setCurrentWordCount(calculateWordCount(document.content || ""));
    }
    setTitleValue(document.title);
  }, [document, editor, calculateWordCount]);

  // Title editing
  const startEditingTitle = useCallback(() => {
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  }, []);

  const commitTitle = useCallback(() => {
    setEditingTitle(false);
    if (titleValue.trim() && titleValue !== document?.title) {
      updateTitle(titleValue.trim());
    }
  }, [titleValue, document?.title, updateTitle]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitTitle();
      } else if (e.key === "Escape") {
        setEditingTitle(false);
        setTitleValue(document?.title ?? "");
      }
    },
    [commitTitle, document?.title],
  );

  // Version history toggle
  const toggleVersions = useCallback(() => {
    const nextShow = !showVersions;
    setShowVersions(nextShow);
    if (nextShow) loadVersions();
  }, [showVersions, loadVersions]);

  // Restore handler
  const handleRestore = useCallback(
    async (versionId: string) => {
      await restoreVersion(versionId);
      setShowVersions(false);
    },
    [restoreVersion],
  );

  // Export DOCX
  const handleExport = useCallback(async () => {
    if (!documentId) return;
    try {
      const response = await gateway.send("document:export", { documentId });
      const data = response.data as {
        filename: string;
        base64: string;
        mimeType: string;
      };
      if (!data?.base64) return;

      const byteChars = atob(data.base64);
      const byteNumbers = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) {
        byteNumbers[i] = byteChars.charCodeAt(i);
      }
      const blob = new Blob([byteNumbers], { type: data.mimeType });
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement("a");
      a.href = url;
      a.download = data.filename;
      window.document.body.appendChild(a);
      a.click();
      window.document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[DocumentView] Export error:", err);
    }
  }, [documentId]);

  if (loading) {
    return (
      <div className="document-view document-view--loading">
        <div className="document-view__spinner" />
      </div>
    );
  }

  if (error || !document) {
    const isConnectionError =
      error?.includes("not connected") || error?.includes("timeout");
    return (
      <div className="document-view document-view--error">
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          opacity="0.35"
        >
          {isConnectionError ? (
            <path
              d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0119 12.55M5 12.55a10.94 10.94 0 015.17-2.39M10.71 5.05A16 16 0 0122.56 9M1.42 9a15.91 15.91 0 014.7-2.88M8.53 16.11a6 6 0 016.95 0M12 20h.01"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : (
            <>
              <path
                d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.5" />
            </>
          )}
        </svg>
        <p className="document-view__error-title">
          {isConnectionError ? "Connecting to server..." : "Document not found"}
        </p>
        <p className="document-view__error-detail">
          {isConnectionError
            ? "Waiting for the gateway to come online."
            : error || "This document may have been deleted or moved."}
        </p>
        <button className="document-view__retry-btn" onClick={loadDocument}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="document-view">
      {/* Header — title left, actions right */}
      <div className="document-view__header">
        <div className="document-view__header-left">
          {editingTitle ? (
            <input
              ref={titleInputRef}
              className="document-view__title-input"
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={handleTitleKeyDown}
              autoFocus
            />
          ) : (
            <h1
              className="document-view__title"
              onClick={startEditingTitle}
              title="Click to edit title"
            >
              {document.title || "Untitled Document"}
            </h1>
          )}
          <span className="document-view__meta">
            {currentWordCount.toLocaleString()} words
            {saving && (
              <span className="document-view__save-dot" title="Saving..." />
            )}
          </span>
        </div>

        <div className="document-view__header-actions">
          {saving && (
            <span className="document-view__save-status">Saving...</span>
          )}
          <button
            className="document-view__action-btn"
            onClick={toggleVersions}
            title="Version History"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </button>
          <button
            className="document-view__action-btn"
            onClick={handleExport}
            title="Export as DOCX"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Editor area + optional version sidebar */}
      <div className="document-view__body">
        <div className="document-view__editor-wrapper" ref={editorWrapperRef}>
          {/* Bubble menu on text selection */}
          {showBubbleMenu && editor && (
            <div
              className="document-view__bubble-menu"
              style={{
                position: "absolute",
                top: `${bubbleMenuPos.top}px`,
                left: `${bubbleMenuPos.left}px`,
                transform: "translateX(-50%)",
                zIndex: 100,
              }}
            >
              <BubbleButton
                label="B"
                title="Bold"
                active={editor.isActive("bold")}
                onClick={() => editor.chain().focus().toggleBold().run()}
              />
              <BubbleButton
                label="I"
                title="Italic"
                active={editor.isActive("italic")}
                onClick={() => editor.chain().focus().toggleItalic().run()}
                italic
              />
              <BubbleButton
                label="U"
                title="Underline"
                active={editor.isActive("underline")}
                onClick={() => editor.chain().focus().toggleUnderline().run()}
                underline
              />
              <BubbleButton
                label="S"
                title="Strikethrough"
                active={editor.isActive("strike")}
                onClick={() => editor.chain().focus().toggleStrike().run()}
                strike
              />
              <span className="document-view__bubble-divider" />
              <BubbleButton
                label="H1"
                title="Heading 1"
                active={editor.isActive("heading", { level: 1 })}
                onClick={() =>
                  editor.chain().focus().toggleHeading({ level: 1 }).run()
                }
              />
              <BubbleButton
                label="H2"
                title="Heading 2"
                active={editor.isActive("heading", { level: 2 })}
                onClick={() =>
                  editor.chain().focus().toggleHeading({ level: 2 }).run()
                }
              />
              <BubbleButton
                label="❝"
                title="Blockquote"
                active={editor.isActive("blockquote")}
                onClick={() => editor.chain().focus().toggleBlockquote().run()}
              />
            </div>
          )}
          <EditorContent editor={editor} className="document-view__editor" />
        </div>

        {showVersions && (
          <VersionHistory
            versions={versions}
            onGetVersion={getVersion}
            onRestore={handleRestore}
            onClose={() => setShowVersions(false)}
          />
        )}
      </div>
    </div>
  );
}

// ===== Bubble menu button =====

interface BubbleButtonProps {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

function BubbleButton({
  label,
  title,
  active,
  onClick,
  italic,
  underline,
  strike,
}: BubbleButtonProps) {
  let style: React.CSSProperties | undefined;
  if (italic) style = { fontStyle: "italic" };
  if (underline) style = { textDecoration: "underline" };
  if (strike) style = { textDecoration: "line-through" };

  return (
    <button
      className={`document-view__bubble-btn${active ? " document-view__bubble-btn--active" : ""}`}
      onClick={onClick}
      title={title}
      type="button"
      style={style}
    >
      {label}
    </button>
  );
}

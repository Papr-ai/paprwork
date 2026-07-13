/**
 * WikiLibrary — Netflix-style wiki browser for the knowledge graph
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Markdown } from "../common/Markdown";
import { gateway } from "../../src/lib/gateway";
import type { WikiEntityData, WikiHomeData, WikiNode, WikiRail, WikiRelationship, WikiEvidence, WikiRelatedMemory } from "../../types/wiki";
import { collectWikiNodes, normalizeWikiNode, wikiTypeMeta } from "../../types/wiki";
import {
  countPlaceholderContextFiles,
  isWorkspaceFilePlaceholder,
} from "../../utils/memoryWorkspaceHealth";
import { MemorySetupPanel } from "./MemorySetupPanel";
import "./WikiLibrary.css";

interface WorkspaceFilePreview {
  name: string;
  content: string;
  size: number;
  truncated: boolean;
  rawLength: number;
}

const FOCUS_CACHE_KEY = "memory-view-focus";

function fileLabel(name: string): string {
  return name.replace(/\.(md|txt|yaml|yml|json)$/i, "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface WikiLibraryProps {
  refreshToken?: number;
  paletteOpen?: boolean;
  onPaletteOpenChange?: (open: boolean) => void;
  onFocusChange?: (label: string | null, backFn: (() => void) | null) => void;
}

function bodyPreview(body: string, maxLen = 140): string {
  const plain = body
    .replace(/[#*_`[\]]/g, "")
    .replace(/\n+/g, " ")
    .trim();
  return plain.length > maxLen ? `${plain.slice(0, maxLen)}…` : plain;
}

/* ── Cards ────────────────────────────────────────── */

function PosterCard({ node, onClick }: { node: WikiNode; onClick: () => void }) {
  const meta = wikiTypeMeta(node.type);
  const props = node.props ?? {};
  const status = props.status ? String(props.status) : null;
  return (
    <article className="wiki-card poster" onClick={onClick}>
      <div className="wiki-card__art">
        <div className="wiki-card__gradient"
          style={{ background: `linear-gradient(135deg, ${meta.color}, color-mix(in srgb, ${meta.color} 70%, #000))` }} />
        <span className="wiki-card__type-chip">{meta.label}</span>
        {status ? <span className="wiki-card__status"><span className="wiki-card__status-dot" />{status}</span> : null}
        <span className="wiki-card__glyph">{meta.glyph}</span>
      </div>
      <div className="wiki-card__body">
        <h4 className="wiki-card__title">{node.label}</h4>
        {node.description ? <p className="wiki-card__preview">{bodyPreview(node.description)}</p> : null}
      </div>
    </article>
  );
}

function PersonCard({ node, onClick }: { node: WikiNode; onClick: () => void }) {
  const label = node.label ?? node.id;
  const initials = label.split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  const props = node.props ?? {};
  return (
    <article className="wiki-card person" onClick={onClick}>
      <div className="wiki-card__avatar">{initials || "?"}</div>
      <div className="wiki-card__name">{label}</div>
      {props.role ? <div className="wiki-card__role">{String(props.role)}</div> : null}
    </article>
  );
}

function EntityCard({ node, onClick }: { node: WikiNode; onClick: () => void }) {
  if (node.type === "person") return <PersonCard node={node} onClick={onClick} />;
  return <PosterCard node={node} onClick={onClick} />;
}

/* ── Rail ────────────────────────────────────────── */


function ContextFileCard({ file, onOpen }: { file: WorkspaceFilePreview; onOpen: (file: WorkspaceFilePreview) => void }) {
  const needsSetup = isWorkspaceFilePlaceholder(file.content);
  return (
    <article className={`wiki-card poster wiki-card--context${needsSetup ? " wiki-card--context-setup" : ""}`} onClick={() => onOpen(file)}>
      <div className="wiki-card__art wiki-card__art--context">
        <div className="wiki-card__gradient wiki-card__gradient--context" />
        <span className="wiki-card__type-chip">{needsSetup ? "Setup needed" : "Context"}</span>
        <span className="wiki-card__glyph">md</span>
      </div>
      <div className="wiki-card__body">
        <h4 className="wiki-card__title">{fileLabel(file.name)}</h4>
        <p className="wiki-card__preview">
          {needsSetup
            ? "Template placeholder — edit or complete setup chat"
            : bodyPreview(file.content, 240) || "Empty context file"}
        </p>
        <div className="wiki-card__meta">
          <span>{Math.max(1, Math.round(file.size / 1024))} KB</span>
          {file.truncated ? <span>Preview</span> : null}
        </div>
      </div>
    </article>
  );
}

function WikiRailSection({ rail, onPick, onAdd }: { rail: WikiRail; onPick: (n: WikiNode) => void; onAdd?: (railTitle: string) => void }) {
  if (rail.items.length === 0) return null;
  return (
    <section className="wiki-rail">
      <div className="wiki-rail__head">
        <h2>{rail.title}</h2>
        {rail.reason ? <span className="wiki-rail__reason">{rail.reason}</span> : null}
        {onAdd ? <button type="button" className="wiki-rail__add" onClick={() => onAdd(rail.title)}>+</button> : null}
      </div>
      <div className="wiki-rail__track">
        {rail.items.map((item) => (
          <EntityCard key={`${item.type}-${item.id}`} node={item} onClick={() => onPick(item)} />
        ))}
      </div>
    </section>
  );
}

/* ── Search Palette ────────────────────────────────── */

function SearchPalette({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (n: WikiNode) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WikiNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);

  useEffect(() => { if (!open) return; setQuery(""); setResults([]); setSelected(0); }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) { setResults([]); return; }
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await gateway.send("memory:wiki-search", { query: trimmed });
        setResults((response.data as { results?: WikiNode[] } | undefined)?.results ?? []);
        setSelected(0);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowDown") { event.preventDefault(); setSelected((s) => Math.min(s + 1, Math.max(results.length - 1, 0))); }
      else if (event.key === "ArrowUp") { event.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
      else if (event.key === "Enter" && results[selected]) { onPick(results[selected]); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, results, selected, onClose, onPick]);

  if (!open) return null;
  return (
    <div className="wiki-palette-scrim" onClick={onClose} role="presentation">
      <div className="wiki-palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <input className="wiki-palette__input" placeholder="Search your knowledge graph…" value={query}
          onChange={(e) => setQuery(e.target.value)} autoFocus />
        <div className="wiki-palette__results">
          {loading ? <div className="wiki-palette__empty">Searching…</div> : null}
          {!loading && query.trim() && results.length === 0 ? <div className="wiki-palette__empty">No matches found.</div> : null}
          {results.map((node, index) => {
            const meta = wikiTypeMeta(node.type);
            return (
              <button key={`${node.type}-${node.id}`} type="button"
                className={`wiki-palette__result${index === selected ? " wiki-palette__result--sel" : ""}`}
                onMouseEnter={() => setSelected(index)} onClick={() => { onPick(node); onClose(); }}>
                <span className="wiki-palette__glyph" style={{ color: meta.color }}>{meta.glyph}</span>
                <span className="wiki-palette__label">{node.label}</span>
                <span className="wiki-palette__meta">{meta.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── Wiki Section Renderer ────────────────────────────── */


/* ── Create Entity / Add Type Dialog ──────────────── */

function CreateDialog({ open, onClose, onCreated, existingTypes }: {
  open: boolean; onClose: () => void; onCreated: () => void; existingTypes: string[];
}) {
  const [mode, setMode] = useState<"entity" | "type">("entity");
  const [typeName, setTypeName] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("📌");
  const [selectedType, setSelectedType] = useState("");
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      if (mode === "type" && typeName.trim()) {
        await gateway.send("memory:wiki-add-type", {
          typeName: typeName.trim().toLowerCase().replace(/\s+/g, "_"),
          icon,
          description: description.trim(),
        });
      } else if (mode === "entity" && name.trim() && selectedType) {
        await gateway.send("memory:wiki-create-entity", {
          type: selectedType,
          name: name.trim(),
          description: description.trim(),
        });
      }
      onCreated();
      onClose();
      setTypeName(""); setName(""); setDescription(""); setIcon("📌"); setSelectedType("");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="wiki-palette-backdrop" onClick={onClose}>
      <div className="wiki-create-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="wiki-create-dialog__tabs">
          <button type="button" className={`wiki-create-dialog__tab ${mode === "entity" ? "active" : ""}`}
            onClick={() => setMode("entity")}>+ Entity</button>
          <button type="button" className={`wiki-create-dialog__tab ${mode === "type" ? "active" : ""}`}
            onClick={() => setMode("type")}>+ Type</button>
        </div>

        {mode === "entity" ? (
          <div className="wiki-create-dialog__form">
            <label>Type
              <select value={selectedType} onChange={(e) => setSelectedType(e.target.value)}>
                <option value="">Select type...</option>
                {existingTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
            <label>Name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Newton Howard" autoFocus />
            </label>
            <label>Description (optional)
              <textarea value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description..." rows={3} />
            </label>
          </div>
        ) : (
          <div className="wiki-create-dialog__form">
            <label>Type name
              <input type="text" value={typeName} onChange={(e) => setTypeName(e.target.value)}
                placeholder="e.g. investors, research_papers" autoFocus />
            </label>
            <label>Icon
              <input type="text" value={icon} onChange={(e) => setIcon(e.target.value)}
                placeholder="📌" style={{ width: 60 }} />
            </label>
            <label>Description
              <input type="text" value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="What this type represents..." />
            </label>
          </div>
        )}

        {saveError ? <p className="wiki-create-dialog__error">{saveError}</p> : null}

        <div className="wiki-create-dialog__actions">
          <button type="button" className="wiki-btn wiki-btn--secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="wiki-btn wiki-btn--primary" onClick={handleSubmit}
            disabled={saving || (mode === "entity" ? !name.trim() || !selectedType : !typeName.trim())}>
            {saving ? "Creating..." : mode === "entity" ? "Create Entity" : "Add Type"}
          </button>
        </div>
      </div>
    </div>
  );
}

const SECTION_ORDER = ["Context & Background", "Key Details", "Key Interactions", "Decisions & Insights", "Open Items", "Changelog"];
const SECTION_ICONS: Record<string, string> = {
  "Context & Background": "◉", "Key Details": "◈", "Key Interactions": "▸",
  "Decisions & Insights": "◆", "Open Items": "☐", "Changelog": "▪",
};

function displaySectionsFor(node: WikiNode): Record<string, string> {
  const sections = { ...(node.sections ?? {}) };
  if (!sections["Context & Background"] && node.description) sections["Context & Background"] = node.description;
  if (!sections["Key Details"]) {
    const facts = Object.entries(node.props ?? {})
      .filter(([k, v]) => v != null && String(v).trim() !== "" && !["description", "description_short"].includes(k))
      .slice(0, 12)
      .map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${String(v)}`);
    sections["Key Details"] = facts.length ? facts.join("\n") : `- Type: ${node.type}\n- ID: ${node.id}`;
  }
  if (!sections["Key Interactions"] && node.evidence?.length) {
    sections["Key Interactions"] = node.evidence.map((e) => `- ${e.date || "Undated"} — ${e.summary || e.source}`).join("\n");
  }
  if (!sections["Decisions & Insights"]) sections["Decisions & Insights"] = "- No durable decisions or insights have been captured yet.";
  if (!sections["Open Items"]) sections["Open Items"] = "No open items captured yet.";
  if (!sections["Changelog"]) sections["Changelog"] = "- No changelog entries captured yet.";
  return sections;
}

function WikiSection({ title, content }: { title: string; content: string }) {
  const [expanded, setExpanded] = useState(title === "Context & Background");
  const lines = content.split("\n").filter(Boolean);
  const icon = SECTION_ICONS[title] ?? "▸";

  return (
    <div className="wiki-section">
      <button type="button" className={`wiki-section__header ${expanded ? "expanded" : ""}`}
        onClick={() => setExpanded(!expanded)}>
        <span className="wiki-section__icon">{icon}</span>
        <span className="wiki-section__title">{title}</span>
        <span className="wiki-section__count">{lines.length} items</span>
        <span className="wiki-section__chevron">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded ? (
        <div className="wiki-section__body">
          {lines.map((line, i) => {
            const bullet = line.match(/^[-*]\s*\[([x ])\]\s*(.+)/i);
            if (bullet) {
              return (
                <div key={i} className={`wiki-section__check ${bullet[1] !== " " ? "done" : ""}`}>
                  <span>{bullet[1] !== " " ? "■" : "☐"}</span>
                  <span>{bullet[2]}</span>
                </div>
              );
            }
            const dated = line.match(/^[-*]\s*\*?\*?(\d{4}-\d{2}-\d{2})\*?\*?[:\s]+(.+)/);
            if (dated) {
              return (
                <div key={i} className="wiki-section__dated">
                  <span className="wiki-section__date">{dated[1]}</span>
                  <span>{dated[2]}</span>
                </div>
              );
            }
            return <p key={i} className="wiki-section__text">{line.replace(/^[-*]\s*/, "")}</p>;
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ── Relationships Panel ────────────────────────────── */

function RelationshipsPanel({ relationships, onPick, allNodes }: {
  relationships: WikiRelationship[];
  onPick: (n: WikiNode) => void;
  allNodes: WikiNode[];
}) {
  if (!relationships?.length) return null;
  const grouped = new Map<string, WikiRelationship[]>();
  for (const r of relationships) {
    const list = grouped.get(r.type) ?? [];
    list.push(r);
    grouped.set(r.type, list);
  }

  return (
    <div className="wiki-relationships">
      <h3 className="wiki-relationships__title">Relationships ({relationships.length})</h3>
      {[...grouped.entries()].map(([type, rels]) => (
        <div key={type} className="wiki-rel-group">
          <div className="wiki-rel-group__type">{type}</div>
          {rels.map((r, i) => {
            const targetId = r.target;
            const targetNode = allNodes.find((n) => n.id === targetId);
            const targetMeta = targetNode ? wikiTypeMeta(targetNode.type) : null;
            return (
              <div key={i} className="wiki-rel-item"
                onClick={() => targetNode && onPick(targetNode)}
                style={{ cursor: targetNode ? "pointer" : "default" }}>
                <span className="wiki-rel-item__glyph" style={{ color: targetMeta?.color ?? "#666" }}>
                  {targetMeta?.glyph ?? "◇"}
                </span>
                <div className="wiki-rel-item__info">
                  <span className="wiki-rel-item__name">{targetNode?.label ?? targetId}</span>
                  {r.context ? <span className="wiki-rel-item__context">{r.context}</span> : null}
                </div>
                {r.since ? <span className="wiki-rel-item__since">{r.since}</span> : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ── Evidence Trail ────────────────────────────── */

function EvidenceTrail({ evidence }: { evidence: WikiEvidence[] }) {
  if (!evidence?.length) return null;
  return (
    <div className="wiki-evidence">
      <h3 className="wiki-evidence__title">Evidence Trail ({evidence.length})</h3>
      {evidence.map((e, i) => (
        <div key={i} className="wiki-evidence__item">
          <span className="wiki-evidence__date">{e.date}</span>
          <span className="wiki-evidence__source">{e.source}{e.chat ? ` · ${e.chat}` : ""}</span>
          <p className="wiki-evidence__summary">{e.summary}</p>
        </div>
      ))}
    </div>
  );
}

/* ── Context file detail ───────────────────────────── */

function ContextFilePage({
  file,
  loading,
  error,
  onBack,
  onSave,
}: {
  file: WorkspaceFilePreview;
  loading: boolean;
  error?: string;
  onBack: () => void;
  onSave: (content: string) => Promise<string | undefined>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(file.content);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();

  useEffect(() => {
    setDraft(file.content);
    setEditing(false);
    setSaveError(undefined);
  }, [file.name, file.content]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(undefined);
    const err = await onSave(draft);
    setSaving(false);
    if (err) {
      setSaveError(err);
      return;
    }
    setEditing(false);
  };

  return (
    <div className="wiki-library">
      <div className="wiki-entity wiki-entity--context-file">
        <div className="wiki-entity__hero wiki-entity__hero--context">
          <button type="button" className="wiki-entity__back" onClick={onBack}>← Library</button>
          <div className="wiki-entity__hero-bg wiki-entity__hero-bg--context" />
          <div className="wiki-entity__hero-inner">
            <div className="wiki-entity__eyebrow">
              <span>Context</span>
              <span>·</span>
              <span className="wiki-entity__id">{file.name}</span>
            </div>
            <h1>{fileLabel(file.name)}</h1>
            <div className="wiki-entity__meta-row">
              <span className="wiki-entity__pill">{Math.max(1, Math.round(file.size / 1024))} KB</span>
              {file.truncated ? <span className="wiki-entity__pill">Preview truncated</span> : null}
              {!loading && !editing ? (
                <button type="button" className="wiki-btn wiki-btn--secondary" onClick={() => setEditing(true)}>
                  Edit
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {error ? <div className="wiki-entity__error" role="alert">{error}</div> : null}

        <div className="wiki-entity__content wiki-entity__content--context-file">
          <div className="wiki-entity__main">
          {loading ? (
            <div className="wiki-loading"><div className="wiki-loading__shimmer wiki-loading__shimmer--wide" /></div>
          ) : editing ? (
            <>
              <p className="wiki-context-editor__hint">
                Edit markdown directly. Changes are saved to your workspace and used by Papr on future sessions.
              </p>
              {saveError ? <p className="wiki-context-editor__error" role="alert">{saveError}</p> : null}
              <div className="wiki-context-editor__actions">
                <button type="button" className="wiki-btn wiki-btn--primary" onClick={() => { void handleSave(); }} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="wiki-btn wiki-btn--secondary"
                  onClick={() => { setDraft(file.content); setEditing(false); setSaveError(undefined); }}
                  disabled={saving}
                >
                  Cancel
                </button>
              </div>
              <textarea
                className="wiki-context-editor"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                spellCheck={false}
                aria-label={`Edit ${fileLabel(file.name)}`}
              />
            </>
          ) : file.content.trim() ? (
            <div className="wiki-entity__markdown">
              <Markdown>{file.content}</Markdown>
            </div>
          ) : (
            <div className="wiki-empty-state">
              <p>This file is empty.</p>
              <button type="button" className="wiki-btn wiki-btn--primary" onClick={() => setEditing(true)}>
                Add content
              </button>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Home ────────────────────────────────────────── */

function WikiHome({ data, loading, onPick, onSearch, onAdd, onOpenContextFile, contextFiles, onboardingPending }: {
  data: WikiHomeData | null; loading: boolean; onPick: (n: WikiNode) => void;
  onSearch: () => void; onAdd?: () => void; onOpenContextFile: (file: WorkspaceFilePreview) => void;
  contextFiles: WorkspaceFilePreview[];
  onboardingPending: boolean;
}) {
  const featured = data?.featured ?? null;
  const meta = featured ? wikiTypeMeta(featured.type) : null;
  const placeholderFileCount = countPlaceholderContextFiles(contextFiles);
  const identityFile = contextFiles.find((file) => file.name === "IDENTITY.md");
  const showSetupPanel =
    onboardingPending || placeholderFileCount > 0;
  const wikiEmpty = (data?.rails.length ?? 0) === 0 && !featured;

  if (loading && !data) {
    return (<div className="wiki-loading"><div className="wiki-loading__shimmer" /><div className="wiki-loading__shimmer" />
      <div className="wiki-loading__shimmer wiki-loading__shimmer--wide" /></div>);
  }

  if (!data?.configured) {
    return (
      <div className="wiki-library wiki-library--setup-only">
        <MemorySetupPanel variant="sign-in" />
        {data?.error ? <p className="wiki-setup-panel__error">{data.error}</p> : null}
      </div>
    );
  }

  return (
    <div className={`wiki-library${featured && meta ? " wiki-library--has-hero" : ""}`}>
      {featured && meta ? (
        <div className="wiki-hero">
          <div className="wiki-hero__bg"
            style={{ background: `var(--g-${featured.type}, linear-gradient(135deg, ${meta.color}, color-mix(in srgb, ${meta.color} 60%, #111))` }} />
          <div className="wiki-hero__pattern" />
          <div className="wiki-hero__inner">
            <div className="wiki-hero__eyebrow">
              <span className="wiki-hero__pill">Featured</span>
              <span>{meta.label}</span>
            </div>
            <h1>{featured.label}</h1>
            {featured.description ? <p className="wiki-hero__tag">{bodyPreview(featured.description, 200)}</p> : null}
            <div className="wiki-hero__actions">
              <button type="button" className="wiki-btn wiki-btn--primary" onClick={() => onPick(featured)}>Open →</button>
            </div>
          </div>
        </div>
      ) : null}

      {showSetupPanel ? (
        <MemorySetupPanel
          variant="setup"
          onboardingPending={onboardingPending}
          placeholderFileCount={placeholderFileCount}
          onEditIdentity={
            identityFile
              ? () => onOpenContextFile(identityFile)
              : undefined
          }
        />
      ) : null}

      <button type="button" className="wiki-search-float" onClick={onSearch}>
        <span className="wiki-search-float__icon">⌕</span>
        <span>Search entities, memories, relationships…</span>
        <span className="wiki-search-float__kbd">⌘K</span>
      </button>

      {contextFiles.length > 0 ? (
        <section className="wiki-rail wiki-rail--context">
          <div className="wiki-rail__head">
            <h2>Content</h2>
            <span className="wiki-rail__reason">
              {onboardingPending
                ? "Files Papr reads every conversation · Setup in progress"
                : "Markdown context Papr reads each chat · Wiki refreshes overnight"}
              {" · "}
              {contextFiles.length}
            </span>
          </div>
          <div className="wiki-rail__track">
            {contextFiles.map((file) => (
              <ContextFileCard key={file.name} file={file} onOpen={onOpenContextFile} />
            ))}
          </div>
        </section>
      ) : null}

      <button type="button" className="wiki-add-float" onClick={onAdd}>
        <span className="wiki-add-float__icon">+</span>
      </button>

      {wikiEmpty ? (
        showSetupPanel ? null : (
          <MemorySetupPanel variant="wiki-empty" onboardingPending={onboardingPending} />
        )
      ) : data.error ? (
        <div className="wiki-nudge">
          <p>{data.error}</p>
        </div>
      ) : (
        <div className="wiki-rails">{data.rails.map((rail) => (
          <WikiRailSection key={rail.title} rail={rail} onPick={onPick} />
        ))}</div>
      )}

    </div>
  );
}

/* ── Entity Detail Page ────────────────────────────── */


function RelatedMemoriesPanel({ memories }: { memories: WikiRelatedMemory[] }) {
  if (!memories || memories.length === 0) return null;
  return (
    <div className="wiki-entity__related">
      <h3>Related Memories</h3>
      <div className="wiki-related-memories">
        {memories.map((m) => (
          <div key={m.id} className="wiki-related-memory">
            <div className="wiki-related-memory__header">
              <span className="wiki-related-memory__date">{m.createdAt ? new Date(m.createdAt).toLocaleDateString() : ''}</span>
              <span className="wiki-related-memory__category">{m.category || 'memory'}</span>
            </div>
            <p className="wiki-related-memory__content">{m.content}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function WikiEntityPage({ node, rails, relatedMemories, allNodes, loading, error, onBack, onPick }: {
  node: WikiNode | null; rails: WikiRail[]; relatedMemories: WikiRelatedMemory[]; allNodes: WikiNode[];
  loading: boolean; error?: string; onBack: () => void; onPick: (n: WikiNode) => void;
}) {
  const meta = node ? wikiTypeMeta(node.type) : null;

  if (loading && !node) return <div className="wiki-loading"><div className="wiki-loading__shimmer" /></div>;
  if (!node || !meta) {
    return (<div className="wiki-empty-state"><p>{error ?? "Entity not found."}</p>
      <button type="button" className="wiki-btn wiki-btn--secondary" onClick={onBack}>← Back to library</button></div>);
  }

  const relationships = node.relationships ?? [];
  const evidence = node.evidence ?? [];
  const props = node.props ?? {};

  return (
    <div className="wiki-library">
      <div className="wiki-entity">
        {error ? (
          <div className="wiki-entity__error" role="alert">
            {error}
          </div>
        ) : null}
        {/* Hero */}
        <div className="wiki-entity__hero">
          <button type="button" className="wiki-entity__back" onClick={onBack}>← Library</button>
          <div className="wiki-entity__hero-bg"
            style={{ background: `linear-gradient(135deg, ${meta.color}, color-mix(in srgb, ${meta.color} 55%, #111))` }} />
          <div className="wiki-entity__hero-inner">
            <div className="wiki-entity__eyebrow">
              <span>{meta.label}</span><span>·</span>
              <span className="wiki-entity__id">{node.id}</span>
            </div>
            <h1>{node.label}</h1>
            <div className="wiki-entity__meta-row">
              {Object.entries(props).map(([key, value]) => (
                <span key={key} className="wiki-entity__pill">{key}: {String(value)}</span>
              ))}
            </div>
          </div>
        </div>

        {/* Stats bar */}
        <div className="wiki-entity__stats">
          <span>{relationships.length} relationships</span>
          <span>{evidence.length} evidence items</span>
          <span>{node.markdownBody ? "full content" : "no content"}</span>
        </div>

        {/* Content */}
        <div className="wiki-entity__content">
          <div className="wiki-entity__main">
            {node.markdownBody ? (
              <div className="wiki-entity__markdown">
                <Markdown>{String(node.markdownBody)}</Markdown>
              </div>
            ) : node.description ? (
              <div className="wiki-entity__overview"><p>{node.description}</p></div>
            ) : null}
          </div>

          {/* Sidebar */}
          <div className="wiki-entity__sidebar">
            <RelationshipsPanel relationships={relationships} onPick={onPick} allNodes={allNodes} />
            <EvidenceTrail evidence={evidence} />
          </div>
        </div>

        {/* Connected entity rails — cards above memories */}
        {rails.length > 0 ? (
          <div className="wiki-entity__connected">
            <h3>Connected Entities</h3>
            <p className="wiki-entity__connected-count">
              {rails.reduce((s, r) => s + r.items.length, 0)} entities across {rails.length} {rails.length === 1 ? "group" : "groups"}
              {rails.some((r) => r.reason?.includes("knowledge graph")) ? " · from knowledge graph + entity files" : ""}
            </p>
            <div className="wiki-entity__connected-grid">
              {rails.map((rail) => <WikiRailSection key={rail.title} rail={rail} onPick={onPick} />)}
            </div>
          </div>
        ) : loading ? (
          <div className="wiki-entity__connected">
            <h3>Connected Entities</h3>
            <div className="wiki-loading__shimmer" style={{ height: 80 }} />
          </div>
        ) : null}

        {/* Related Memories */}
        <RelatedMemoriesPanel memories={relatedMemories} />
      </div>
    </div>
  );
}

/* ── Shell ────────────────────────────────────────── */

export function WikiLibrary({ refreshToken = 0, paletteOpen: paletteOpenProp, onPaletteOpenChange, onFocusChange }: WikiLibraryProps) {
  const [home, setHome] = useState<WikiHomeData | null>(null);
  const [homeLoading, setHomeLoading] = useState(true);
  const [focus, setFocus] = useState<WikiNode | null>(null);
  const [contextFocus, setContextFocus] = useState<WorkspaceFilePreview | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | undefined>();
  const [entityRails, setEntityRails] = useState<WikiRail[]>([]);
  const [entityRelatedMemories, setEntityRelatedMemories] = useState<WikiRelatedMemory[]>([]);
  const [entityLoading, setEntityLoading] = useState(false);
  const [entityError, setEntityError] = useState<string | undefined>();
  const [paletteOpenLocal, setPaletteOpenLocal] = useState(false);
  const paletteOpen = paletteOpenProp ?? paletteOpenLocal;
  const setPaletteOpen = onPaletteOpenChange ?? setPaletteOpenLocal;
  const [createOpen, setCreateOpen] = useState(false);
  const [contextFiles, setContextFiles] = useState<WorkspaceFilePreview[]>([]);
  const [onboardingPending, setOnboardingPending] = useState(false);
  const existingTypes = home?.rails?.map((r) => r.title.toLowerCase().replace(/\s+/g, "_")) ?? [];
  const allNodes = useMemo(() => {
    const merged = collectWikiNodes(home);
    const seen = new Set(merged.map((n) => `${n.type}:${n.id}`));
    const push = (node: WikiNode) => {
      const key = `${node.type}:${node.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(normalizeWikiNode(node));
    };
    if (focus) push(focus);
    for (const rail of entityRails) {
      for (const item of rail.items ?? []) {
        push(item);
      }
    }
    return merged;
  }, [home, focus, entityRails]);

  const loadHome = useCallback(async () => {
    setHomeLoading(true);
    try {
      const response = await gateway.send("memory:wiki-home", {}, { timeoutMs: 30_000 });
      if (response.success && response.data) setHome(response.data as WikiHomeData);
    } catch {
      setHome({ featured: null, rails: [], typeCounts: {}, configured: false, error: "Could not load your knowledge graph." });
    } finally { setHomeLoading(false); }
  }, []);

  /** Load context files for inline display */
  const loadContext = useCallback(async () => {
    try {
      const response = await gateway.send("memory:get-context-preview", { forceRefresh: false }, { timeoutMs: 15_000 });
      if (response.success && response.data) {
        const data = response.data as {
          workspaceFiles?: WorkspaceFilePreview[];
          onboardingPending?: boolean;
        };
        setContextFiles(data.workspaceFiles ?? []);
        setOnboardingPending(data.onboardingPending === true);
      }
    } catch { /* silent */ }
  }, []);

  const clearContextFocus = useCallback(() => {
    setContextFocus(null);
    setContextError(undefined);
    setContextLoading(false);
    onFocusChange?.(null, null);
  }, [onFocusChange]);

  const clearFocus = useCallback(() => {
    setFocus(null);
    try { sessionStorage.removeItem(FOCUS_CACHE_KEY); } catch { /* noop */ }
    onFocusChange?.(null, null);
  }, [onFocusChange]);

  const openContextFile = useCallback(async (file: WorkspaceFilePreview) => {
    setFocus(null);
    setContextFocus({ ...file });
    setContextLoading(true);
    setContextError(undefined);
    onFocusChange?.(fileLabel(file.name), clearContextFocus);
    window.scrollTo?.(0, 0);

    try {
      const response = await gateway.send(
        "memory:read-context-file",
        { fileName: file.name },
        { timeoutMs: 15_000 },
      );
      if (!response.success) {
        setContextError(response.error ?? "Failed to load file");
        return;
      }
      const data = response.data as WorkspaceFilePreview | undefined;
      if (data?.content != null) {
        setContextFocus({
          name: file.name,
          content: data.content,
          size: data.size ?? data.content.length,
          truncated: data.truncated ?? false,
          rawLength: data.rawLength ?? data.content.length,
        });
      }
    } catch (err) {
      setContextError(err instanceof Error ? err.message : "Failed to load file");
    } finally {
      setContextLoading(false);
    }
  }, [onFocusChange, clearContextFocus]);

  const saveContextFile = useCallback(async (content: string): Promise<string | undefined> => {
    if (!contextFocus) return "No file selected";
    try {
      const response = await gateway.send(
        "memory:write-context-file",
        { fileName: contextFocus.name, content },
        { timeoutMs: 15_000 },
      );
      if (!response.success) {
        return response.error ?? "Failed to save file";
      }
      const data = response.data as WorkspaceFilePreview | undefined;
      setContextFocus({
        name: contextFocus.name,
        content: data?.content ?? content,
        size: data?.size ?? content.length,
        truncated: false,
        rawLength: data?.rawLength ?? content.length,
      });
      void loadContext();
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : "Failed to save file";
    }
  }, [contextFocus, loadContext]);

  const loadEntity = useCallback(async (nodeInput: WikiNode) => {
    const node = normalizeWikiNode(nodeInput);
    setContextFocus(null);
    setContextError(undefined);
    // Optimistic: show entity page immediately with what we already have
    setFocus(node);
    setEntityRails([]);
    setEntityRelatedMemories([]);
    setEntityLoading(true);
    setEntityError(undefined);
    // Cache to sessionStorage
    try { sessionStorage.setItem(FOCUS_CACHE_KEY, JSON.stringify({ type: node.type, id: node.id, label: node.label })); } catch { /* noop */ }
    // Report to parent for breadcrumbs
    onFocusChange?.(node.label, clearFocus);
    try {
      const response = await gateway.send("memory:wiki-entity",
        { type: node.type, id: node.id, label: node.label }, { timeoutMs: 30_000 });
      if (!response.success) {
        setEntityError(response.error ?? "Failed to load entity");
        return;
      }
      const data = response.data as WikiEntityData | undefined;
      if (data?.node) {
        const enriched = normalizeWikiNode(data.node);
        setFocus(enriched);
        setEntityRails(data.rails ?? []);
        setEntityRelatedMemories(data.relatedMemories ?? []);
        // Update cache with enriched node
        try { sessionStorage.setItem(FOCUS_CACHE_KEY, JSON.stringify({ type: enriched.type, id: enriched.id, label: enriched.label })); } catch { /* noop */ }
        onFocusChange?.(enriched.label, clearFocus);
      } else {
        setEntityError(data?.error ?? "Entity not found");
      }
    } catch (err) {
      setEntityError(err instanceof Error ? err.message : "Failed to load entity");
    } finally { setEntityLoading(false); }
  }, [onFocusChange, clearFocus]);

  // Initial load + restore cached focus
  useEffect(() => {
    void loadHome();
    void loadContext();
    // Restore cached entity focus
    try {
      const cached = sessionStorage.getItem(FOCUS_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as Partial<WikiNode>;
        if (parsed?.id && parsed?.type && parsed?.label) {
          void loadEntity(normalizeWikiNode(parsed as WikiNode));
        }
      }
    } catch { /* noop */ }
  }, []);

  useEffect(() => { if (refreshToken > 0 && focus) void loadEntity(focus); }, [refreshToken]);
  useEffect(() => { if (refreshToken > 0 && !focus) { void loadHome(); void loadContext(); } }, [refreshToken]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (focus) clearFocus();
      else if (contextFocus) clearContextFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, contextFocus, clearFocus, clearContextFocus]);

  const handlePick = useCallback((node: WikiNode) => {
    void loadEntity(node);
    window.scrollTo?.(0, 0);
  }, [loadEntity]);

  return (
    <div className="wiki-shell">
      <div className="wiki-shell__content">
        {focus ? (
          <WikiEntityPage node={focus} rails={entityRails} relatedMemories={entityRelatedMemories} allNodes={allNodes}
            loading={entityLoading} error={entityError} onBack={clearFocus} onPick={handlePick} />
        ) : contextFocus ? (
          <ContextFilePage
            file={contextFocus}
            loading={contextLoading}
            error={contextError}
            onBack={clearContextFocus}
            onSave={saveContextFile}
          />
        ) : (
          <WikiHome data={home} loading={homeLoading} onPick={handlePick}
            onSearch={() => setPaletteOpen(true)} onAdd={() => setCreateOpen(true)}
            onOpenContextFile={(file) => { void openContextFile(file); }}
            contextFiles={contextFiles}
            onboardingPending={onboardingPending} />
        )}
      </div>
      <SearchPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onPick={handlePick} />
      <CreateDialog open={createOpen} onClose={() => setCreateOpen(false)}
        onCreated={() => loadHome()} existingTypes={existingTypes} />
    </div>
  );
}

/**
 * CommunityAppsView - Browse and import app bundles from the community repo
 */

import React, { useState, useEffect, useCallback } from "react";
import { gateway } from "../../src/lib/gateway";
import { useArtifacts } from "../../hooks/useArtifacts";
import "./CommunityAppsView.css";

/**
 * Registry entries are Zod-validated server-side (parseValidRegistryEntries).
 * Only entries with correct schema reach the UI. Fields like `requirements`
 * are guaranteed to be string[] — objects or other shapes are rejected.
 */
interface CommunityRegistryEntry {
  bundleId: string;
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  minPaprworkVersion: string;
  path: string;
  icon?: string;
  requirements?: string[];
  platform?: string[];
}

/** Sanitize an icon string — strip scripts and event handlers from untrusted HTML */
function sanitizeIcon(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/on\w+\s*=/gi, "data-blocked=");
}

interface CommunityRegistry {
  schemaVersion: string;
  bundles: CommunityRegistryEntry[];
}

type ImportStatus = "idle" | "importing" | "imported" | "error";

function detectUserPlatform(): "macos" | "windows" | "linux" {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  return "linux";
}

export function CommunityAppsView() {
  const [registry, setRegistry] = useState<CommunityRegistry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [importStatus, setImportStatus] = useState<
    Record<string, ImportStatus>
  >({});
  const [showAllPlatforms, setShowAllPlatforms] = useState(false);
  const { filteredArtifacts, loadArtifacts } = useArtifacts();
  const userPlatform = detectUserPlatform();

  const installedAppIds = new Set(
    filteredArtifacts.filter((a) => a.type === "app").map((a) => a.id),
  );

  const fetchRegistry = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await gateway.send("bundle:fetch-registry");
      setRegistry(response.data as CommunityRegistry);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load community apps",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRegistry();
  }, [fetchRegistry]);

  const handleImport = async (entry: CommunityRegistryEntry) => {
    setImportStatus((prev) => ({ ...prev, [entry.bundleId]: "importing" }));
    try {
      await gateway.send("bundle:import-community", {
        bundleId: entry.bundleId,
        repoPath: entry.path,
      });
      setImportStatus((prev) => ({ ...prev, [entry.bundleId]: "imported" }));
      loadArtifacts();
    } catch {
      setImportStatus((prev) => ({ ...prev, [entry.bundleId]: "error" }));
    }
  };

  const filteredBundles =
    registry?.bundles.filter((b) => {
      if (!showAllPlatforms) {
        const platforms = b.platform ?? ["macos", "windows", "linux"];
        if (!platforms.includes(userPlatform)) return false;
      }
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        b.name.toLowerCase().includes(q) ||
        b.description.toLowerCase().includes(q) ||
        b.tags.some((t) => t.toLowerCase().includes(q))
      );
    }) ?? [];

  const hiddenByPlatform = showAllPlatforms
    ? 0
    : (registry?.bundles.filter((b) => {
        const platforms = b.platform ?? ["macos", "windows", "linux"];
        return !platforms.includes(userPlatform);
      }).length ?? 0);

  if (loading) {
    return (
      <div className="community-apps__status">
        <div className="community-apps__spinner" />
        <p>Loading community apps...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="community-apps__status">
        <p className="community-apps__error">{error}</p>
        <button className="community-apps__retry-btn" onClick={fetchRegistry}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="community-apps">
      <div className="community-apps__toolbar">
        <input
          type="text"
          className="community-apps__search"
          placeholder="Search community apps..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button className="community-apps__refresh-btn" onClick={fetchRegistry}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M1 4v6h6M23 20v-6h-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {hiddenByPlatform > 0 && (
        <button
          className="community-apps__platform-toggle"
          onClick={() => setShowAllPlatforms(!showAllPlatforms)}
        >
          {showAllPlatforms
            ? "Show compatible only"
            : `Show all platforms (+${hiddenByPlatform} hidden)`}
        </button>
      )}

      {filteredBundles.length === 0 && (
        <div className="community-apps__status">
          <p className="community-apps__empty-text">
            {searchQuery
              ? "No apps match your search."
              : "No community apps available yet."}
          </p>
        </div>
      )}

      <div className="community-apps__grid">
        {filteredBundles.map((entry) => {
          const status = importStatus[entry.bundleId] ?? "idle";
          const isInstalled = installedAppIds.has(entry.bundleId);

          return (
            <CommunityAppCard
              key={entry.bundleId}
              entry={entry}
              status={status}
              isInstalled={isInstalled}
              onImport={() => void handleImport(entry)}
            />
          );
        })}
      </div>
    </div>
  );
}

interface CommunityAppCardProps {
  entry: CommunityRegistryEntry;
  status: ImportStatus;
  isInstalled: boolean;
  onImport: () => void;
}

function CommunityAppCard({
  entry,
  status,
  isInstalled,
  onImport,
}: CommunityAppCardProps) {
  const [showDetails, setShowDetails] = useState(false);

  const buttonLabel = isInstalled
    ? "Installed"
    : status === "importing"
      ? "Importing..."
      : status === "imported"
        ? "Imported"
        : status === "error"
          ? "Retry"
          : "Import";

  const isDisabled =
    isInstalled || status === "importing" || status === "imported";

  const requirements = entry.requirements ?? [];
  const hasNoRequirements = requirements.length === 0;

  const allPlatforms = ["macos", "windows", "linux"];
  const platforms = entry.platform ?? allPlatforms;
  const isCrossPlatform =
    platforms.length === allPlatforms.length &&
    allPlatforms.every((p) => platforms.includes(p));

  const platformLabel = isCrossPlatform
    ? "All Platforms"
    : platforms
        .map((p) =>
          p === "macos" ? "macOS" : p === "windows" ? "Windows" : "Linux",
        )
        .join(", ");

  const renderIcon = () => {
    if (entry.icon) {
      return (
        <span
          className="community-card__orb-icon"
          dangerouslySetInnerHTML={{ __html: sanitizeIcon(entry.icon) }}
        />
      );
    }
    return (
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="3" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    );
  };

  return (
    <div className="community-card">
      <div className="community-card__orb">
        <div className="community-card__orb-inner">
          {renderIcon()}
        </div>
        <div className="community-card__orb-highlight" />
      </div>

      <div className="community-card__content">
        <h3 className="community-card__title">{entry.name}</h3>
        <p className="community-card__description">{entry.description}</p>
        <div className="community-card__meta">
          <span className="community-card__version">v{entry.version}</span>
          <span className="community-card__author">by {entry.author}</span>
          <button
            className="community-card__details-toggle"
            onClick={(e) => {
              e.stopPropagation();
              setShowDetails(!showDetails);
            }}
          >
            {showDetails ? "Less" : "Details"}
          </button>
        </div>
        <div className="community-card__tags">
          {entry.tags.map((tag) => (
            <span key={tag} className="community-card__tag">
              {tag}
            </span>
          ))}
          {!isCrossPlatform && (
            <span className="community-card__platform-badge">
              {platformLabel}
            </span>
          )}
        </div>

        {showDetails && (
          <div className="community-card__details">
            <div className="community-card__detail-row">
              <span className="community-card__detail-label">Requirements</span>
              <span
                className={`community-card__detail-value ${hasNoRequirements ? "community-card__detail-value--good" : "community-card__detail-value--warn"}`}
              >
                {requirements.length > 0 ? requirements.join(", ") : "No API keys needed"}
              </span>
            </div>
            <div className="community-card__detail-row">
              <span className="community-card__detail-label">Platform</span>
              <span
                className={`community-card__detail-value ${isCrossPlatform ? "community-card__detail-value--good" : ""}`}
              >
                {platformLabel}
              </span>
            </div>
            <div className="community-card__detail-row">
              <span className="community-card__detail-label">Min Version</span>
              <span className="community-card__detail-value">
                Paprwork {entry.minPaprworkVersion}+
              </span>
            </div>
          </div>
        )}
      </div>

      <button
        className={`community-card__import-btn ${isDisabled ? "community-card__import-btn--disabled" : ""} ${status === "imported" || isInstalled ? "community-card__import-btn--success" : ""} ${status === "error" ? "community-card__import-btn--error" : ""}`}
        onClick={onImport}
        disabled={isDisabled}
      >
        {status === "importing" && (
          <span className="community-card__import-spinner" />
        )}
        {buttonLabel}
      </button>
    </div>
  );
}

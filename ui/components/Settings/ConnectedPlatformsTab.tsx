/**
 * ConnectedPlatformsTab - Social Login for job automation
 *
 * Allows users to connect social platforms (LinkedIn, Instagram, Reddit, etc.)
 * with one click. Sessions are automatically refreshed in the background.
 */

import React, { useState, useEffect, useCallback } from "react";
import { gateway } from "../../src/lib/gateway";
import "./ConnectedPlatformsTab.css";

type PlatformStatus =
  | "connected"
  | "disconnected"
  | "expired"
  | "needs_reauth"
  | "connecting";

interface PlatformSessionState {
  platformId: string;
  status: PlatformStatus;
  connectedAt?: string;
  lastRefreshedAt?: string;
  expiresAt?: string;
  error?: string;
}

interface PlatformInfo {
  id: string;
  name: string;
  notes?: string;
  status: PlatformSessionState;
}

function formatRelativeTime(dateStr: string | undefined): string {
  if (!dateStr) return "never";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins} min ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
}

function formatExpirationDate(dateStr: string | undefined): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function getStatusColor(status: PlatformStatus): string {
  switch (status) {
    case "connected":
      return "var(--color-success, #10b981)";
    case "expired":
    case "needs_reauth":
      return "var(--color-warning, #f59e0b)";
    case "connecting":
      return "var(--color-info, #3b82f6)";
    default:
      return "var(--color-text-tertiary, #6b7280)";
  }
}

function getStatusLabel(status: PlatformStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "expired":
      return "Expired";
    case "needs_reauth":
      return "Needs login";
    case "connecting":
      return "Connecting...";
    default:
      return "Not connected";
  }
}

export function ConnectedPlatformsTab() {
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPlatforms = useCallback(async () => {
    try {
      const response = await gateway.send("platform:get-all", {});
      // gateway.send returns { id, success, data, error } - extract the data array
      const platforms = response.data as PlatformInfo[];
      setPlatforms(platforms || []);
      setError(null);
    } catch (err) {
      console.error("[ConnectedPlatformsTab] Failed to load platforms:", err);
      setError(err instanceof Error ? err.message : "Failed to load platforms");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPlatforms();

    // Listen for status changes (broadcast from Gateway via custom event)
    const handleStatusChange = (event: CustomEvent<{ type: string; data?: unknown }>) => {
      const detail = event.detail;
      if (detail.type === "platform:status-changed" && detail.data) {
        const statusData = detail.data as PlatformSessionState;
        setPlatforms((prev) =>
          prev.map((p) =>
            p.id === statusData.platformId
              ? { ...p, status: statusData }
              : p
          )
        );
        setActionLoading(null);
        
        // Also reload to get fresh data
        setTimeout(() => loadPlatforms(), 500);
      }
    };

    // Gateway broadcasts are dispatched as "gateway-broadcast" custom events
    window.addEventListener("gateway-broadcast", handleStatusChange as EventListener);
    
    return () => {
      window.removeEventListener("gateway-broadcast", handleStatusChange as EventListener);
    };
  }, [loadPlatforms]);

  const handleConnect = async (platformId: string) => {
    setActionLoading(platformId);
    setError(null);

    try {
      await gateway.send("platform:connect", { platformId });
      // Result will come via broadcast, but reload to be safe
      setTimeout(() => loadPlatforms(), 1000);
    } catch (err) {
      console.error(`[ConnectedPlatformsTab] Failed to connect ${platformId}:`, err);
      setError(err instanceof Error ? err.message : "Failed to connect");
      setActionLoading(null);
    }
  };

  const handleDisconnect = async (platformId: string) => {
    setActionLoading(platformId);
    setError(null);

    try {
      await gateway.send("platform:disconnect", { platformId });
      await loadPlatforms();
    } catch (err) {
      console.error(`[ConnectedPlatformsTab] Failed to disconnect ${platformId}:`, err);
      setError(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setActionLoading(null);
    }
  };

  const handleRefresh = async (platformId: string) => {
    setActionLoading(platformId);
    setError(null);

    try {
      await gateway.send("platform:refresh", { platformId });
      await loadPlatforms();
    } catch (err) {
      console.error(`[ConnectedPlatformsTab] Failed to refresh ${platformId}:`, err);
      setError(err instanceof Error ? err.message : "Failed to refresh");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="connected-platforms-tab">
        <div className="connected-platforms-loading">Loading platforms...</div>
      </div>
    );
  }

  return (
    <div className="connected-platforms-tab">
      <div className="connected-platforms-header">
        <h2>Social Login</h2>
        <p className="connected-platforms-description">
          Connect your social accounts for automated posting, messaging, and data collection.
          Sessions are automatically refreshed in the background.
        </p>
      </div>

      {error && (
        <div className="connected-platforms-error">
          {error}
        </div>
      )}

      <div className="connected-platforms-list">
        {platforms.map((platform) => {
          const status = platform.status;
          const isLoading = actionLoading === platform.id;
          const isConnected = status.status === "connected";
          const needsReauth =
            status.status === "expired" || status.status === "needs_reauth";

          return (
            <div key={platform.id} className="connected-platform-card">
              <div className="connected-platform-info">
                <div className="connected-platform-header">
                  <span className="connected-platform-name">{platform.name}</span>
                  <span
                    className="connected-platform-status"
                    style={{ color: getStatusColor(status.status) }}
                  >
                    <span
                      className="connected-platform-status-dot"
                      style={{ backgroundColor: getStatusColor(status.status) }}
                    />
                    {getStatusLabel(status.status)}
                  </span>
                </div>

                {isConnected && (
                  <div className="connected-platform-details">
                    <span className="connected-platform-detail">
                      Expires ~{formatExpirationDate(status.expiresAt)}
                    </span>
                    <span className="connected-platform-detail-separator">•</span>
                    <span className="connected-platform-detail">
                      Last refreshed: {formatRelativeTime(status.lastRefreshedAt)}
                    </span>
                  </div>
                )}

                {status.error && (
                  <div className="connected-platform-error-text">
                    {status.error}
                  </div>
                )}

                {platform.notes && !isConnected && (
                  <div className="connected-platform-notes">
                    {platform.notes}
                  </div>
                )}
              </div>

              <div className="connected-platform-actions">
                {isConnected && (
                  <>
                    <button
                      className="connected-platform-btn connected-platform-btn-secondary"
                      onClick={() => handleRefresh(platform.id)}
                      disabled={isLoading}
                    >
                      {isLoading ? "..." : "Refresh"}
                    </button>
                    <button
                      className="connected-platform-btn connected-platform-btn-danger"
                      onClick={() => handleDisconnect(platform.id)}
                      disabled={isLoading}
                    >
                      {isLoading ? "..." : "Disconnect"}
                    </button>
                  </>
                )}

                {needsReauth && (
                  <button
                    className="connected-platform-btn connected-platform-btn-primary"
                    onClick={() => handleConnect(platform.id)}
                    disabled={isLoading}
                  >
                    {isLoading ? "Connecting..." : "Reconnect"}
                  </button>
                )}

                {status.status === "disconnected" && (
                  <button
                    className="connected-platform-btn connected-platform-btn-primary"
                    onClick={() => handleConnect(platform.id)}
                    disabled={isLoading}
                  >
                    {isLoading ? "Connecting..." : "Connect"}
                  </button>
                )}

                {status.status === "connecting" && (
                  <button
                    className="connected-platform-btn connected-platform-btn-secondary"
                    disabled
                  >
                    Waiting for login...
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="connected-platforms-footer">
        <h3>How it works</h3>
        <ol className="connected-platforms-steps">
          <li>Click <strong>Connect</strong> to open a login window</li>
          <li>Log in to your account (2FA supported)</li>
          <li>Session cookies are securely stored in your keychain</li>
          <li>Sessions refresh automatically in the background</li>
          <li>Use in jobs with <code>{"${PLATFORM_COOKIE_NAME}"}</code> substitution</li>
        </ol>
      </div>
    </div>
  );
}

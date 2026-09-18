/**
 * ConnectedPlatformsTab - Platform Connections for authenticated automation
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { gateway } from "../../src/lib/gateway";
import { openPlatformBrowserTab } from "../../lib/openPlatformBrowserTab";
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
  isCustom?: boolean;
  homeUrl?: string;
  registeredBy?: "user" | "agent";
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

/** Matches gateway `allowsPersonalChromeCookieImport` — LinkedIn must use Papr Chrome only. */
function allowsImportFromPersonalChrome(platformId: string): boolean {
  return platformId !== "linkedin";
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
  const [waitingForLogin, setWaitingForLogin] = useState<Set<string>>(new Set());
  const [externalChromeLogin, setExternalChromeLogin] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [connectNotice, setConnectNotice] = useState<string | null>(null);
  const [showAddSite, setShowAddSite] = useState(false);
  const [newSiteUrl, setNewSiteUrl] = useState("");
  const [newSiteName, setNewSiteName] = useState("");
  const [registerLoading, setRegisterLoading] = useState(false);
  const [showChromeImport, setShowChromeImport] = useState(false);
  const [chromeImportSelected, setChromeImportSelected] = useState<Set<string>>(
    () => new Set(),
  );
  const [chromeImportLoading, setChromeImportLoading] = useState(false);
  const [chromeImportResults, setChromeImportResults] = useState<
    PlatformSessionState[] | null
  >(null);
  const addSiteUrlRef = useRef<HTMLInputElement>(null);

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
        
        // Remove from waiting list if connected
        if (statusData.status === "connected" || statusData.status === "disconnected") {
          setWaitingForLogin((prev) => {
            const next = new Set(prev);
            next.delete(statusData.platformId);
            return next;
          });
          setExternalChromeLogin((prev) => {
            const next = new Set(prev);
            next.delete(statusData.platformId);
            return next;
          });
        }
        
        // Also reload to get fresh data (skip immediate re-validation right after connect)
        if (statusData.status !== "connected") {
          setTimeout(() => loadPlatforms(), 500);
        }
      }
    };

    // Gateway broadcasts are dispatched as "gateway-broadcast" custom events
    window.addEventListener("gateway-broadcast", handleStatusChange as EventListener);
    
    return () => {
      window.removeEventListener("gateway-broadcast", handleStatusChange as EventListener);
    };
  }, [loadPlatforms]);

  const handleRegisterSite = useCallback(async () => {
    const url = newSiteUrl.trim();
    if (!url) return;

    setRegisterLoading(true);
    setError(null);
    try {
      const response = await gateway.send("platform:register", {
        url,
        name: newSiteName.trim() || undefined,
      });
      if (!response.success) {
        throw new Error(response.error || "Failed to register site");
      }
      setNewSiteUrl("");
      setNewSiteName("");
      setShowAddSite(false);
      await loadPlatforms();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to register site");
    } finally {
      setRegisterLoading(false);
    }
  }, [loadPlatforms, newSiteName, newSiteUrl]);

  const handleOpenAddSite = useCallback(() => {
    setShowAddSite(true);
    setError(null);
    requestAnimationFrame(() => addSiteUrlRef.current?.focus());
  }, []);

  const handleCloseAddSite = useCallback(() => {
    setShowAddSite(false);
    setNewSiteUrl("");
    setNewSiteName("");
  }, []);

  const handleRemoveSite = useCallback(
    async (platformId: string) => {
      setActionLoading(platformId);
      setError(null);
      try {
        const response = await gateway.send("platform:unregister", { platformId });
        if (!response.success) {
          throw new Error(response.error || "Failed to remove site");
        }
        await loadPlatforms();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove site");
      } finally {
        setActionLoading(null);
      }
    },
    [loadPlatforms],
  );

  const handleConnect = async (platformId: string) => {
    setActionLoading(platformId);
    setError(null);
    setConnectNotice(null);

    try {
      const response = await gateway.send("platform:connect", { platformId });
      if (!response.success) {
        throw new Error(response.error || "Failed to connect");
      }

      const data = response.data as {
        waitingForConfirmation?: boolean;
        status?: string;
        externalChrome?: boolean;
        chromeWindowOpened?: boolean;
        message?: string;
        error?: string;
      };

      if (data?.error && data.status === "disconnected") {
        setError(data.error);
        setActionLoading(null);
        return;
      }

      if (data?.message) {
        setConnectNotice(data.message);
      }

      if (data?.status === "connected") {
        if (data.chromeWindowOpened) {
          setExternalChromeLogin((prev) => new Set(prev).add(platformId));
        }
        await loadPlatforms();
        setActionLoading(null);
        return;
      }

      // If waiting for Chrome login, show check-now UI while background polling runs
      if (data?.waitingForConfirmation) {
        setWaitingForLogin((prev) => new Set(prev).add(platformId));
        if (data.externalChrome) {
          setExternalChromeLogin((prev) => new Set(prev).add(platformId));
        } else {
          openPlatformBrowserTab(platformId);
        }
        // Update local state to show connecting
        setPlatforms((prev) =>
          prev.map((p) =>
            p.id === platformId
              ? { ...p, status: { ...p.status, status: "connecting" as PlatformStatus } }
              : p
          )
        );
      }
      setActionLoading(null);
    } catch (err) {
      console.error(`[ConnectedPlatformsTab] Failed to connect ${platformId}:`, err);
      setError(err instanceof Error ? err.message : "Failed to connect");
      setActionLoading(null);
    }
  };

  const handleConfirmLogin = async (platformId: string) => {
    setActionLoading(platformId);
    setError(null);
    setConnectNotice(null);

    try {
      const response = await gateway.send("platform:confirm-login", { platformId });
      const data = response.data as PlatformSessionState;
      
      if (data?.status === "connected") {
        // Success! Remove from waiting list
        setWaitingForLogin((prev) => {
          const next = new Set(prev);
          next.delete(platformId);
          return next;
        });
        setExternalChromeLogin((prev) => {
          const next = new Set(prev);
          next.delete(platformId);
          return next;
        });
      } else if (data?.error) {
        setError(data.error);
      }
      
      await loadPlatforms();
    } catch (err) {
      console.error(`[ConnectedPlatformsTab] Failed to confirm login ${platformId}:`, err);
      setError(err instanceof Error ? err.message : "Failed to confirm login");
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancelLogin = (platformId: string) => {
    setWaitingForLogin((prev) => {
      const next = new Set(prev);
      next.delete(platformId);
      return next;
    });
    setExternalChromeLogin((prev) => {
      const next = new Set(prev);
      next.delete(platformId);
      return next;
    });
    // Reset status to disconnected
    setPlatforms((prev) =>
      prev.map((p) =>
        p.id === platformId
          ? { ...p, status: { ...p.status, status: "disconnected" as PlatformStatus } }
          : p
      )
    );
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

  const importablePlatforms = platforms.filter((p) =>
    allowsImportFromPersonalChrome(p.id),
  );

  const toggleChromeImportPlatform = (platformId: string) => {
    setChromeImportSelected((prev) => {
      const next = new Set(prev);
      if (next.has(platformId)) {
        next.delete(platformId);
      } else {
        next.add(platformId);
      }
      return next;
    });
    setChromeImportResults(null);
  };

  const handleImportFromChrome = async () => {
    const platformIds = Array.from(chromeImportSelected);
    if (platformIds.length === 0) {
      return;
    }

    setChromeImportLoading(true);
    setError(null);
    setChromeImportResults(null);

    try {
      const response = await gateway.send("platform:import-from-chrome", {
        platformIds,
      });
      if (!response.success) {
        throw new Error(response.error || "Import failed");
      }
      const data = response.data as { results?: PlatformSessionState[] };
      const results = data.results ?? [];
      setChromeImportResults(results);
      await loadPlatforms();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import from Chrome failed");
    } finally {
      setChromeImportLoading(false);
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
      <div className="settings-section__header connected-platforms-header">
        <div>
          <h2 className="settings-section__title">Platform Connections</h2>
          <p className="settings-section__description">
            Connect sites that need login — social platforms and any custom web app.
            Sessions stay in an in-app tab; the agent reuses them for automation.
          </p>
        </div>
        <button
          type="button"
          className="settings-btn settings-btn--primary"
          onClick={handleOpenAddSite}
        >
          + Add Site
        </button>
      </div>

      {showAddSite && (
        <div className="key-add-form connected-platforms-add-form-panel">
          <div className="form-group">
            <label className="form-label" htmlFor="platform-add-site-url">
              Site URL
            </label>
            <input
              ref={addSiteUrlRef}
              id="platform-add-site-url"
              type="url"
              className="form-input"
              placeholder="https://app.example.com"
              value={newSiteUrl}
              onChange={(event) => setNewSiteUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && newSiteUrl.trim() && !registerLoading) {
                  void handleRegisterSite();
                }
              }}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="platform-add-site-name">
              Display name <span className="form-label__optional">(optional)</span>
            </label>
            <input
              id="platform-add-site-name"
              type="text"
              className="form-input"
              placeholder="e.g., My Dashboard"
              value={newSiteName}
              onChange={(event) => setNewSiteName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && newSiteUrl.trim() && !registerLoading) {
                  void handleRegisterSite();
                }
              }}
            />
          </div>
          <p className="connected-platforms-add-hint">
            Papr opens Google Chrome outside the app for login and automation. Requires Google
            Chrome on desktop — without it, an in-app browser is used as fallback.
          </p>
          <div className="key-add-form__actions">
            <button
              type="button"
              className="settings-btn settings-btn--secondary"
              onClick={handleCloseAddSite}
              disabled={registerLoading}
            >
              Cancel
            </button>
            <button
              type="button"
              className="settings-btn settings-btn--primary"
              onClick={() => void handleRegisterSite()}
              disabled={registerLoading || !newSiteUrl.trim()}
            >
              {registerLoading ? "Adding..." : "Add Site"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="connected-platforms-error">
          {error}
        </div>
      )}

      {connectNotice && (
        <div className="connected-platforms-note connected-platforms-connect-notice">
          {connectNotice}
        </div>
      )}

      {importablePlatforms.length > 0 && (
        <div className="connected-platforms-chrome-import">
          <div className="connected-platforms-chrome-import-header">
            <div>
              <h3 className="connected-platforms-chrome-import-title">
                Import from Google Chrome
              </h3>
              <p className="connected-platforms-chrome-import-desc">
                Optional — copy session cookies from your personal Chrome into Papr.
                Choose which platforms to import (one Keychain prompt per platform on
                macOS). Connect still uses Papr&apos;s browser when import is not used.
              </p>
            </div>
            <button
              type="button"
              className="settings-btn settings-btn--secondary"
              onClick={() => {
                setShowChromeImport((open) => !open);
                setChromeImportResults(null);
              }}
            >
              {showChromeImport ? "Hide" : "Import…"}
            </button>
          </div>

          {showChromeImport && (
            <div className="connected-platforms-chrome-import-panel">
              <div className="connected-platforms-chrome-import-checkboxes">
                {importablePlatforms.map((platform) => (
                  <label
                    key={platform.id}
                    className="connected-platforms-chrome-import-row"
                  >
                    <input
                      type="checkbox"
                      checked={chromeImportSelected.has(platform.id)}
                      onChange={() => toggleChromeImportPlatform(platform.id)}
                      disabled={chromeImportLoading}
                    />
                    <span>{platform.name}</span>
                  </label>
                ))}
              </div>
              <p className="connected-platforms-chrome-import-hint">
                LinkedIn is not listed — sign in through Papr&apos;s Chrome window only.
                You must already be logged in to each site in Google Chrome.
              </p>
              <div className="connected-platforms-chrome-import-actions">
                <button
                  type="button"
                  className="settings-btn settings-btn--primary"
                  onClick={() => void handleImportFromChrome()}
                  disabled={
                    chromeImportLoading || chromeImportSelected.size === 0
                  }
                >
                  {chromeImportLoading
                    ? "Importing…"
                    : `Import selected (${chromeImportSelected.size})`}
                </button>
              </div>
              {chromeImportResults && chromeImportResults.length > 0 && (
                <ul className="connected-platforms-chrome-import-results">
                  {chromeImportResults.map((result) => {
                    const name =
                      platforms.find((p) => p.id === result.platformId)?.name ??
                      result.platformId;
                    const ok = result.status === "connected";
                    return (
                      <li
                        key={result.platformId}
                        className={
                          ok
                            ? "connected-platforms-chrome-import-result--ok"
                            : "connected-platforms-chrome-import-result--err"
                        }
                      >
                        <strong>{name}:</strong>{" "}
                        {ok
                          ? "Imported and connected."
                          : result.error ?? "Import failed."}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <div className="connected-platforms-list">
        {platforms.map((platform) => {
          const status = platform.status;
          const isLoading = actionLoading === platform.id;
          const isConnected = status.status === "connected";
          const needsReauth =
            status.status === "expired" || status.status === "needs_reauth";
          const isWaitingForLogin = waitingForLogin.has(platform.id);
          const usesExternalChrome = externalChromeLogin.has(platform.id);

          return (
            <div key={platform.id} className="connected-platform-card">
              <div className="connected-platform-info">
                <div className="connected-platform-header">
                  <span className="connected-platform-name">{platform.name}</span>
                  {platform.isCustom && (
                    <span className="connected-platform-badge">Custom</span>
                  )}
                  <span
                    className="connected-platform-status"
                    style={{ color: getStatusColor(status.status) }}
                  >
                    <span
                      className="connected-platform-status-dot"
                      style={{ backgroundColor: getStatusColor(status.status) }}
                    />
                    {isWaitingForLogin ? "Waiting for sign-in..." : getStatusLabel(status.status)}
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

                {isWaitingForLogin && (
                  <div className="connected-platform-waiting-info">
                    {usesExternalChrome ? (
                      <>
                        <strong>Log in in the Chrome window</strong> that opened outside Papr.
                        <br />
                        <span className="connected-platform-waiting-note">
                          Passkeys and Google/Apple sign-in work in real Chrome. We detect login
                          automatically — click Check now when finished.
                        </span>
                      </>
                    ) : (
                      <>
                        <strong>Log in in the {platform.name} tab</strong> that opened in Papr.
                        <br />
                        <span className="connected-platform-waiting-note">
                          Finish sign-in in the Papr tab — we detect it automatically.
                          To use an existing Chrome login instead, use Import from Google
                          Chrome above (after you cancel or finish this flow).
                        </span>
                      </>
                    )}
                  </div>
                )}

                {status.error && !isWaitingForLogin && (
                  <div className="connected-platform-error-text">
                    {status.error}
                  </div>
                )}

                {platform.homeUrl && (
                  <div className="connected-platform-notes">{platform.homeUrl}</div>
                )}

                {platform.notes && !isConnected && !isWaitingForLogin && !platform.homeUrl && (
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
                    {platform.isCustom && (
                      <button
                        className="connected-platform-btn connected-platform-btn-danger"
                        onClick={() => void handleRemoveSite(platform.id)}
                        disabled={isLoading}
                      >
                        {isLoading ? "..." : "Remove"}
                      </button>
                    )}
                    <button
                      className="connected-platform-btn connected-platform-btn-danger"
                      onClick={() => handleDisconnect(platform.id)}
                      disabled={isLoading}
                    >
                      {isLoading ? "..." : "Disconnect"}
                    </button>
                  </>
                )}

                {needsReauth && !isWaitingForLogin && (
                  <>
                    <button
                      className="connected-platform-btn connected-platform-btn-primary"
                      onClick={() => handleConnect(platform.id)}
                      disabled={isLoading}
                    >
                      {isLoading ? "Connecting..." : "Reconnect"}
                    </button>
                    <button
                      className="connected-platform-btn connected-platform-btn-secondary"
                      onClick={() => handleConfirmLogin(platform.id)}
                      disabled={isLoading}
                    >
                      {isLoading ? "Checking..." : "Check now"}
                    </button>
                  </>
                )}

                {status.status === "disconnected" && !isWaitingForLogin && (
                  <button
                    className="connected-platform-btn connected-platform-btn-primary"
                    onClick={() => handleConnect(platform.id)}
                    disabled={isLoading}
                  >
                    {isLoading ? "Connecting..." : "Connect"}
                  </button>
                )}

                {isWaitingForLogin && (
                  <>
                    <button
                      className="connected-platform-btn connected-platform-btn-primary"
                      onClick={() => handleConfirmLogin(platform.id)}
                      disabled={isLoading}
                    >
                      {isLoading ? "Checking..." : "Check now"}
                    </button>
                    <button
                      className="connected-platform-btn connected-platform-btn-secondary"
                      onClick={() => handleCancelLogin(platform.id)}
                      disabled={isLoading}
                    >
                      Cancel
                    </button>
                  </>
                )}

                {status.status === "connecting" && !isWaitingForLogin && (
                  <button
                    className="connected-platform-btn connected-platform-btn-secondary"
                    disabled
                  >
                    Opening browser...
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
          <li>
            <strong>LinkedIn:</strong> Connect opens Papr-managed Chrome — sign in there (we never import from your personal Chrome)
          </li>
          <li>
            <strong>Other platforms:</strong> Connect opens Papr&apos;s browser for sign-in; optionally use <strong>Import from Google Chrome</strong> above if you&apos;re already logged in there
          </li>
          <li>
            <strong>Multiple platforms:</strong> one Papr Chrome window — each platform gets its own tab (connecting Reddit won&apos;t replace your LinkedIn tab)
          </li>
          <li>Papr stores sessions securely and refreshes them in the background</li>
          <li>The agent uses Papr-managed Chrome for automation (LinkedIn always; others when a live browser is needed)</li>
        </ol>
        <p className="connected-platforms-note">
          <strong>Note:</strong> LinkedIn always uses Papr&apos;s Chrome window. For other sites, import from personal Chrome only when you choose to — Papr does not read your Chrome cookies in the background.
        </p>
      </div>
    </div>
  );
}

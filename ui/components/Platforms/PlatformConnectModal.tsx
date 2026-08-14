/**
 * Social Login Modal
 *
 * A branded modal that appears when the agent needs a social platform connection.
 * Shows platform info and a "Connect" button that opens the browser login flow.
 */

import React, { useState, useEffect, useCallback } from "react";
import type { PlatformId } from "./platformConnectStore";
import { usePlatformConnectStore } from "./platformConnectStore";
import { gateway } from "../../src/lib/gateway";
import "./PlatformConnectModal.css";

type ConnectPhase = "idle" | "opening" | "waiting" | "connected";

// SVG icons for each platform
const PLATFORM_ICONS: Record<PlatformId, React.ReactNode> = {
  linkedin: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
    </svg>
  ),
  instagram: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <path d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z"/>
    </svg>
  ),
  reddit: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z"/>
    </svg>
  ),
  facebook: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
    </svg>
  ),
  tiktok: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/>
    </svg>
  ),
  twitter: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </svg>
  ),
  telegram: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
    </svg>
  ),
};

const PLATFORM_INFO: Record<
  PlatformId,
  { name: string; color: string; description: string }
> = {
  linkedin: {
    name: "LinkedIn",
    color: "#0A66C2",
    description: "Connect to access your messages, connections, and profile",
  },
  instagram: {
    name: "Instagram",
    color: "#E4405F",
    description: "Connect to access your DMs, posts, and followers",
  },
  reddit: {
    name: "Reddit",
    color: "#FF4500",
    description: "Connect to access your subreddits, messages, and posts",
  },
  facebook: {
    name: "Facebook",
    color: "#1877F2",
    description: "Connect to access your messages, pages, and profile",
  },
  tiktok: {
    name: "TikTok",
    color: "#000000",
    description: "Connect to access your videos, messages, and followers",
  },
  twitter: {
    name: "X / Twitter",
    color: "#000000",
    description: "Connect to access your tweets, DMs, and followers",
  },
  telegram: {
    name: "Telegram",
    color: "#0088CC",
    description: "Connect to access your chats, channels, and groups",
  },
};

export function PlatformConnectModal() {
  const { activeRequest, clearRequest } = usePlatformConnectStore();
  const [phase, setPhase] = useState<ConnectPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const dismissIfConnected = useCallback(
    (platformId: PlatformId, status: string) => {
      if (activeRequest?.platform === platformId && status === "connected") {
        setPhase("connected");
        setTimeout(() => clearRequest(), 800);
      }
    },
    [activeRequest?.platform, clearRequest],
  );

  // If already connected when modal opens, dismiss immediately
  useEffect(() => {
    if (!activeRequest) {
      setPhase("idle");
      setError(null);
      return;
    }

    void (async () => {
      try {
        const response = await gateway.send("platform:get-status", {
          platformId: activeRequest.platform,
        });
        const data = response.data as { status?: string } | undefined;
        if (data?.status === "connected") {
          clearRequest();
        }
      } catch {
        // Show modal — user can connect manually
      }
    })();
  }, [activeRequest, clearRequest]);

  // Listen for connection success (fixes typo: was platform:status-change)
  useEffect(() => {
    const handleStatusChange = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.type !== "platform:status-changed" || !detail.data) return;
      const { platformId, status } = detail.data as {
        platformId: PlatformId;
        status: string;
      };
      dismissIfConnected(platformId, status);
    };

    window.addEventListener("gateway-broadcast", handleStatusChange);
    return () => window.removeEventListener("gateway-broadcast", handleStatusChange);
  }, [dismissIfConnected]);

  if (!activeRequest) return null;

  const platformInfo = PLATFORM_INFO[activeRequest.platform];
  const isBusy = phase === "opening" || phase === "waiting";

  const handleConnect = async () => {
    setPhase("opening");
    setError(null);

    try {
      const response = await gateway.send("platform:connect", {
        platformId: activeRequest.platform,
      });

      const data = response.data as {
        status?: string;
        waitingForConfirmation?: boolean;
      };

      if (data?.status === "connected") {
        setPhase("connected");
        setTimeout(() => clearRequest(), 800);
        return;
      }

      if (data?.waitingForConfirmation) {
        setPhase("waiting");
        return;
      }

      if (!response.success) {
        setError(response.error || "Failed to start connection");
        setPhase("idle");
      } else {
        setPhase("waiting");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
      setPhase("idle");
    }
  };

  const handleCheckNow = async () => {
    setPhase("opening");
    setError(null);

    try {
      const response = await gateway.send("platform:confirm-login", {
        platformId: activeRequest.platform,
      });
      const data = response.data as { status?: string; error?: string };

      if (data?.status === "connected") {
        setPhase("connected");
        setTimeout(() => clearRequest(), 800);
        return;
      }

      setError(data?.error || response.error || "Still waiting for login in Chrome");
      setPhase("waiting");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Check failed");
      setPhase("waiting");
    }
  };

  const handleSkip = () => {
    clearRequest();
  };

  return (
    <div className="platform-connect-overlay" onClick={handleSkip}>
      <div
        className="platform-connect-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="platform-connect-content">
          <div
            className="platform-icon"
            style={{ backgroundColor: platformInfo.color }}
          >
            {PLATFORM_ICONS[activeRequest.platform]}
          </div>

          <h2 className="platform-title">Connect to {platformInfo.name}</h2>

          <p className="platform-description">{platformInfo.description}</p>

          {activeRequest.reason && (
            <div className="platform-reason">
              <span className="reason-label">Why:</span>
              <span className="reason-text">{activeRequest.reason}</span>
            </div>
          )}

          {phase === "waiting" && (
            <div className="platform-waiting-note">
              Log in using <strong>Chrome</strong> if needed — we detect it automatically.
            </div>
          )}

          {phase === "connected" && (
            <div className="platform-success">Connected successfully!</div>
          )}

          {error && <div className="platform-error">{error}</div>}
        </div>

        <div className="platform-connect-actions">
          <button
            className="btn btn-secondary"
            onClick={handleSkip}
            disabled={phase === "connected"}
          >
            Not now
          </button>

          {phase === "waiting" ? (
            <button
              className="btn btn-connect"
              onClick={handleCheckNow}
              disabled={phase === "opening"}
              style={{ backgroundColor: platformInfo.color }}
            >
              {phase === "opening" ? (
                <>
                  <span className="connecting-spinner" />
                  Checking...
                </>
              ) : (
                "Check now"
              )}
            </button>
          ) : (
            <button
              className="btn btn-connect"
              onClick={handleConnect}
              disabled={isBusy || phase === "connected"}
              style={{ backgroundColor: platformInfo.color }}
            >
              {phase === "opening" ? (
                <>
                  <span className="connecting-spinner" />
                  Opening Chrome...
                </>
              ) : phase === "connected" ? (
                "Connected!"
              ) : (
                <>Connect {platformInfo.name}</>
              )}
            </button>
          )}
        </div>

        <p className="platform-connect-footer">
          Opens Chrome for login. Your credentials are never stored — only session cookies.
        </p>
      </div>
    </div>
  );
}

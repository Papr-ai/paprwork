/**
 * RecommendedApps — the "recommend" phase of onboarding.
 *
 * Layout and voice are ported from the onboarding redesign prototype (stageC,
 * unknown-site branch): progress dots, provider ribbon, a tile grid that sells
 * a recurring outcome, and a dashed "Something else" panel that opens the
 * freeform prompt with coaching. Production has no site read, so this is
 * deliberately the prototype's NO-SITE-DATA screen — no evidence card, and
 * headline copy that asks rather than asserts.
 *
 * Picks resolve against the LIVE cloud catalog by slug. We deliberately do not
 * hardcode install metadata: installing needs a full CommunityCatalogEntry
 * (namespaceId, visibility, codeInstallable…), and a stale local copy would
 * fail at install time rather than render time. If the catalog can't load there
 * is nothing honest to show, so we surface a skip instead of fake cards — this
 * screen must never advertise an app it cannot actually install.
 *
 * Install is delegated to useCloudCatalogInstallFlow, the same hook the
 * Community Apps tab uses, so fork/track policy, the API-key wizard and the
 * post-install welcome chat behave identically here.
 *
 * PLATFORM CONNECT: `platform:connect` opens Papr Chrome and, on success,
 * platformSessionService.storeRequiredCookies() writes the cookies through the
 * SAME custom-keys service the setup wizard reads — so connecting first makes
 * the wizard open already satisfied instead of demanding a paste.
 */

import { useCallback, useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import type {
  CommunityCatalog,
  CommunityCatalogEntry,
} from "../../../src/core/types/communityCatalog";
import {
  ONBOARDING_RECOMMENDATIONS,
  type OnboardingRecommendation,
} from "../../constants/onboardingRecommendations";
import { useCloudCatalogInstallFlow } from "../../hooks/useCloudCatalogInstallFlow";
import { FreeformPrompt } from "./FreeformPrompt";
import { trackEvent } from "../../lib/telemetry";

interface RecommendedAppsProps {
  /** Install started — the phase machine advances and the tab gets out of the way. */
  onInstalling: (appName: string) => void;
  /** User described their own automation instead of picking a card. */
  onFreeform: (prompt: string) => void;
  /** User declined everything. */
  onSkip: () => void;
  /** Ribbon line, e.g. "Connected to Claude." Omitted when unknown. */
  providerLine?: string;
  /**
   * The gated auth step renders Skip itself, top-right beside the progress
   * dots like every other auth stage. The workspace tab keeps it at the bottom.
   */
  hideSkip?: boolean;
}

type LoadState = "loading" | "ready" | "unavailable";
type ConnectState = "unknown" | "disconnected" | "connecting" | "connected";

export function RecommendedApps({
  onInstalling,
  onFreeform,
  onSkip,
  providerLine,
  hideSkip = false,
}: RecommendedAppsProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [entries, setEntries] = useState<CommunityCatalogEntry[]>([]);
  const [connectState, setConnectState] = useState<Record<string, ConnectState>>(
    {},
  );
  const [connectError, setConnectError] = useState<string | null>(null);
  const [freeform, setFreeform] = useState(false);
  const { startCloudInstall, installingId } = useCloudCatalogInstallFlow();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await gateway.send("bundle:fetch-community-catalog", {
          scope: "global",
        });
        if (cancelled) return;

        const catalog = response.data as CommunityCatalog;
        // Preserve curated order rather than catalog order.
        const resolved = ONBOARDING_RECOMMENDATIONS.map((rec) =>
          catalog.entries.find(
            (entry) => entry.slug === rec.slug && entry.codeInstallable,
          ),
        ).filter((entry): entry is CommunityCatalogEntry => Boolean(entry));

        setEntries(resolved);
        setLoadState(resolved.length > 0 ? "ready" : "unavailable");
        trackEvent("paprwork_onboarding_step_viewed", {
          step_name: "recommend",
          resolved_count: resolved.length,
        } as Record<string, unknown>);
      } catch {
        if (!cancelled) setLoadState("unavailable");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Someone reinstalling may already have the platform connected — don't ask again.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      for (const rec of ONBOARDING_RECOMMENDATIONS.filter((r) => r.connect)) {
        const platformId = rec.connect!.platformId;
        try {
          const res = await gateway.send("platform:get-status", { platformId });
          const status = (res.data as { status?: string } | undefined)?.status;
          if (cancelled) return;
          setConnectState((prev) => ({
            ...prev,
            [platformId]: status === "connected" ? "connected" : "disconnected",
          }));
        } catch {
          if (!cancelled) {
            setConnectState((prev) => ({ ...prev, [platformId]: "disconnected" }));
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Sign-in finishes in Papr Chrome, not here — the gateway tells us when.
  useEffect(() => {
    const onBroadcast = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.type !== "platform:status-changed" || !detail.data) return;
      const { platformId, status } = detail.data as {
        platformId: string;
        status: string;
      };
      if (status === "connected") {
        setConnectState((prev) => ({ ...prev, [platformId]: "connected" }));
        setConnectError(null);
      }
    };

    window.addEventListener("gateway-broadcast", onBroadcast);
    return () => window.removeEventListener("gateway-broadcast", onBroadcast);
  }, []);

  const handleConnect = useCallback(async (rec: OnboardingRecommendation) => {
    const platformId = rec.connect!.platformId;
    setConnectState((prev) => ({ ...prev, [platformId]: "connecting" }));
    setConnectError(null);
    trackEvent("paprwork_onboarding_platform_connect_started", {
      step_name: "recommend",
      platform: platformId,
    } as Record<string, unknown>);

    try {
      const res = await gateway.send("platform:connect", { platformId });
      const data = res.data as { status?: string } | undefined;
      if (data?.status === "connected") {
        setConnectState((prev) => ({ ...prev, [platformId]: "connected" }));
        return;
      }
      if (!res.success) {
        setConnectError(res.error || "Couldn't open the sign-in window.");
        setConnectState((prev) => ({ ...prev, [platformId]: "disconnected" }));
      }
      // Otherwise Chrome is open and the broadcast listener takes it from here.
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "Connection failed.");
      setConnectState((prev) => ({ ...prev, [platformId]: "disconnected" }));
    }
  }, []);

  const handleInstall = (entry: CommunityCatalogEntry) => {
    trackEvent("paprwork_onboarding_step_completed", {
      step_name: "recommend",
      app_slug: entry.slug,
    } as Record<string, unknown>);
    startCloudInstall(entry, { catalogScope: "global" });
    onInstalling(entry.name);
  };

  if (freeform) {
    return (
      <FreeformPrompt
        onSubmit={onFreeform}
        onBack={() => setFreeform(false)}
      />
    );
  }

  if (loadState === "loading") {
    return (
      <div className="onboarding-recommend__status">
        <div className="onboarding-recommend__spinner" />
        <p>Finding a good place to start…</p>
      </div>
    );
  }

  // No catalog means no honest recommendation — offer the freeform path instead.
  if (loadState === "unavailable") {
    return (
      <div className="onboarding-recommend__status">
        <p className="onboarding-recommend__status-text">
          Couldn&apos;t reach the community catalog just now — but you can still
          describe what you want and Pen will build it.
        </p>
        <button
          className="onboarding-primary-btn"
          onClick={() => setFreeform(true)}
        >
          Describe it instead
        </button>
        <button className="onboarding-skip-btn" onClick={onSkip}>
          Skip for now
        </button>
      </div>
    );
  }

  return (
    <>
      {providerLine && (
        <p className="onboarding-recommend__ribbon">{providerLine}</p>
      )}
      <div className="onboarding-recommend__grid">
        {entries.map((entry) => {
          const rec = ONBOARDING_RECOMMENDATIONS.find(
            (r) => r.slug === entry.slug,
          );
          if (!rec) return null;

          const busy = installingId === entry.catalogId;
          const platformId = rec.connect?.platformId;
          const state = platformId ? connectState[platformId] : undefined;
          const needsConnect = Boolean(rec.connect) && state !== "connected";
          const connecting = state === "connecting";

          return (
            <button
              key={entry.catalogId}
              className="onboarding-recommend__tile"
              disabled={busy || Boolean(installingId) || connecting}
              onClick={() =>
                needsConnect ? void handleConnect(rec) : handleInstall(entry)
              }
            >
              <span className="onboarding-recommend__tile-title">
                {rec.title}
              </span>
              <span className="onboarding-recommend__tile-desc">{rec.desc}</span>
              <span className="onboarding-recommend__tile-meta">{rec.meta}</span>
              {/* One pill slot, two states: the platform requirement reads the
                  same whether it's still to do or already done. */}
              {needsConnect && (
                <span className="onboarding-recommend__tile-connect">
                  {connecting ? "Waiting for sign-in…" : rec.connect!.label}
                </span>
              )}
              {rec.connect && state === "connected" && (
                <span className="onboarding-recommend__tile-connect is-connected">
                  ✓ {rec.connect.label.replace("Connect ", "")} connected
                </span>
              )}
              {busy && (
                <span className="onboarding-recommend__tile-connect">
                  Installing…
                </span>
              )}
            </button>
          );
        })}
      </div>

      {connectError && (
        <p className="onboarding-recommend__error">{connectError}</p>
      )}

      <button
        className="onboarding-recommend__else"
        onClick={() => setFreeform(true)}
      >
        <span className="onboarding-recommend__else-title">Something else</span>
        <span className="onboarding-recommend__else-sub">
          Describe it in your own words and Pen will build it
        </span>
      </button>

      {!hideSkip && (
        <div className="onboarding-view-actions">
          <button className="onboarding-skip-btn" onClick={onSkip}>
            Skip — I&apos;ll just start chatting
          </button>
        </div>
      )}
    </>
  );
}

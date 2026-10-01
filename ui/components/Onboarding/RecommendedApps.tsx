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
 * Install uses the same cloud install path as Community Apps. After install,
 * Pen opens beside the app with a welcome message that includes any missing
 * keys or platform connections — no blocking setup wizard.
 *
 * Platform connect badges are informational; the tile installs the app and Pen
 * can walk through connect_platform / API keys in chat.
 */

import { useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import type {
  CommunityCatalog,
  CommunityCatalogEntry,
} from "../../../src/core/types/communityCatalog";
import {
  ONBOARDING_RECOMMENDATIONS,
} from "../../constants/onboardingRecommendations";
import {
  installCloudCatalogApp,
  planCloudInstallFailureHandoff,
  type CloudInstallResponse,
} from "../../utils/cloudCatalogInstall";
import { openChatWithPrompt } from "../../utils/openChatWithPrompt";
import { resolveOneInstallSelection } from "../../../src/core/utils/cloudCatalogInstallPolicy";
import { FreeformPrompt } from "./FreeformPrompt";
import { trackEvent } from "../../lib/telemetry";

interface RecommendedAppsProps {
  /** Install FINISHED (the app exists) — the host releases the gate and opens it. */
  onInstalled: (entry: CommunityCatalogEntry, result: CloudInstallResponse) => void;
  /** User described their own automation instead of picking a card. */
  onFreeform: (prompt: string) => void;
  /** User declined everything. */
  onSkip: () => void;
  /**
   * Install failed and Pen should take it from here. The gated host must
   * release first — a chat opened behind the auth gate is invisible, which is
   * how a failed install used to look like "nothing happened".
   */
  onInstallHandoff?: (agentMessage: string) => void;
  /** Ribbon line, e.g. "Connected to Claude." Omitted when unknown. */
  providerLine?: string;
  /**
   * The gated auth step renders Skip itself, top-right beside the progress
   * dots like every other auth stage. The workspace tab keeps it at the bottom.
   */
  hideSkip?: boolean;
  /**
   * Controlled "Something else" view. The gated step owns it so its single
   * bottom Back closes the freeform box instead of rendering a second Back.
   */
  freeformOpen?: boolean;
  onFreeformOpenChange?: (open: boolean) => void;
  /**
   * Auth recommend runs before the workspace exists. Release the gate so a
   * sign-in window / platform tab can actually render.
   */
}

type LoadState = "loading" | "ready" | "unavailable";
type ConnectState = "unknown" | "disconnected" | "connecting" | "connected";

export function RecommendedApps({
  onInstalled,
  onFreeform,
  onSkip,
  onInstallHandoff,
  providerLine,
  hideSkip = false,
  freeformOpen,
  onFreeformOpenChange,
}: RecommendedAppsProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [entries, setEntries] = useState<CommunityCatalogEntry[]>([]);
  const [connectState, setConnectState] = useState<Record<string, ConnectState>>(
    {},
  );
  const [localFreeform, setLocalFreeform] = useState(false);
  const controlled = freeformOpen !== undefined;
  const freeform = controlled ? freeformOpen : localFreeform;
  const setFreeform = (open: boolean) =>
    controlled ? onFreeformOpenChange?.(open) : setLocalFreeform(open);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  /** null = still checking host; false = need agent + Chrome install path. */

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
      }
    };

    window.addEventListener("gateway-broadcast", onBroadcast);
    return () => window.removeEventListener("gateway-broadcast", onBroadcast);
  }, []);

  /**
   * Install here and WAIT for it. The Community-tab hook this used to call
   * opens a fork/track dialog for global-catalog apps — a dialog this screen
   * never renders — and the gate was released before anything happened, so
   * nothing installed. Onboarding always forks into the user's workspace.
   */
  const handleInstall = async (entry: CommunityCatalogEntry) => {
    trackEvent("paprwork_onboarding_step_completed", {
      step_name: "recommend",
      app_slug: entry.slug,
    } as Record<string, unknown>);
    setInstallingId(entry.catalogId);
    setInstallError(null);
    const result = await installCloudCatalogApp(
      entry,
      resolveOneInstallSelection({
        catalogScope: "global",
        visibility: entry.visibility,
        codeInstallable: entry.codeInstallable,
      }),
      { catalogScope: "global" },
    ).catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : "Install failed",
    }));
    if (!result.ok) {
      setInstallingId(null);
      const plan = planCloudInstallFailureHandoff(entry, "fork", result);
      if (plan.kind === "agent") {
        setInstallError(null);
        if (onInstallHandoff) onInstallHandoff(plan.agentMessage);
        else openChatWithPrompt(plan.agentMessage);
        return;
      }
      setInstallError(`Couldn't install ${entry.name}: ${plan.message.slice(0, 200)}`);
      return;
    }
    onInstalled(entry, result.data);
  };

  if (freeform) {
    return (
      <FreeformPrompt
        onSubmit={onFreeform}
        onBack={controlled ? undefined : () => setFreeform(false)}
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

          return (
            <button
              key={entry.catalogId}
              className="onboarding-recommend__tile"
              disabled={busy || Boolean(installingId)}
              onClick={() => {
                void handleInstall(entry);
              }}
            >
              <span className="onboarding-recommend__tile-title">
                {rec.title}
              </span>
              <span className="onboarding-recommend__tile-desc">{rec.desc}</span>
              <span className="onboarding-recommend__tile-meta">{rec.meta}</span>
              {/* One pill slot, two states: the platform requirement reads the
                  same whether it's still to do or already done. */}
              {needsConnect && rec.connect && (
                <span className="onboarding-recommend__tile-connect">
                  Pen can help connect {rec.connect.label.replace("Connect ", "")} in chat after install
                </span>
              )}
              {rec.connect && state === "connected" && (
                <span className="onboarding-recommend__tile-connect is-connected">
                  ✓ {rec.connect.label.replace("Connect ", "")} connected
                </span>
              )}
              {busy && (
                <span className="onboarding-recommend__tile-connect">
                  Installing… this can take a minute
                </span>
              )}
            </button>
          );
        })}
      </div>

      {installError && (
        <p className="onboarding-recommend__error">{installError}</p>
      )}

      <button
        className="onboarding-recommend__else"
        disabled={Boolean(installingId)}
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

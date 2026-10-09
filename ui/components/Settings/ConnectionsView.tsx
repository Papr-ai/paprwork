/**
 * ConnectionsView — one place for everything Pen can use outside Papr.
 *
 * Services: MCP sign-ins (one click, no keys) and browser sign-ins (sites with
 * no official API, tied to this Mac). API keys: the Key Vault. Same access
 * model, one switch apart.
 */

import { useCallback, useEffect, useState } from "react";
import { McpConnectionsTab } from "./McpConnectionsTab";
import { ConnectedPlatformsTab } from "./ConnectedPlatformsTab";
import { IntegrationKeysTab } from "./IntegrationKeysTab";
import { OrgConnectionsPanel } from "./OrgConnectionsPanel";
import { useOrgConnections } from "../../hooks/useOrgConnections";
import { CONNECTIONS_REQUESTS_EVENT } from "../../stores/proposalNoticeListener";
import "./ConnectionsView.css";

export type ConnectionsSubTab = "services" | "keys";

const SUB_KEY = "papr-connections-sub-tab";

function readSub(): ConnectionsSubTab {
  try {
    return sessionStorage.getItem(SUB_KEY) === "keys" ? "keys" : "services";
  } catch {
    return "services";
  }
}

export function ConnectionsView({ link }: { link?: { sub: ConnectionsSubTab; n: number } | null }) {
  const [sub, setSub] = useState<ConnectionsSubTab>(() => link?.sub ?? readSub());
  const org = useOrgConnections();
  const pending = org.isAdmin ? org.requests.length : 0;
  const [serviceCount, setServiceCount] = useState<number | null>(null);
  const onCount = useCallback((n: number) => setServiceCount(n), []);
  const openOrgSettings = () => {
    setSub("services");
    requestAnimationFrame(() =>
      document.getElementById("connections-org-settings")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  // A request notification lands on Services, where the admin's Requests list lives.
  useEffect(() => {
    const toServices = () => setSub("services");
    window.addEventListener(CONNECTIONS_REQUESTS_EVENT, toServices);
    return () => window.removeEventListener(CONNECTIONS_REQUESTS_EVENT, toServices);
  }, []);

  // A deep link (e.g. "missing key" → Settings) can switch tabs while mounted; n re-fires repeats.
  useEffect(() => {
    if (link) setSub(link.sub);
  }, [link]);

  useEffect(() => {
    try {
      sessionStorage.setItem(SUB_KEY, sub);
    } catch {
      /* private browsing */
    }
  }, [sub]);

  return (
    <div className="settings-content settings-content--full-width connections-view">
      <header className="connections-view__head">
        <div className="connections-view__title-row">
          <h2 className="settings-section__title">Connections</h2>
          {org.isAdmin && org.policy && (
            <button type="button" className="svc-btn" onClick={openOrgSettings}>
              Org settings
            </button>
          )}
        </div>
        <p className="settings-section__description">
          Let Pen work in the tools you already use. Sign in once. API keys for your own code live here too.
        </p>
      </header>

      <div className="connections-view__tabs" role="tablist" aria-label="Connection type">
        {(
          [
            ["services", "Services"],
            ["keys", "API keys"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={sub === id}
            className={`connections-view__tab${sub === id ? " is-active" : ""}`}
            onClick={() => setSub(id)}
          >
            {label}
            {id === "services" && serviceCount !== null && serviceCount > 0 && (
              <span className="connections-view__count">{serviceCount}</span>
            )}
            {id === "services" && pending > 0 && (
              <span className="connections-view__badge" aria-label={`${pending} pending requests`}>
                {pending}
              </span>
            )}
          </button>
        ))}
      </div>

      {sub === "services" ? (
        <div role="tabpanel" aria-label="Services">
          <McpConnectionsTab embedded org={org} onCount={onCount} />
          <section className="connections-view__browser svc-sec">
            <div className="svc-sec__h">
              <h3>Website logins</h3>
              <span className="svc-sec__note">For sites with no direct connection. They stay on this Mac.</span>
            </div>
            <ConnectedPlatformsTab embedded />
          </section>
          <div id="connections-org-settings">
            <OrgConnectionsPanel org={org} />
          </div>
        </div>
      ) : (
        <div role="tabpanel" aria-label="API keys">
          <IntegrationKeysTab embedded />
        </div>
      )}
    </div>
  );
}

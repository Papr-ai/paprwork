/**
 * ConnectionsView — one place for everything Pen can use outside Papr.
 *
 * Services: MCP sign-ins (one click, no keys) and website logins (sites with
 * no official API; a browser session on this Mac) in one list. API keys: the Key Vault. Same access
 * model, one switch apart.
 */

import { useCallback, useEffect, useState } from "react";
import { McpConnectionsTab } from "./McpConnectionsTab";
import { IntegrationKeysTab } from "./IntegrationKeysTab";
import { OrgConnectionsPanel } from "./OrgConnectionsPanel";
import { useOrgConnections } from "../../hooks/useOrgConnections";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import { CONNECTIONS_REQUESTS_EVENT } from "../../stores/proposalNoticeListener";
import "./ConnectionsUi.css";
import "./ConnectionsView.css";

export type ConnectionsSubTab = "services" | "keys";

const SUB_KEY = "papr-connections-sub-tab";
/** AI provider keys live under Models; MCP sign-ins under Services. */
const HIDDEN_KEY = /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|PAPR_API_KEY|MCP_.+_OAUTH)$/;

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
  const { keys } = useCustomKeys();
  const keyCount = keys.filter((k) => !HIDDEN_KEY.test(k.name)).length;
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
    <div className="settings-content connections-view">
      <header className="connections-view__head">
        <div className="connections-view__title-row">
          <h2 className="connections-view__h1">Connections</h2>
          {org.isAdmin && org.policy && (
            <button type="button" className="svc-btn" onClick={openOrgSettings}>
              Org settings
            </button>
          )}
        </div>
        <p className="connections-view__sub">
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
            {id === "keys" && keyCount > 0 && <span className="connections-view__count">{keyCount}</span>}
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

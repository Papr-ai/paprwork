/**
 * ConnectionsView — one place for everything Pen can use outside Papr.
 *
 * Services: MCP sign-ins (one click, no keys) and browser sign-ins (sites with
 * no official API, tied to this Mac). API keys: the Key Vault. Same access
 * model, one switch apart.
 */

import { useEffect, useState } from "react";
import { McpConnectionsTab } from "./McpConnectionsTab";
import { ConnectedPlatformsTab } from "./ConnectedPlatformsTab";
import { IntegrationKeysTab } from "./IntegrationKeysTab";
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
        <h2 className="settings-section__title">Connections</h2>
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
          </button>
        ))}
      </div>

      {sub === "services" ? (
        <div role="tabpanel" aria-label="Services">
          <McpConnectionsTab embedded />
          <section className="connections-view__browser">
            <h3 className="connections-view__group">Browser sign-ins</h3>
            <p className="connections-view__note">
              For sites with no official connection. Pen uses a signed-in browser on this Mac, so these
              don't follow you to other devices or the web.
            </p>
            <ConnectedPlatformsTab embedded />
          </section>
        </div>
      ) : (
        <div role="tabpanel" aria-label="API keys">
          <IntegrationKeysTab embedded />
        </div>
      )}
    </div>
  );
}

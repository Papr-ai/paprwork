/**
 * McpConnectionsTab — one-click OAuth sign-in to remote MCP servers.
 *
 * Connect opens the service's consent page in the system browser (the gateway
 * does that; the UI only shows state). While any server is awaiting approval we
 * poll its status every 2s; otherwise the tab is static.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import "./McpConnectionsTab.css";
import { McpServerSheet, type McpConnectChoice } from "./McpServerSheet";
import { canConnect, type useOrgConnections } from "../../hooks/useOrgConnections";

const GATEWAY = "http://localhost:18789";
const POLL_MS = 2_000;

type McpState = "disconnected" | "connecting" | "awaiting_user" | "connected" | "needs_reauth" | "error";

interface McpServer {
  id: string;
  name: string;
  url: string;
  description?: string;
  category?: string;
  verified: boolean;
  custom: boolean;
  requiresClientId: boolean;
  state: McpState;
  toolCount: number;
  error?: string;
  authUrl?: string;
}

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json as T;
}

const STATE_LABEL: Record<McpState, string> = {
  disconnected: "",
  connecting: "Starting…",
  awaiting_user: "Approve in your browser",
  connected: "Connected",
  needs_reauth: "Sign-in expired",
  error: "Failed",
};

function initials(name: string): string {
  return name.replace(/[^A-Za-z0-9 ]/g, "").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

export function McpConnectionsTab({
  embedded = false,
  org,
}: {
  embedded?: boolean;
  /** Org rules + requests; when a service isn't approved the card offers Request instead of Connect. */
  org?: ReturnType<typeof useOrgConnections>;
} = {}) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { servers } = await api<{ servers: McpServer[] }>("/api/mcp/servers");
      setServers(servers);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load connections");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = servers.some((s) => s.state === "awaiting_user" || s.state === "connecting");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [pending, load]);

  const act = async (id: string, action: "connect" | "disconnect" | "cancel", choice?: McpConnectChoice) => {
    setBusy(id);
    setError(null);
    try {
      await api(`/api/mcp/servers/${id}/${action}`, "POST", action === "connect" && choice ? choice : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${action}`);
    } finally {
      setBusy(null);
      void load();
    }
  };

  const addCustom = async () => {
    const url = customUrl.trim();
    if (!url) return;
    setBusy("__custom");
    setError(null);
    try {
      const { server } = await api<{ server: McpServer }>("/api/mcp/servers", "POST", { url });
      setCustomUrl("");
      await api(`/api/mcp/servers/${server.id}/connect`, "POST");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add server");
    } finally {
      setBusy(null);
      void load();
    }
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = servers.filter(
      (s) => !q || `${s.name} ${s.description ?? ""} ${s.category ?? ""}`.toLowerCase().includes(q),
    );
    const connected = visible.filter((s) => s.state !== "disconnected");
    const rest = visible.filter((s) => s.state === "disconnected");
    const byCat = new Map<string, McpServer[]>();
    for (const s of rest) {
      const cat = s.requiresClientId ? "Needs setup" : (s.category ?? "Other");
      byCat.set(cat, [...(byCat.get(cat) ?? []), s]);
    }
    const ordered = [...byCat.entries()].sort(([a], [b]) =>
      a === "Needs setup" ? 1 : b === "Needs setup" ? -1 : a.localeCompare(b),
    );
    return { connected, ordered };
  }, [servers, query]);

  const renderCard = (s: McpServer) => {
    const isBusy = busy === s.id;
    const label = s.state === "connected" ? `${s.toolCount} tools` : STATE_LABEL[s.state];
    // Connected services open their detail panel; needs-setup services open the setup panel.
    // Disconnected ones open too, so you can pick who can use it before connecting.
    const opens = s.state === "connected" || s.state === "disconnected" || s.requiresClientId;
    return (
      <div
        key={s.id}
        className={`mcp-card mcp-card--${s.state}${opens ? " mcp-card--clickable" : ""}`}
        onClick={opens ? () => setOpenId(s.id) : undefined}
      >
        <div className="mcp-card__icon" aria-hidden>{initials(s.name)}</div>
        <div className="mcp-card__body">
          <div className="mcp-card__name">{s.name}</div>
          <div className="mcp-card__desc">
            {s.state === "disconnected" ? s.description : label}
            {s.state === "error" && s.error ? ` — ${s.error}` : ""}
          </div>
          {s.state === "awaiting_user" && s.authUrl && (
            <a className="mcp-card__link" href={s.authUrl} target="_blank" rel="noreferrer">
              Browser didn't open? Open sign-in page
            </a>
          )}
        </div>
        <div className="mcp-card__action">
          {s.requiresClientId ? (
            <button type="button" className="settings-btn settings-btn--secondary" onClick={(e) => { e.stopPropagation(); setOpenId(s.id); }}>
              Set up
            </button>
          ) : s.state === "connected" ? (
            <button type="button" className="settings-btn settings-btn--ghost" disabled={isBusy} onClick={(e) => { e.stopPropagation(); void act(s.id, "disconnect"); }}>
              Disconnect
            </button>
          ) : s.state === "awaiting_user" || s.state === "connecting" ? (
            <button type="button" className="settings-btn settings-btn--ghost" disabled={isBusy} onClick={() => void act(s.id, "cancel")}>
              Cancel
            </button>
          ) : org && !canConnect(org.policy, s.id) ? (
            (() => {
              const mine = org.requests.find((r) => r.serverId === s.id);
              return mine ? (
                <>
                  <span className="mcp-card__requested">Requested</span>
                  <button type="button" className="settings-btn settings-btn--ghost" onClick={(e) => { e.stopPropagation(); void org.cancel(mine.id); }}>
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="settings-btn settings-btn--secondary"
                  title="Your organization approves services before members connect them"
                  onClick={(e) => {
                    e.stopPropagation();
                    const note = window.prompt(`Ask your admin to approve ${s.name}. Add a note (optional):`, "");
                    if (note !== null) void org.request(s.id, s.name, note);
                  }}
                >
                  Request
                </button>
              );
            })()
          ) : (
            <button type="button" className="settings-btn settings-btn--primary" disabled={isBusy} onClick={(e) => { e.stopPropagation(); void act(s.id, "connect"); }}>
              {isBusy ? "Opening…" : s.state === "needs_reauth" || s.state === "error" ? "Reconnect" : "Connect"}
            </button>
          )}
        </div>
      </div>
    );
  };

  const open = servers.find((s) => s.id === openId) ?? null;

  if (loading) return <div className="mcp-tab__empty">Loading connections…</div>;

  return (
    <div className="mcp-tab">
      {!embedded && (
        <div className="settings-section__header">
          <div>
            <h2 className="settings-section__title">Connections</h2>
            <p className="settings-section__description">
              Sign in once and Pen can use the service's tools. No API keys. Sign-ins stay in your keychain.
            </p>
          </div>
        </div>
      )}

      <input
        className="form-input mcp-tab__search"
        type="search"
        placeholder={`Search ${servers.length} services`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {error && <div className="mcp-tab__error">{error}</div>}

      {groups.connected.length > 0 && (
        <section className="mcp-group">
          <h3 className="mcp-group__title">Your connections</h3>
          <div className="mcp-grid">{groups.connected.map(renderCard)}</div>
        </section>
      )}

      {groups.ordered.map(([cat, list]) => (
        <section key={cat} className="mcp-group">
          <h3 className="mcp-group__title">{cat}</h3>
          <div className="mcp-grid">{list.map(renderCard)}</div>
        </section>
      ))}

      {groups.connected.length + groups.ordered.length === 0 && (
        <div className="mcp-tab__empty">No services match “{query}”. Add it by URL below.</div>
      )}

      <section className="mcp-group">
        <h3 className="mcp-group__title">Another MCP server</h3>
        <div className="mcp-custom">
          <input
            className="form-input"
            type="url"
            placeholder="https://mcp.example.com/mcp"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void addCustom()}
          />
          <button type="button" className="settings-btn settings-btn--primary" disabled={!customUrl.trim() || busy === "__custom"} onClick={() => void addCustom()}>
            Connect
          </button>
        </div>
      </section>
      {open && (
        <McpServerSheet
          server={open}
          orgMax={org?.policy?.maxPenAccess}
          onClose={() => setOpenId(null)}
          onDisconnect={() => {
            setOpenId(null);
            void act(open.id, "disconnect");
          }}
          onConnect={async (choice) => {
            setOpenId(null);
            await act(open.id, "connect", choice);
          }}
        />
      )}
    </div>
  );
}

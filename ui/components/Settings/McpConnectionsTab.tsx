/**
 * McpConnectionsTab — Connections → Services (Connections redesign).
 *
 *   Connected     what you signed in to; anything that needs you sorts first
 *   Team          sign-ins a teammate shared with you
 *   Add a service search + Popular / All / category chips; Connect, Set up or Request
 *
 * First visit (nothing connected) shows one sentence of value and four
 * one-click starts instead of the Connected list. Clicking a row opens the
 * detail panel (who can use it, Pen access, setup). While a sign-in is waiting
 * on the browser we poll every 2s; otherwise the list is static.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import "./McpConnectionsTab.css";
import { McpServerSheet, mcpKeyName, type McpConnectChoice } from "./McpServerSheet";
import { RowButton, ServiceLogo, ServiceRow, type McpServer } from "./McpServiceRow";
import { canConnect, type useOrgConnections } from "../../hooks/useOrgConnections";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import { PLATFORM_META, usePlatformConnections, type PlatformInfo } from "../../hooks/usePlatformConnections";
import { AddSiteSheet, SiteSheet, siteLogoServer } from "./SiteSheet";

const GATEWAY = "http://localhost:18789";
const POLL_MS = 2_000;
const QUICK_STARTS = ["notion", "linear", "github", "slack"];
const POPULAR = ["notion", "linear", "github", "slack", "hubspot", "googledrive", "atlassian", "stripe", "asana", "airtable"];
const STATE_RANK: Record<string, number> = { needs_reauth: 0, error: 0, awaiting_user: 1, connecting: 1, connected: 2 };
const SITE_RANK = (p: PlatformInfo, waiting: Set<string>) =>
  waiting.has(p.id) || p.status.status === "connecting" ? 1 : p.status.status === "connected" ? 2 : 0;

const SOCIAL = "Social";

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

type Org = ReturnType<typeof useOrgConnections>;

export function McpConnectionsTab({
  embedded = false,
  org,
  onCount,
}: {
  embedded?: boolean;
  /** Org rules + requests; when a service isn't approved the row offers Request instead of Connect. */
  org?: Org;
  /** Connected + team count, for the Services tab label. */
  onCount?: (n: number) => void;
} = {}) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState("popular");
  const [busy, setBusy] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customUrl, setCustomUrl] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string | "new" | null>(null);
  const { keys } = useCustomKeys();
  const sites = usePlatformConnections();

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
      setShowCustom(false);
      await api(`/api/mcp/servers/${server.id}/connect`, "POST");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add server");
    } finally {
      setBusy(null);
      void load();
    }
  };

  const keyByName = useMemo(() => new Map(keys.map((k) => [k.name, k])), [keys]);
  const sections = useMemo(() => {
    const active = servers.filter((s) => s.state !== "disconnected");
    const isTeam = (s: McpServer) => s.state === "connected" && keyByName.get(mcpKeyName(s.id))?.vaultOrigin === "shared";
    const team = active.filter(isTeam);
    const mine = active.filter((s) => !isTeam(s)).sort((a, b) => (STATE_RANK[a.state] ?? 2) - (STATE_RANK[b.state] ?? 2));
    const free = servers.filter((s) => s.state === "disconnected");
    // Website logins: anything signed in (or mid sign-in) is "mine"; the rest are addable under Social.
    const siteActive = (p: PlatformInfo) => p.status.status !== "disconnected" || sites.waiting.has(p.id);
    const mySites = sites.platforms.filter(siteActive).sort((a, b) => SITE_RANK(a, sites.waiting) - SITE_RANK(b, sites.waiting));
    const freeSites = sites.platforms.filter((p) => !siteActive(p));
    const q = query.trim().toLowerCase();
    const cats = [...new Set([...free.map((s) => s.category ?? "Other"), ...(freeSites.length ? [SOCIAL] : [])])].sort();
    let add: McpServer[];
    let addSites: PlatformInfo[] = [];
    const siteText = (p: PlatformInfo) => `${p.name} ${PLATFORM_META[p.id]?.desc ?? ""} ${SOCIAL} website login`.toLowerCase();
    if (q) {
      add = free.filter((s) => `${s.name} ${s.description ?? ""} ${s.category ?? ""}`.toLowerCase().includes(q));
      addSites = freeSites.filter((p) => siteText(p).includes(q));
    } else if (chip === "popular") add = POPULAR.map((id) => free.find((s) => s.id === id)).filter((s): s is McpServer => !!s);
    else if (chip === "all") {
      add = [...free].sort((a, b) => a.name.localeCompare(b.name));
      addSites = freeSites;
    } else {
      add = free.filter((s) => (s.category ?? "Other") === chip);
      if (chip === SOCIAL) addSites = freeSites;
    }
    return { mine, team, add, addSites, mySites, cats, freeCount: free.length + freeSites.length };
  }, [servers, keyByName, query, chip, sites.platforms, sites.waiting]);

  useEffect(() => {
    if (!loading) onCount?.(sections.mine.length + sections.team.length + sections.mySites.length);
  }, [loading, sections.mine.length, sections.team.length, sections.mySites.length, onCount]);

  const open = servers.find((s) => s.id === openId) ?? null;
  const blocked = (s: McpServer) => Boolean(org && !canConnect(org.policy, s.id));
  const myRequest = (s: McpServer) => org?.requests.find((r) => r.serverId === s.id);

  const request = (s: McpServer) => {
    const note = window.prompt(`Ask your admin to approve ${s.name}. Add a note (optional):`, "");
    if (note !== null) void org?.request(s.id, s.name, note);
  };

  if (loading || sites.loading) {
    return (
      <div className="svc-sec" aria-busy="true">
        <div className="svc-list svc-list--skeleton">
          {[0, 1, 2].map((i) => <div key={i} className="svc-row svc-row--skeleton" />)}
        </div>
      </div>
    );
  }

  const connectedRow = (s: McpServer) => {
    const key = keyByName.get(mcpKeyName(s.id));
    if (s.state === "connected") {
      const shared = key && key.vaultAudience && key.vaultAudience !== "user" ? " · Shared with your team" : "";
      return <ServiceRow key={s.id} server={s} tone="ok" status={`Connected · ${s.toolCount} tools${shared}`} onOpen={() => setOpenId(s.id)} />;
    }
    if (s.state === "awaiting_user" || s.state === "connecting") {
      return (
        <ServiceRow
          key={s.id}
          server={s}
          tone="wait"
          status="Finish signing in in your browser"
          footer={s.authUrl ? (
            <a className="svc-row__link" href={s.authUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              Browser didn't open? Open the sign-in page
            </a>
          ) : undefined}
          action={<RowButton disabled={busy === s.id} onClick={() => void act(s.id, "cancel")}>Cancel</RowButton>}
        />
      );
    }
    const why = s.state === "needs_reauth" ? `Sign-in expired · Pen can't use ${s.name}` : `Couldn't connect${s.error ? ` · ${s.error}` : ""}`;
    return (
      <ServiceRow
        key={s.id}
        server={s}
        tone="warn"
        status={why}
        onOpen={() => setOpenId(s.id)}
        action={<RowButton primary disabled={busy === s.id} onClick={() => void act(s.id, "connect")}>Reconnect</RowButton>}
      />
    );
  };

  const addRow = (s: McpServer) => {
    const isBlocked = blocked(s);
    const asked = isBlocked ? myRequest(s) : undefined;
    const tag = asked ? "Requested" : isBlocked ? "Not approved" : s.requiresClientId ? "Setup" : undefined;
    const action = asked ? (
      <RowButton onClick={() => void org?.cancel(asked.id)}>Cancel request</RowButton>
    ) : isBlocked ? (
      <RowButton title="Your org approves services before members connect them" onClick={() => request(s)}>Request</RowButton>
    ) : s.requiresClientId ? (
      <RowButton onClick={() => setOpenId(s.id)}>Set up</RowButton>
    ) : (
      <RowButton disabled={busy === s.id} onClick={() => void act(s.id, "connect")}>{busy === s.id ? "Opening…" : "Connect"}</RowButton>
    );
    return (
      <ServiceRow
        key={s.id}
        server={s}
        status={s.description ?? s.category ?? ""}
        tag={tag}
        dim={isBlocked}
        action={action}
        onOpen={isBlocked && !asked ? undefined : () => setOpenId(s.id)}
      />
    );
  };

  const siteRow = (p: PlatformInfo) => {
    const st = p.status.status;
    const busySite = sites.busy === p.id;
    const open = () => setSiteId(p.id);
    if (sites.waiting.has(p.id) || st === "connecting") {
      return (
        <ServiceRow
          key={`site:${p.id}`}
          server={siteLogoServer(p)}
          tone="wait"
          status="Finish signing in in the browser window"
          onOpen={open}
          action={<RowButton onClick={() => sites.cancel(p.id)}>Cancel</RowButton>}
        />
      );
    }
    if (st === "connected") {
      return <ServiceRow key={`site:${p.id}`} server={siteLogoServer(p)} tone="ok" status="Connected · This Mac only" onOpen={open} />;
    }
    return (
      <ServiceRow
        key={`site:${p.id}`}
        server={siteLogoServer(p)}
        tone="warn"
        status={`Sign-in expired · Pen can't use ${p.name}`}
        onOpen={open}
        action={<RowButton primary disabled={busySite} onClick={() => void sites.connect(p.id)}>Reconnect</RowButton>}
      />
    );
  };

  const addSiteRow = (p: PlatformInfo) => (
    <ServiceRow
      key={`site:${p.id}`}
      server={siteLogoServer(p)}
      status={PLATFORM_META[p.id]?.desc ?? "Website login"}
      tag="Browser"
      onOpen={() => setSiteId(p.id)}
      action={
        sites.chrome === false ? (
          <RowButton onClick={() => sites.setupWithPen(p.id, p.name)}>Set up</RowButton>
        ) : (
          <RowButton disabled={sites.busy === p.id || sites.chrome === null} onClick={() => void sites.connect(p.id)}>
            {sites.busy === p.id ? "Opening…" : "Connect"}
          </RowButton>
        )
      }
    />
  );

  const firstVisit = sections.mine.length === 0 && sections.team.length === 0 && sections.mySites.length === 0;
  const mineRows = [...sections.mine.map((s) => ({ rank: STATE_RANK[s.state] ?? 2, el: connectedRow(s) })), ...sections.mySites.map((p) => ({ rank: SITE_RANK(p, sites.waiting), el: siteRow(p) }))]
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.el);
  const site = siteId && siteId !== "new" ? sites.platforms.find((p) => p.id === siteId) ?? null : null;
  const quick = QUICK_STARTS.map((id) => servers.find((s) => s.id === id)).filter((s): s is McpServer => !!s && !blocked(s));
  const restricted = org && !org.isAdmin && org.policy && org.policy.mode !== "all";

  return (
    <div className="mcp-tab">
      {!embedded && (
        <div className="settings-section__header">
          <h2 className="settings-section__title">Connections</h2>
        </div>
      )}

      {error && <div className="mcp-tab__error" role="alert">{error}</div>}
      {!siteId && sites.error && (
        <div className="mcp-tab__error" role="alert">
          {sites.error}
          {sites.needsChromeFor && (
            <button
              type="button"
              className="svc-btn svc-btn--primary mcp-tab__error-cta"
              onClick={() => sites.setupWithPen(sites.needsChromeFor!, sites.platforms.find((p) => p.id === sites.needsChromeFor)?.name ?? sites.needsChromeFor!)}
            >
              Set up with Pen
            </button>
          )}
        </div>
      )}
      {sites.notice && <p className="svc-hint">{sites.notice}</p>}

      {firstVisit ? (
        <section className="svc-empty">
          <div className="svc-empty__marks">
            {quick.map((s) => <ServiceLogo key={s.id} server={s} />)}
          </div>
          <h2>Connect the tools you already use</h2>
          <p>
            Pen can then search, report on and update them for you, in chat or on a schedule. You sign in with the
            service directly; there are no API keys to copy.
          </p>
          <div className="svc-empty__quick">
            {quick.map((s) => (
              <button key={s.id} type="button" className="svc-quick" disabled={busy === s.id} onClick={() => void act(s.id, "connect")}>
                <ServiceLogo server={s} size="sm" />
                {s.name}
              </button>
            ))}
          </div>
        </section>
      ) : (
        <>
          {mineRows.length > 0 && (
            <section className="svc-sec">
              <div className="svc-sec__h"><h3>Connected</h3><span>{mineRows.length}</span></div>
              <div className="svc-list">{mineRows}</div>
            </section>
          )}
          {sections.team.length > 0 && (
            <section className="svc-sec">
              <div className="svc-sec__h">
                <h3>Team</h3><span>{sections.team.length}</span>
                <span className="svc-sec__note">Shared by a teammate. You use their sign-in.</span>
              </div>
              <div className="svc-list">
                {sections.team.map((s) => (
                  <ServiceRow key={s.id} server={s} tone="ok" status={`Shared with you · ${s.toolCount} tools`} onOpen={() => setOpenId(s.id)} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <section className="svc-sec">
        <div className="svc-sec__h">
          <h3>Add a service</h3>
          <span className="svc-sec__links">
            <button type="button" className="svc-btn" onClick={() => setSiteId("new")}>
              + Website login
            </button>
            <button type="button" className="svc-btn" onClick={() => setShowCustom((v) => !v)} aria-expanded={showCustom}>
              + Custom MCP server
            </button>
          </span>
        </div>

        {showCustom && (
          <div className="svc-list svc-list--pad">
            <p className="svc-hint">
              Paste the server URL. If it supports sign-in, your browser opens to approve.
            </p>
            <div className="svc-custom">
              <input
                className="form-input"
                type="url"
                aria-label="MCP server URL"
                placeholder="https://mcp.example.com/mcp"
                value={customUrl}
                autoFocus
                onChange={(e) => setCustomUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addCustom()}
              />
              <button type="button" className="svc-btn svc-btn--primary" disabled={!customUrl.trim() || busy === "__custom"} onClick={() => void addCustom()}>
                Connect
              </button>
            </div>
          </div>
        )}

        {restricted && (
          <p className="svc-hint">Your org only allows approved services. Request others and your admin gets a notification.</p>
        )}

        <label className="svc-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            aria-label="Search services"
            placeholder={`Search ${sections.freeCount} services`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <div className="svc-chips" role="tablist" aria-label="Filter services">
          {[["popular", "Popular"], ["all", `All ${sections.freeCount}`], ...sections.cats.map((c) => [c, c])].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={!query && chip === id}
              className={`svc-chip${!query && chip === id ? " is-on" : ""}`}
              onClick={() => {
                setQuery("");
                setChip(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="svc-list">
          {sections.add.length || sections.addSites.length ? (
            <>
              {sections.add.map(addRow)}
              {sections.addSites.map(addSiteRow)}
            </>
          ) : (
            <div className="svc-none">
              {query ? `No service called "${query}". Add it as a custom MCP server.` : "Everything here is already connected."}
            </div>
          )}
        </div>
      </section>

      {siteId === "new" && <AddSiteSheet sites={sites} onClose={() => setSiteId(null)} onAdded={(id) => setSiteId(id)} />}
      {site && <SiteSheet site={site} sites={sites} onClose={() => setSiteId(null)} />}

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

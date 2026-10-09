/**
 * Connections → API keys (the Key Vault, folded in). Same grouped list and
 * the same detail modal as Services: one row per key, click to edit.
 * Keys a teammate shared with you are read-only.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import type { CustomKey } from "../../types/settings";
import { formatVaultAudienceLabel } from "../../constants/integrationKeyVaultAudience";
import { pullSharedVaultKeys } from "../../utils/vaultPullShared";
import type { WorkspaceMemberOption } from "./IntegrationKeyMemberPicker";
import { formatOrgScopeLabel, type OrgScopeOption } from "./IntegrationKeyOrgScopeSelector";
import { Chevron } from "./McpServiceRow";
import { KeyMark } from "./ConnectionsUi";
import { KeySheet, type KeySheetContext } from "./KeySheet";
import "./McpConnectionsTab.css";
import "./IntegrationKeyMemberPicker.css";

const AI_KEY_NAMES = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "PAPR_API_KEY"];
/** Sign-ins Connections manages itself: shown under Services, not here. */
const MANAGED = /^MCP_.+_OAUTH$/;

function useVaultPeople(orgId?: string | null) {
  const [organizations, setOrganizations] = useState<OrgScopeOption[]>([]);
  const [members, setMembers] = useState<WorkspaceMemberOption[]>([]);
  const [names, setNames] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    void (async () => {
      const r = await window.electronAPI?.papr?.listOrganizations?.();
      if (!r?.success || !r.organizations) return;
      setOrganizations(
        r.organizations
          .filter((o) => o.organizationId)
          .map((o) => ({ organizationId: o.organizationId!, label: o.workspaceName ?? o.name })),
      );
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const papr = window.electronAPI?.papr;
      const [profile, list] = await Promise.all([papr?.getProfile?.(), papr?.listWorkspaceMembers?.()]);
      if (!list?.success || !list.members) return;
      const me = profile?.success ? profile.profile?.userId?.trim().toLowerCase() : null;
      const map = new Map<string, string>();
      const opts: WorkspaceMemberOption[] = [];
      for (const m of list.members) {
        const id = m.user.objectId?.trim();
        if (!id) continue;
        const display = m.user.displayName?.trim() || m.user.email?.trim() || id;
        map.set(id.toLowerCase(), display);
        if (id.toLowerCase() !== me) opts.push({ userId: id, displayName: display, email: m.user.email, role: m.user.role });
      }
      setNames(map);
      setMembers(opts);
    })();
  }, [orgId]);

  return { organizations, members, names };
}

export function IntegrationKeysTab({ embedded = false }: { embedded?: boolean } = {}) {
  const { keys, vaultContext, loading, loadKeys } = useCustomKeys();
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<string | "new" | null>(null);
  const pulled = useRef(false);
  const people = useVaultPeople(vaultContext?.organizationId);

  useEffect(() => {
    if (pulled.current) return;
    pulled.current = true;
    void (async () => {
      setRefreshing(true);
      try {
        await pullSharedVaultKeys();
        await loadKeys(true);
      } finally {
        setRefreshing(false);
      }
    })();
  }, [loadKeys]);

  const list = useMemo(
    () =>
      keys
        .filter((k) => !AI_KEY_NAMES.includes(k.name) && !MANAGED.test(k.name))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [keys],
  );
  const q = query.trim().toLowerCase();
  const shown = q ? list.filter((k) => `${k.name} ${k.description ?? ""}`.toLowerCase().includes(q)) : list;

  const ownerName = (k: CustomKey) => {
    const id = k.sharedOwnerUserId?.trim().toLowerCase();
    return id ? people.names.get(id) ?? null : null;
  };

  const ctx: KeySheetContext = {
    organizations: people.organizations,
    activeOrgId: vaultContext?.organizationId,
    activeOrgLabel: vaultContext?.workspaceName,
    members: people.members,
    ownerName,
  };

  const line = (k: CustomKey) => {
    const parts: string[] = [];
    if (k.vaultOrigin === "shared") parts.push(`Shared by ${ownerName(k) ?? "a teammate"}`);
    parts.push(formatVaultAudienceLabel(k.vaultAudience ?? (k.vaultOrigin === "shared" ? k.sharedShareScope : "user")));
    if (k.orgScope === "all") parts.push("All my orgs");
    else if (k.organizationId && k.organizationId !== vaultContext?.organizationId) {
      parts.push(formatOrgScopeLabel({ orgScope: k.orgScope, organizationId: k.organizationId, organizations: people.organizations }));
    }
    if (k.clientAccess === "client") parts.push("Browser-safe");
    return parts.join(" · ");
  };

  const tag = (k: CustomKey) =>
    k.vaultShareBlocked && k.vaultOrigin !== "shared" ? "Not shared" : k.vaultSharedNameCollision ? "Duplicate name" : null;

  const current = open && open !== "new" ? keys.find((k) => k.id === open) ?? null : null;

  return (
    <div className="mcp-tab">
      <section className="svc-sec">
        <div className="svc-sec__h">
          <h3>{embedded ? "API keys" : "Key Vault"}</h3>
          <span>{list.length}</span>
          {refreshing && <span className="svc-sec__note" aria-live="polite">Refreshing shared keys…</span>}
          <span className="svc-sec__links">
            <button type="button" className="svc-btn" onClick={() => setOpen("new")}>
              + Add API key
            </button>
          </span>
        </div>

        {list.length > 6 && (
          <label className="svc-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input type="search" aria-label="Search keys" placeholder={`Search ${list.length} keys`} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}

        <div className="svc-list">
          {loading && !list.length ? (
            [0, 1, 2].map((i) => <div key={i} className="svc-row svc-row--skeleton" />)
          ) : shown.length ? (
            shown.map((k) => (
              <div
                key={k.id}
                className="svc-row svc-row--clickable"
                role="button"
                tabIndex={0}
                onClick={() => setOpen(k.id)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(k.id)}
              >
                <KeyMark />
                <div className="svc-row__text">
                  <b className="svc-row__name svc-row__name--key">{k.name}</b>
                  <span className="svc-st">{k.description ? `${k.description} · ${line(k)}` : line(k)}</span>
                </div>
                {tag(k) && <span className="svc-tag">{tag(k)}</span>}
                {k.vaultOrigin === "shared" && <span className="svc-tag">Read-only</span>}
                <Chevron />
              </div>
            ))
          ) : (
            <div className="svc-none">{q ? `No key matching "${query}".` : "No API keys yet."}</div>
          )}
        </div>
        <p className="svc-hint svc-hint--below">
          For jobs and app code you write yourself. If the service is under Services, connect it there instead: Pen can
          then limit what it does.
        </p>
      </section>

      {open && <KeySheet keyItem={current} ctx={ctx} onClose={() => setOpen(null)} />}
    </div>
  );
}

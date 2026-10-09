/**
 * McpServerSheet — detail panel for one MCP service.
 *
 * Connected: who can use the sign-in. It is a vault key (MCP_<ID>_OAUTH), so this
 * saves through the same updateKey + syncVaultKeyChange path as the API keys tab.
 * Needs setup: the service has no self-registration, so an admin creates a
 * one-time OAuth app; "Set up with Pen" opens a chat that walks them through it.
 */

import { useEffect, useMemo, useState } from "react";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import type { IntegrationKeyVaultAudience } from "../../constants/integrationKeyVaultAudience";
import { syncVaultKeyChange } from "../../utils/vaultPullShared";
import { IntegrationKeyVaultAudienceSelector } from "./IntegrationKeyVaultAudienceSelector";
import { IntegrationKeyMemberPicker, type WorkspaceMemberOption } from "./IntegrationKeyMemberPicker";
import "./McpServerSheet.css";

export interface McpSheetServer {
  id: string;
  name: string;
  description?: string;
  state: string;
  toolCount: number;
  requiresClientId: boolean;
}

/** Same naming as the gateway's mcpCredentialKeyName. */
export function mcpKeyName(serverId: string): string {
  return `MCP_${serverId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_OAUTH`;
}

export function setupWithPenPrompt(name: string): string {
  return [
    `Help me set up ${name} so my team can connect it to Papr.`,
    `${name} needs a one-time OAuth app. Walk me through creating it,`,
    `register the redirect URL https://apps.papr.ai/oauth/callback, pick the permissions,`,
    `and save the client ID and secret to our team's Key Vault.`,
    `If I'm not a ${name} admin, draft a message I can send to whoever is.`,
  ].join(" ");
}

function openSetupChat(name: string): void {
  // send/title are honoured once chat.open supports them (PR #317); older builds draft the message.
  window.dispatchEvent(
    new CustomEvent("papr-chat-open", {
      detail: { message: setupWithPenPrompt(name), send: true, title: `Set up ${name}` },
    }),
  );
}

function useWorkspaceMembers(): WorkspaceMemberOption[] {
  const [members, setMembers] = useState<WorkspaceMemberOption[]>([]);
  useEffect(() => {
    void (async () => {
      const papr = window.electronAPI?.papr;
      const [profile, list] = await Promise.all([papr?.getProfile?.(), papr?.listWorkspaceMembers?.()]);
      if (!list?.success || !list.members) return;
      const me = profile?.success ? profile.profile?.userId?.toLowerCase() : null;
      setMembers(
        list.members
          .filter((m) => m.user.objectId && m.user.objectId.toLowerCase() !== me)
          .map((m) => ({
            userId: m.user.objectId!,
            displayName: m.user.displayName?.trim() || m.user.email?.trim() || m.user.objectId!,
            email: m.user.email,
            role: m.user.role,
          })),
      );
    })();
  }, []);
  return members;
}

export interface McpConnectChoice {
  audience: IntegrationKeyVaultAudience;
  allowedUserIds?: string[];
}

/** Before connecting: pick who can use the sign-in, then Connect. Wider than "Only me" signs in through Papr cloud. */
function ConnectWithAudience({
  server,
  onConnect,
}: {
  server: McpSheetServer;
  onConnect: (choice: McpConnectChoice) => Promise<void> | void;
}) {
  const members = useWorkspaceMembers();
  const [audience, setAudience] = useState<IntegrationKeyVaultAudience>("user");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    if (audience === "members" && memberIds.length === 0) return setStatus("Pick at least one person.");
    setStatus(null);
    setBusy(true);
    try {
      await onConnect({ audience, ...(audience === "members" ? { allowedUserIds: memberIds } : {}) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-sheet__who">
      <IntegrationKeyVaultAudienceSelector idPrefix={`mcp-${server.id}-new-aud`} value={audience} onChange={setAudience} />
      {audience === "members" && (
        <IntegrationKeyMemberPicker
          idPrefix={`mcp-${server.id}-new-members`}
          members={members}
          selectedUserIds={memberIds}
          onChange={setMemberIds}
        />
      )}
      {audience !== "user" && (
        <p className="mcp-sheet__muted">
          They'll use your {server.name} sign-in, so Pen acts as you in {server.name} for them. Papr keeps it signed in
          even when your Mac is off.
        </p>
      )}
      <div className="mcp-sheet__row">
        {status && <span className="mcp-sheet__status">{status}</span>}
        <button type="button" className="settings-btn settings-btn--primary" disabled={busy} onClick={() => void connect()}>
          {busy ? "Opening…" : "Connect"}
        </button>
      </div>
    </div>
  );
}

/** Signed in through Papr cloud: the server owns the token, so sharing is chosen at sign-in. */
function useServerManaged(keyId: string | undefined, getKeyValue: (id: string) => Promise<string | null>): boolean {
  const [managed, setManaged] = useState(false);
  useEffect(() => {
    let live = true;
    if (!keyId) return setManaged(false);
    void getKeyValue(keyId)
      .then((v) => {
        if (!live) return;
        try {
          setManaged(Boolean(v && JSON.parse(v).serverRefresh === true));
        } catch {
          setManaged(false);
        }
      })
      .catch(() => live && setManaged(false));
    return () => {
      live = false;
    };
  }, [keyId, getKeyValue]);
  return managed;
}

function WhoCanUse({ server, onReconnect }: { server: McpSheetServer; onReconnect?: () => void }) {
  const { keys, updateKey, getKeyValue, loadKeys } = useCustomKeys();
  const key = useMemo(() => keys.find((k) => k.name === mcpKeyName(server.id)), [keys, server.id]);
  const members = useWorkspaceMembers();
  const serverManaged = useServerManaged(key?.id, getKeyValue);
  const [audience, setAudience] = useState<IntegrationKeyVaultAudience>(key?.vaultAudience ?? "user");
  const [memberIds, setMemberIds] = useState<string[]>(key?.vaultAudienceMemberIds ?? []);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setAudience(key?.vaultAudience ?? "user");
    setMemberIds(key?.vaultAudienceMemberIds ?? []);
  }, [key?.vaultAudience, key?.vaultAudienceMemberIds]);

  if (!key) return <p className="mcp-sheet__muted">This sign-in isn't in your vault yet.</p>;
  if (key.vaultOrigin === "shared") {
    return <p className="mcp-sheet__muted">Shared with you by a teammate. Only they can change who can use it.</p>;
  }
  if (serverManaged) {
    return (
      <div className="mcp-sheet__who">
        <p className="mcp-sheet__muted">
          Papr keeps this sign-in on its servers so it works when your Mac is off. To change who can use it, disconnect
          and connect again with a different choice.
        </p>
        {onReconnect && (
          <div className="mcp-sheet__row">
            <button type="button" className="settings-btn settings-btn--ghost" onClick={onReconnect}>
              Disconnect to change
            </button>
          </div>
        )}
      </div>
    );
  }

  const dirty =
    audience !== (key.vaultAudience ?? "user") ||
    (audience === "members" && memberIds.join() !== (key.vaultAudienceMemberIds ?? []).join());

  const save = async () => {
    if (audience === "members" && memberIds.length === 0) {
      setStatus("Pick at least one person.");
      return;
    }
    setStatus("Saving…");
    // Changing who can use a key re-writes it, so the value must travel with the update.
    const value = (await getKeyValue(key.id)) ?? "";
    const previousAudience = key.vaultAudience ?? "user";
    const ok = await updateKey(key.id, {
      name: key.name,
      value,
      vaultAudience: audience,
      vaultAudienceMemberIds: audience === "members" ? memberIds : [],
    });
    if (!ok) return setStatus("Couldn't save. Try again.");
    const res = await syncVaultKeyChange({ name: key.name, previousAudience, nextAudience: audience, mode: "update" });
    await loadKeys(true);
    setStatus(res.success ? "Saved." : `Saved on this Mac. Sync failed: ${res.error ?? "unknown error"}`);
  };

  return (
    <div className="mcp-sheet__who">
      <IntegrationKeyVaultAudienceSelector idPrefix={`mcp-${server.id}-aud`} value={audience} onChange={setAudience} />
      {audience === "members" && (
        <IntegrationKeyMemberPicker
          idPrefix={`mcp-${server.id}-members`}
          members={members}
          selectedUserIds={memberIds}
          onChange={setMemberIds}
        />
      )}
      {audience !== "user" && (
        <p className="mcp-sheet__muted">
          They use your {server.name} sign-in, so Pen acts as you in {server.name} for them.
        </p>
      )}
      <div className="mcp-sheet__row">
        {status && <span className="mcp-sheet__status">{status}</span>}
        <button type="button" className="settings-btn settings-btn--primary" disabled={!dirty} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}

const PEN_OPTIONS: { v: "read" | "ask" | "full"; label: string; hint: string }[] = [
  { v: "read", label: "Read only", hint: "Looks things up. Never changes anything." },
  { v: "ask", label: "Ask before changes", hint: "Reads freely. Asks you before it creates, edits or sends." },
  { v: "full", label: "Full access", hint: "Works without asking. Deleting still asks." },
];
const PEN_RANK = { read: 0, ask: 1, full: 2 } as const;

/** What Pen may do with this service. Options above the org's maximum are disabled. */
export function PenAccessPicker({ server, orgMax }: { server: McpSheetServer; orgMax?: "read" | "ask" | "full" }) {
  const { keys, updateKey, getKeyValue, loadKeys } = useCustomKeys();
  const key = keys.find((k) => k.name === mcpKeyName(server.id));
  if (!key) return null;
  const shared = key.vaultOrigin === "shared";
  const max = orgMax ?? "full";
  const raw = key.penAccess ?? "ask";
  const cur = PEN_RANK[raw] > PEN_RANK[max] ? max : raw;
  const pick = async (v: "read" | "ask" | "full") => {
    if (shared || v === cur) return;
    const value = (await getKeyValue(key.id)) ?? "";
    if (await updateKey(key.id, { name: key.name, value, penAccess: v })) {
      await syncVaultKeyChange({ name: key.name, previousAudience: key.vaultAudience ?? "user", nextAudience: key.vaultAudience ?? "user", mode: "update" });
      await loadKeys(true);
    }
  };
  return (
    <div className="mcp-sheet__pen" role="radiogroup" aria-label="What Pen may do">
      {PEN_OPTIONS.map((o) => {
        const over = PEN_RANK[o.v] > PEN_RANK[max];
        return (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={cur === o.v}
            className={`mcp-sheet__penopt${cur === o.v ? " is-on" : ""}`}
            disabled={shared || over}
            onClick={() => void pick(o.v)}
          >
            <b>{o.label}</b>
            <span>{over ? "Not allowed by your org" : o.hint}</span>
          </button>
        );
      })}
      {shared && <p className="mcp-sheet__muted">Set by the teammate who shared it.</p>}
    </div>
  );
}

export function McpServerSheet({
  server,
  onClose,
  onDisconnect,
  onConnect,
  orgMax,
}: {
  server: McpSheetServer;
  onClose: () => void;
  onDisconnect: () => void;
  /** Start sign-in with a sharing choice. Omitted: the panel only explains. */
  onConnect?: (choice: McpConnectChoice) => Promise<void> | void;
  /** Org's maxPenAccess; higher options are shown but disabled. */
  orgMax?: "read" | "ask" | "full";
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const connected = server.state === "connected";
  return (
    <div className="mcp-sheet__scrim" onClick={onClose}>
      <aside
        className="mcp-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={server.name}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mcp-sheet__head">
          <div>
            <h3 className="mcp-sheet__title">{server.name}</h3>
            <p className="mcp-sheet__muted">
              {server.requiresClientId
                ? "Needs a one-time setup"
                : connected
                  ? `Connected · ${server.toolCount} tools`
                  : server.description}
            </p>
          </div>
          <button type="button" className="mcp-sheet__close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        {server.requiresClientId ? (
          <section className="mcp-sheet__section">
            <h4>Needs setup</h4>
            <p>
              {server.name} doesn't let apps register themselves, so someone who manages {server.name} for your team
              creates a one-time OAuth app. That's whoever manages {server.name}, not necessarily your Papr admin. The
              client ID and secret stay in your team's Key Vault, so after that everyone connects with one click.
            </p>
            <button type="button" className="settings-btn settings-btn--primary" onClick={() => openSetupChat(server.name)}>
              Set up with Pen
            </button>
          </section>
        ) : connected ? (
          <>
            <section className="mcp-sheet__section">
              <h4>Who can use it</h4>
              <WhoCanUse server={server} onReconnect={onDisconnect} />
            </section>
            <section className="mcp-sheet__section">
              <h4>What Pen may do</h4>
              <PenAccessPicker server={server} orgMax={orgMax} />
            </section>
            <section className="mcp-sheet__section">
              <button type="button" className="settings-btn settings-btn--ghost" onClick={onDisconnect}>
                Disconnect
              </button>
            </section>
          </>
        ) : onConnect ? (
          <section className="mcp-sheet__section">
            <h4>Who can use it</h4>
            <ConnectWithAudience server={server} onConnect={onConnect} />
          </section>
        ) : (
          <p className="mcp-sheet__muted">Connect {server.name} to choose who can use it.</p>
        )}
      </aside>
    </div>
  );
}

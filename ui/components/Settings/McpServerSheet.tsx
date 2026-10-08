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

function WhoCanUse({ server }: { server: McpSheetServer }) {
  const { keys, updateKey, getKeyValue, loadKeys } = useCustomKeys();
  const key = useMemo(() => keys.find((k) => k.name === mcpKeyName(server.id)), [keys, server.id]);
  const members = useWorkspaceMembers();
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

export function McpServerSheet({
  server,
  onClose,
  onDisconnect,
}: {
  server: McpSheetServer;
  onClose: () => void;
  onDisconnect: () => void;
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
              <WhoCanUse server={server} />
            </section>
            <section className="mcp-sheet__section">
              <button type="button" className="settings-btn settings-btn--ghost" onClick={onDisconnect}>
                Disconnect
              </button>
            </section>
          </>
        ) : (
          <p className="mcp-sheet__muted">Connect {server.name} to choose who can use it.</p>
        )}
      </aside>
    </div>
  );
}

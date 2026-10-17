/**
 * Key Request Card — inline card when the agent asks for an API key.
 * Looks like the rail's org peek (glass card, uppercase group labels, org rows) and saves the key
 * into the requesting chat's scope: active org + the chat's audience (Only me / Team / Organization).
 */

import { useMemo, useState } from "react";
import { useChatStore } from "../../stores/chatStore";
import { useProfileStore } from "../../stores/profileStore";
import { OrgMark } from "../Sidebar/OrgMark";
import { defaultOrgSite, orgLogoSrc, useOrgLogos } from "../Sidebar/orgLogoStore";
import { useOrgList } from "../Sidebar/useOrgList";
import { VAULT_AUDIENCE_LABELS } from "../../constants/integrationKeyVaultAudience";
import type { IntegrationKeyVaultAudience } from "../../types/settings";
import "../Sidebar/Sidebar.css";
import "../Sidebar/ProfileFooter.css";
import "./KeyRequestCard.css";

export interface KeyRequestData {
  type: "key_request";
  name: string;
  description: string;
  sourceUrl?: string;
  requiredScopes?: string[];
  suggestedPermission: "always" | "ask";
  status: "awaiting_user_input" | "submitted" | "cancelled";
  message: string;
}

export type KeyAudience = Extract<IntegrationKeyVaultAudience, "user" | "namespace" | "org">;

export interface KeySubmitScope {
  vaultAudience: KeyAudience;
  orgScope: "organization";
  organizationId?: string;
}

interface Props {
  data: KeyRequestData;
  chatId?: string;
  onSubmit: (keyName: string, keyValue: string, permission: "always" | "ask", scope: KeySubmitScope) => void | Promise<void>;
  onCancel: () => void;
}

const AUDIENCES: KeyAudience[] = ["user", "namespace", "org"];

/** JSON-looking values must parse; multi-line values (PEM, JSON) keep their newlines. */
export function checkKeyValue(raw: string): { value: string; error?: string; kind?: string } {
  const value = raw.trim();
  if (!value.startsWith("{") && !value.startsWith("[")) return { value };
  try {
    const parsed = JSON.parse(value);
    return { value, kind: parsed?.type === "service_account" ? `Service account · ${parsed.client_email ?? ""}` : "Valid JSON" };
  } catch (e) {
    return { value, error: `Not valid JSON: ${(e as Error).message}` };
  }
}

export function KeyRequestCard({ data, chatId, onSubmit, onCancel }: Props) {
  const chatScope = useChatStore((s) => (chatId ? s.getChatMemoryScope(chatId) : "user"));
  const [audience, setAudience] = useState<KeyAudience>(chatScope);
  const [raw, setRaw] = useState("");
  const [permission, setPermission] = useState(data.suggestedPermission);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [status, setStatus] = useState(data.status);

  const { orgs, activeId } = useOrgList();
  const branding = useOrgLogos((s) => s.branding);
  const { organizationName, workspaceName, email } = useProfileStore();
  const org = orgs.find((o) => o.id === activeId);
  const orgName = org?.name || organizationName || workspaceName || "This org";
  const orgLogo = org ? orgLogoSrc(branding[org.id], branding[org.id]?.site ?? defaultOrgSite([org.name, org.organizationName], email))
    : orgLogoSrc(undefined, defaultOrgSite([organizationName, workspaceName], email));

  const check = useMemo(() => checkKeyValue(raw), [raw]);
  const multiline = raw.includes("\n") || check.kind !== undefined || check.error !== undefined;
  const canSave = !!check.value && !check.error && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setFailed(null);
    try {
      await onSubmit(data.name, check.value, permission, { vaultAudience: audience, orgScope: "organization", organizationId: org?.id });
      setRaw("");
      setStatus("submitted");
    } catch (e) {
      setFailed((e as Error)?.message || "Could not save the key");
    } finally {
      setBusy(false);
    }
  };

  if (status !== "awaiting_user_input") {
    const ok = status === "submitted";
    return (
      <div className="rail-scope key-card key-card--done">
        <OrgMark name={orgName} src={orgLogo} className="key-card__mark" />
        <span><b>{data.name}</b> {ok ? `saved · ${orgName} · ${VAULT_AUDIENCE_LABELS[audience].label}` : "not added — add it later in Settings → API Keys"}</span>
      </div>
    );
  }

  return (
    <div className="rail-scope key-card">
      <div className="rail-peek__header key-card__header">
        <b>{data.name}</b>
        <span>API key</span>
      </div>
      {data.description && <p className="key-card__desc">{data.description}</p>}
      {data.sourceUrl && (
        <a className="key-card__link" href={`https://${data.sourceUrl.replace(/^https?:\/\//, "")}`} target="_blank" rel="noopener noreferrer">
          Get it from {data.sourceUrl}
        </a>
      )}

      <div className="rail-peek__group">
        <h6>Value</h6>
        {multiline ? (
          <textarea className="key-card__input key-card__input--area" value={raw} spellCheck={false} autoFocus
            onChange={(e) => setRaw(e.target.value)} disabled={busy} aria-label={`${data.name} value`} />
        ) : (
          <input className="key-card__input" type="password" value={raw} placeholder="Paste key" spellCheck={false} autoFocus
            autoComplete="off" onChange={(e) => setRaw(e.target.value)} disabled={busy} aria-label={`${data.name} value`}
            onPaste={(e) => { const t = e.clipboardData.getData("text"); if (t.includes("\n")) { e.preventDefault(); setRaw(t); } }}
            onKeyDown={(e) => e.key === "Enter" && save()} />
        )}
        {(check.error || check.kind) && <small className={`key-card__hint${check.error ? " is-error" : ""}`}>{check.error ?? check.kind}</small>}
      </div>

      <div className="rail-peek__group">
        <h6>Save to</h6>
        <div className="rail-orgs">
          {AUDIENCES.map((a) => (
            <button key={a} type="button" className={`rail-org${a === audience ? " is-active" : ""}`} onClick={() => setAudience(a)} disabled={busy}>
              <OrgMark name={orgName} src={orgLogo} />
              <span className="rail-org__name">
                <b>{a === "user" ? "Only me" : a === "namespace" ? "Team" : orgName}</b>{" "}
                <small>{a === chatScope ? "· this chat" : a === "org" ? "· everyone in org" : ""}</small>
              </span>
              {a === audience && <span className="key-card__check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      </div>

      <label className="key-card__ask">
        <input type="checkbox" checked={permission === "ask"} onChange={(e) => setPermission(e.target.checked ? "ask" : "always")} disabled={busy} />
        Ask before each use
      </label>

      {failed && <small className="key-card__hint is-error">{failed}</small>}
      <div className="key-card__actions">
        <button type="button" className="key-card__btn" onClick={() => { setStatus("cancelled"); onCancel(); }} disabled={busy}>Not now</button>
        <button type="button" className="key-card__btn key-card__btn--primary" onClick={save} disabled={!canSave}>{busy ? "Saving…" : "Save key"}</button>
      </div>
    </div>
  );
}

/** Parse key request data from a request_key tool result. */
export function parseKeyRequestFromToolResult(toolName: string, result: string | unknown): KeyRequestData | null {
  if (toolName !== "request_key") return null;
  try {
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    const data = (parsed as { data?: Record<string, unknown> }).data || (parsed as Record<string, unknown>);
    if (data.type !== "key_request") return null;
    return {
      type: "key_request",
      name: String(data.name),
      description: String(data.description ?? ""),
      sourceUrl: data.sourceUrl as string | undefined,
      requiredScopes: data.requiredScopes as string[] | undefined,
      suggestedPermission: (data.suggestedPermission as "always" | "ask") || "ask",
      status: (data.status as KeyRequestData["status"]) || "awaiting_user_input",
      message: String(data.message || `Waiting for user to provide ${data.name}...`),
    };
  } catch {
    return null;
  }
}

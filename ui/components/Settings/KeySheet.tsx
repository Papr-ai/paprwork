/**
 * API key detail panel (Connections → API keys). Same modal and the same
 * "Who can use it" rows as a service; a key only adds Browser access.
 * New key: name + value + access. Teammate's shared key: read-only, value
 * can be revealed, and it can be removed from this device.
 */

import { useEffect, useState } from "react";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import type { CustomKey, CustomKeyInput } from "../../types/settings";
import {
  VAULT_AUDIENCE_LABELS,
  type IntegrationKeyVaultAudience,
} from "../../constants/integrationKeyVaultAudience";
import { syncVaultKeyChange } from "../../utils/vaultPullShared";
import { IntegrationKeyMemberPicker, type WorkspaceMemberOption } from "./IntegrationKeyMemberPicker";
import {
  orgScopeValueFromKey,
  toOrgScopeInput,
  type IntegrationKeyOrgScopeValue,
  type OrgScopeOption,
} from "./IntegrationKeyOrgScopeSelector";
import { AccessCard, AccessRow, AccessSelect, Btn, Fine, KeyMark, Pills, Sheet } from "./ConnectionsUi";

export interface KeySheetContext {
  organizations: OrgScopeOption[];
  activeOrgId?: string | null;
  activeOrgLabel?: string | null;
  members: WorkspaceMemberOption[];
  ownerName: (key: CustomKey) => string | null;
}

const AUDIENCES: IntegrationKeyVaultAudience[] = ["user", "members", "namespace", "org"];
const USE = [
  { value: "ask" as const, label: "Ask each time", hint: "You approve every use" },
  { value: "always" as const, label: "Always allow", hint: "Jobs and automations use it without asking" },
];
const EXPOSE = [
  { value: "server" as const, label: "Server only", hint: "Used in jobs, bash and app backends. Never sent to app code in the browser" },
  { value: "client" as const, label: "Browser-safe", hint: "Publishable keys only. Can be bundled into mini-app code" },
];

const hintOf = <T extends string>(opts: Array<{ value: T; hint: string }>, v: T) => opts.find((o) => o.value === v)?.hint;

async function syncWithAlerts(input: Parameters<typeof syncVaultKeyChange>[0], owner: (id?: string) => string) {
  const res = await syncVaultKeyChange(input);
  if (!res.success) return `Saved on this Mac. Sync failed: ${res.error ?? "unknown error"}`;
  const clash = res.conflicts?.find((c) => c.name.toUpperCase() === input.name.toUpperCase());
  if (clash) return `Not shared: ${input.name} already exists in the cloud vault (${owner(clash.ownerUserId)}). Your key still works on this Mac.`;
  return null;
}

export function KeySheet({ keyItem, ctx, onClose }: { keyItem: CustomKey | null; ctx: KeySheetContext; onClose: () => void }) {
  const { keys, addKey, updateKey, deleteKey, getKeyValue, loadKeys } = useCustomKeys();
  const isNew = !keyItem;
  const shared = keyItem?.vaultOrigin === "shared";
  const owner = keyItem && shared ? ctx.ownerName(keyItem) : null;

  const [name, setName] = useState(keyItem?.name ?? "");
  const [desc, setDesc] = useState(keyItem?.description ?? "");
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [audience, setAudience] = useState<IntegrationKeyVaultAudience>(keyItem?.vaultAudience ?? "user");
  const [memberIds, setMemberIds] = useState<string[]>(keyItem?.vaultAudienceMemberIds ?? []);
  const [scope, setScope] = useState<IntegrationKeyOrgScopeValue>(() =>
    keyItem
      ? orgScopeValueFromKey({ orgScope: keyItem.orgScope, organizationId: keyItem.organizationId, activeOrganizationId: ctx.activeOrgId })
      : { mode: "all" },
  );
  const [use, setUse] = useState<"always" | "ask">(keyItem?.permission ?? "ask");
  const [expose, setExpose] = useState<"server" | "client">((keyItem?.clientAccess ?? "server") as "server" | "client");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A shared key shows its value read-only; reveal loads it on demand.
  useEffect(() => {
    if (!shared || !show || value || !keyItem) return;
    void getKeyValue(keyItem.id).then((v) => setValue(v ?? ""));
  }, [shared, show, value, keyItem, getKeyValue]);

  const ownerOf = (id?: string) => {
    const k = keys.find((x) => x.sharedOwnerUserId?.toLowerCase() === id?.toLowerCase());
    return (k && ctx.ownerName(k)) || id || "a teammate";
  };

  const save = async () => {
    if (isNew && (!name || !value)) return setStatus("Add a name and the key.");
    if (audience === "members" && memberIds.length === 0) return setStatus("Pick at least one person.");
    if (isNew && keys.some((k) => k.name.toUpperCase() === name.toUpperCase() && k.vaultOrigin === "shared")) {
      return setStatus(`${name} is already shared with you by a teammate.`);
    }
    setBusy(true);
    setStatus(null);
    try {
      const scopeInput = toOrgScopeInput(scope);
      const fields: Partial<CustomKeyInput> = {
        name,
        description: desc,
        permission: use,
        clientAccess: expose,
        vaultAudience: audience,
        vaultAudienceMemberIds: audience === "members" ? memberIds : [],
        ...scopeInput,
      };
      if (isNew) {
        if (!(await addKey({ ...fields, name, value } as CustomKeyInput))) return setStatus("Couldn't save. Try again.");
      } else {
        const moved =
          keyItem.orgScope !== scopeInput.orgScope ||
          keyItem.organizationId !== scopeInput.organizationId ||
          (keyItem.vaultAudience ?? "user") !== audience;
        // Moving a key between vaults re-writes it, so the value has to travel along.
        const v = value.trim() || (moved ? ((await getKeyValue(keyItem.id)) ?? "") : "");
        if (!(await updateKey(keyItem.id, v ? { ...fields, value: v } : fields))) return setStatus("Couldn't save. Try again.");
      }
      const warn = await syncWithAlerts(
        { name, previousAudience: keyItem?.vaultAudience ?? "user", nextAudience: audience, targetOrgId: scopeInput.organizationId, mode: "update" },
        ownerOf,
      );
      await loadKeys(true);
      if (warn) return setStatus(warn);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!keyItem) return;
    const msg = shared
      ? `Remove ${keyItem.name} from this Mac? The shared key stays in your team's vault.`
      : `Delete ${keyItem.name}? This also removes it from the cloud vault for anyone it's shared with.`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      if (!shared) {
        const warn = await syncWithAlerts(
          { name: keyItem.name, previousAudience: keyItem.vaultAudience ?? "user", mode: "delete", targetOrgId: keyItem.organizationId },
          ownerOf,
        );
        if (warn?.startsWith("Saved on this Mac")) return setStatus(warn.replace("Saved on this Mac. ", ""));
      }
      await deleteKey(keyItem.id);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const lock = shared;
  const orgLabel = ctx.activeOrgLabel?.trim() || "This organization";
  const otherOrgs = ctx.organizations.filter((o) => o.organizationId !== ctx.activeOrgId);
  const audOpts = AUDIENCES.map((a) => ({ value: a, label: VAULT_AUDIENCE_LABELS[a].label }));
  const scopeOpts = [
    { value: "current" as const, label: `${orgLabel} only`, disabled: !ctx.activeOrgId },
    { value: "all" as const, label: "All my orgs" },
    ...otherOrgs.map((o) => ({ value: `org:${o.organizationId}` as const, label: `${o.label} only` })),
  ];
  const scopeVal = scope.mode === "specific" ? `org:${scope.organizationId}` : scope.mode;
  const scopeHint =
    scope.mode === "all" ? "Every organization you belong to" : scope.mode === "current" ? `Only in ${orgLabel}` : "One other organization";

  return (
    <Sheet
      label={keyItem?.name ?? "Add API key"}
      mark={<KeyMark size="lg" />}
      title={
        isNew ? (
          <input
            className="cx-in"
            aria-label="Key name"
            placeholder="KEY_NAME"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
          />
        ) : (
          <span>{keyItem.name}</span>
        )
      }
      subtitle={!isNew && keyItem.description ? keyItem.description : undefined}
      onClose={onClose}
      footer={
        lock ? (
          <>
            <span className="cx-grow">Managed by {owner ?? "a teammate"}</span>
            <Btn disabled={busy} onClick={() => void remove()}>Remove from this Mac</Btn>
          </>
        ) : (
          <>
            {!isNew && <Btn kind="danger" disabled={busy} onClick={() => void remove()}>Delete</Btn>}
            {status && <span className="cx-grow" role="status">{status}</span>}
            <div className="cx-fbtns">
              <Btn onClick={onClose}>Cancel</Btn>
              <Btn kind="primary" disabled={busy || (isNew && (!name || !value))} onClick={() => void save()}>
                {busy ? "Saving…" : "Save"}
              </Btn>
            </div>
          </>
        )
      }
    >
      <Pills items={[["plain", "API key"], shared && ["team", `Shared by ${owner ?? "a teammate"}`]]} />
      <p className="cx-p" style={{ marginTop: 10 }}>
        Pen hands this value to jobs and app backends. It can't see what a script does with it, so only "who can use it"
        applies here.
      </p>

      {isNew && (
        <>
          <h4>Description</h4>
          <input className="cx-in" aria-label="Description" placeholder="Optional. What is it for?" value={desc} onChange={(e) => setDesc(e.target.value)} />
        </>
      )}

      <h4>Value</h4>
      <div className="cx-row2">
        <input
          className="cx-in cx-mono"
          aria-label="Value"
          type={show ? "text" : "password"}
          readOnly={lock}
          placeholder={lock ? "••••••••••••" : isNew ? "Paste the key" : "Enter a new value (leave empty to keep the current one)"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Btn onClick={() => setShow((s) => !s)}>{show ? "Hide" : "Show"}</Btn>
      </div>

      <h4>Who can use it</h4>
      <AccessCard>
        <AccessRow label="Shared with" hint={VAULT_AUDIENCE_LABELS[audience].hint}>
          <AccessSelect label="Shared with" value={audience} options={audOpts} onChange={setAudience} disabled={lock} />
        </AccessRow>
        {audience === "members" && !lock && (
          <IntegrationKeyMemberPicker idPrefix={`key-${keyItem?.id ?? "new"}-members`} members={ctx.members} selectedUserIds={memberIds} onChange={setMemberIds} />
        )}
        <AccessRow label="Available in" hint={scopeHint}>
          <AccessSelect
            label="Available in"
            value={scopeVal}
            options={scopeOpts}
            disabled={lock}
            onChange={(v) =>
              setScope(
                v === "all" ? { mode: "all" } : v === "current" ? { mode: "current", organizationId: ctx.activeOrgId ?? undefined } : { mode: "specific", organizationId: v.slice(4) },
              )
            }
          />
        </AccessRow>
        <AccessRow label="Jobs and automations" hint={hintOf(USE, use)}>
          <AccessSelect label="Jobs and automations" value={use} options={USE} onChange={setUse} disabled={lock} />
        </AccessRow>
        <AccessRow label="Browser access" hint={hintOf(EXPOSE, expose)}>
          <AccessSelect label="Browser access" value={expose} options={EXPOSE} onChange={setExpose} disabled={lock} />
        </AccessRow>
      </AccessCard>
      {lock && <p className="cx-p" style={{ marginTop: 10 }}>Only {owner ?? "the teammate who shared it"} can change its value or who can use it.</p>}

      <Fine>Stored in {shared ? "your team's cloud vault" : "your Mac's keychain and your cloud vault"}.</Fine>
    </Sheet>
  );
}

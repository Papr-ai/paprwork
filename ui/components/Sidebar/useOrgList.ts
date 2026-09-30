/**
 * useOrgList — the orgs you belong to (for the account card's org list) plus a switch action
 * that runs the same flow as Settings → Organization (confirm, overlay, IPC, abort on failure).
 */
import { useCallback, useEffect, useState } from "react";
import { buildWorkspaceUiCacheKey } from "../../lib/workspaceUiCache";
import {
  abortWorkspaceSwitchReload,
  prepareWorkspaceSwitchReload,
} from "../../lib/workspaceSwitchReload";
import { confirmAndAbortStreamsForWorkspaceSwitch } from "../../lib/workspaceSwitchStreaming";

export interface OrgEntry {
  id: string;
  name: string;
  /** owner | admin | member — admins may change the org logo. */
  role?: string;
  organizationId?: string;
  organizationName?: string;
  defaultNamespaceId?: string;
}

const REFRESH_EVENTS = [
  "papr-auth-success",
  "papr-logout-success",
  "papr-organization-changed",
  "papr-namespace-changed",
  "papr-workspace-switch-complete",
];

export function useOrgList() {
  const [orgs, setOrgs] = useState<OrgEntry[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [switching, setSwitching] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await window.electronAPI.papr.listOrganizations();
      if (result.success) {
        setOrgs(result.organizations ?? []);
        setActiveId(result.activeOrganizationId ?? "");
      }
    } catch {
      // Logged out or offline — the list simply stays empty.
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => void load();
    REFRESH_EVENTS.forEach((e) => window.addEventListener(e, refresh));
    return () => REFRESH_EVENTS.forEach((e) => window.removeEventListener(e, refresh));
  }, [load]);

  const switchTo = useCallback(
    async (id: string) => {
      const org = orgs.find((o) => o.id === id);
      if (!org || id === activeId || switching) return;
      if (!(await confirmAndAbortStreamsForWorkspaceSwitch())) return;
      setSwitching(true);
      try {
        const targetWorkspaceKey =
          org.organizationId && org.defaultNamespaceId
            ? buildWorkspaceUiCacheKey(org.organizationId, org.defaultNamespaceId)
            : undefined;
        await prepareWorkspaceSwitchReload({
          organizationName: org.name,
          ...(targetWorkspaceKey ? { targetWorkspaceKey } : {}),
        });
        const result = await window.electronAPI.papr.switchOrganization(id, org.name);
        if (result.success) setActiveId(id);
        else abortWorkspaceSwitchReload();
      } catch {
        abortWorkspaceSwitchReload();
      } finally {
        setSwitching(false);
      }
    },
    [orgs, activeId, switching],
  );

  return { orgs, activeId, switching, switchTo };
}

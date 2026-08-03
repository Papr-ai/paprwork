/**
 * Profile Store - User profile + Papr workspace context for sidebar and chat
 */

import { create } from "zustand";
import { gateway } from "../src/lib/gateway";
import { isWorkspaceSwitchReloading } from "../lib/workspaceSwitchReload";
import {
  clearProfileSidebarCache,
  readProfileSidebarCache,
  writeProfileSidebarCache,
} from "../utils/profileSidebarCache";

interface ProfileState {
  name: string;
  email: string;
  imageUrl: string;
  plan: string;
  organizationName: string;
  namespaceName: string;
  workspaceName: string;
  loaded: boolean;
  loadProfile: (options?: { force?: boolean }) => Promise<void>;
  setProfile: (profile: {
    name?: string;
    email?: string;
    imageUrl?: string;
    plan?: string;
    organizationName?: string;
    namespaceName?: string;
    workspaceName?: string;
  }) => void;
}

const cached = readProfileSidebarCache();

let refreshInFlight: Promise<void> | null = null;

function persistProfileSnapshot(state: {
  name: string;
  email: string;
  imageUrl: string;
  plan: string;
  organizationName: string;
  namespaceName: string;
  workspaceName: string;
}): void {
  writeProfileSidebarCache(state);
}

async function fetchProfileContext(): Promise<{
  name: string;
  email: string;
  imageUrl: string;
  plan: string;
  organizationName: string;
  namespaceName: string;
  workspaceName: string;
}> {
  const cached = readProfileSidebarCache();
  if (isWorkspaceSwitchReloading() && cached) {
    return {
      name: cached.name,
      email: cached.email,
      imageUrl: cached.imageUrl,
      plan: cached.plan,
      organizationName: cached.organizationName,
      namespaceName: cached.namespaceName,
      workspaceName: cached.workspaceName,
    };
  }

  const settingsResponse = await gateway.send("settings:get");
  const settingsData = settingsResponse.data as {
    profile?: {
      name?: string;
      email?: string;
      imageUrl?: string;
    };
  };

  let name = settingsData?.profile?.name ?? "";
  let email = settingsData?.profile?.email ?? "";
  let imageUrl = settingsData?.profile?.imageUrl ?? "";
  let plan = "";
  let organizationName = "";
  let namespaceName = "";
  let workspaceName = "";

  const loginStatus = await window.electronAPI.papr.checkLoginStatus();
  if (!loginStatus.success || !loginStatus.isLoggedIn) {
    return { name, email, imageUrl, plan, organizationName, namespaceName, workspaceName };
  }

  const [paprProfileResult, planResult, orgsResult] = await Promise.all([
    (async () => {
      const refreshResult = await window.electronAPI.papr.refreshProfile();
      if (refreshResult.success && refreshResult.profile) {
        return { success: true, profile: refreshResult.profile };
      }
      return window.electronAPI.papr.getProfile();
    })(),
    window.electronAPI.papr.getPlanSummary(),
    window.electronAPI.papr.listOrganizations(),
  ]);

  if (paprProfileResult.success && paprProfileResult.profile) {
    const paprProfile = paprProfileResult.profile;
    if (!name) name = paprProfile.displayName?.trim() || "";
    if (!email) email = paprProfile.email || "";
    const cloudImage = paprProfile.profileImage?.trim();
    if (cloudImage) {
      imageUrl = cloudImage;
    } else if (!imageUrl) {
      imageUrl = "";
    }
    namespaceName = paprProfile.activeNamespaceName?.trim() || namespaceName;
    workspaceName = paprProfile.workspaceName?.trim() || workspaceName;
  }

  if (planResult.success && planResult.summary?.planName) {
    plan = planResult.summary.planName;
  }

  if (orgsResult.success && orgsResult.organizations?.length) {
    const activeOrg =
      orgsResult.organizations.find(
        (org) => org.id === orgsResult.activeOrganizationId,
      ) ?? orgsResult.organizations[0];
    organizationName =
      activeOrg.organizationName?.trim() ||
      activeOrg.workspaceName?.trim() ||
      activeOrg.name?.trim() ||
      organizationName;
    workspaceName =
      activeOrg.workspaceName?.trim() || activeOrg.name?.trim() || workspaceName;

    const parseOrgId = activeOrg.organizationId;
    if (parseOrgId && !namespaceName) {
      const namespacesResult = await window.electronAPI.papr.listNamespaces({
        organizationId: parseOrgId,
        peek: true,
      });
      if (namespacesResult.success && namespacesResult.namespaces?.length) {
        const activeNs =
          namespacesResult.namespaces.find(
            (ns) => ns.id === namespacesResult.activeNamespaceId,
          ) ?? namespacesResult.namespaces[0];
        namespaceName = activeNs.name?.trim() || namespaceName;
      }
    }
  }

  return { name, email, imageUrl, plan, organizationName, namespaceName, workspaceName };
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  name: cached?.name ?? "",
  email: cached?.email ?? "",
  imageUrl: cached?.imageUrl ?? "",
  plan: cached?.plan ?? "",
  organizationName: cached?.organizationName ?? "",
  namespaceName: cached?.namespaceName ?? "",
  workspaceName: cached?.workspaceName ?? "",
  loaded: false,

  loadProfile: async (options) => {
    const force = options?.force === true;
    if (!force && get().loaded) return;
    if (refreshInFlight) {
      await refreshInFlight;
      if (!force) return;
    }

    refreshInFlight = (async () => {
      try {
        const snapshot = await fetchProfileContext();
        set({ ...snapshot, loaded: true });
        persistProfileSnapshot(snapshot);
      } catch (err) {
        console.error("[ProfileStore] Load error:", err);
        set({ loaded: true });
      } finally {
        refreshInFlight = null;
      }
    })();

    await refreshInFlight;
  },

  setProfile: (profile) => {
    const next = {
      name: profile.name ?? get().name,
      email: profile.email ?? get().email,
      imageUrl: profile.imageUrl ?? get().imageUrl,
      plan: profile.plan ?? get().plan,
      organizationName: profile.organizationName ?? get().organizationName,
      namespaceName: profile.namespaceName ?? get().namespaceName,
      workspaceName: profile.workspaceName ?? get().workspaceName,
    };
    set(next);
    persistProfileSnapshot(next);
  },
}));

export function clearCachedProfileContext(): void {
  clearProfileSidebarCache();
  useProfileStore.setState({
    plan: "",
    organizationName: "",
    namespaceName: "",
    workspaceName: "",
  });
}

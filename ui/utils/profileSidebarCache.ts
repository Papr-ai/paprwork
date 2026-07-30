/**
 * Instant sidebar profile context — hydrated from localStorage, refreshed from Papr APIs.
 */

const CACHE_KEY = "papr-profile-sidebar-cache";

export interface ProfileSidebarCache {
  name: string;
  email: string;
  imageUrl: string;
  plan: string;
  organizationName: string;
  namespaceName: string;
  workspaceName: string;
  updatedAt: string;
}

export function readProfileSidebarCache(): ProfileSidebarCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ProfileSidebarCache>;
    if (typeof parsed.updatedAt !== "string") return null;
    return {
      name: parsed.name ?? "",
      email: parsed.email ?? "",
      imageUrl: parsed.imageUrl ?? "",
      plan: parsed.plan ?? "",
      organizationName: parsed.organizationName ?? "",
      namespaceName: parsed.namespaceName ?? "",
      workspaceName: parsed.workspaceName ?? "",
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

export function writeProfileSidebarCache(cache: Omit<ProfileSidebarCache, "updatedAt">): void {
  try {
    // Avoid localStorage quota errors from large base64 avatars.
    const imageUrl =
      cache.imageUrl.startsWith("data:") && cache.imageUrl.length > 120_000
        ? ""
        : cache.imageUrl;
    const next: ProfileSidebarCache = {
      ...cache,
      imageUrl,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    // Ignore quota / private mode errors
  }
}

export function clearProfileSidebarCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // Ignore
  }
}

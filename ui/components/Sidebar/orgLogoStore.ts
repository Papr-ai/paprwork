/**
 * Org logo — every org is recognised by its logo, worn as a badge on your rail avatar.
 *
 * Source order: an admin's upload → the org website's icon (Google's favicon service, no key) → a monogram.
 * The website defaults to your email domain when it matches the org name (papr.ai ↔ "papr-ai-production"),
 * so most people never set anything. Stored per org on this device; Parse has no branding field yet.
 */
import { create } from "zustand";

export interface OrgBranding {
  /** Bare domain, e.g. "papr.ai". Empty string = the admin cleared it on purpose. */
  site?: string;
  /** Admin upload as a small data URL. */
  logo?: string;
}

const STORAGE_KEY = "paprwork-org-branding";
const PERSONAL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
]);

/** "https://www.Stripe.com/pricing" → "stripe.com". Anything without a dot is not a site. */
export function cleanSite(value: string): string {
  const s = value.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[/?#:].*$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : "";
}

const SLUG_TLD = /^([a-z0-9][a-z0-9-]*[a-z0-9])-(com|ai|io|co|app|dev|org|net|so|xyz|tech|us|uk|de)$/;

/**
 * Best guess at the org's website, so most people never set one:
 *   1. your work email's domain, when the org name carries it (shawkat@papr.ai ↔ "papr-ai-production")
 *   2. a Parse org slug that spells its domain ("sqaservices-com" → sqaservices.com)
 * A personal org or a Gmail address gets none, and shows its monogram.
 */
export function defaultOrgSite(names: Array<string | undefined>, email: string): string {
  const domain = email.split("@")[1]?.trim().toLowerCase() ?? "";
  const root = domain.split(".")[0];
  if (domain && !PERSONAL.has(domain) && root.length >= 3) {
    const flat = (s?: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (names.some((n) => flat(n).includes(root))) return domain;
  }
  for (const n of names) {
    const m = SLUG_TLD.exec((n ?? "").trim().toLowerCase());
    if (m) return `${m[1]}.${m[2]}`;
  }
  return "";
}

export function orgLogoSrc(b: OrgBranding | undefined, fallbackSite: string): string {
  if (b?.logo) return b.logo;
  const site = b?.site ?? fallbackSite;
  return site ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(site)}&sz=128` : "";
}

export const isOrgAdmin = (role?: string) => role === "owner" || role === "admin";

function load(): Record<string, OrgBranding> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, OrgBranding>) : {};
  } catch {
    return {};
  }
}

interface OrgLogoState {
  branding: Record<string, OrgBranding>;
  update: (orgId: string, patch: OrgBranding) => void;
}

export const useOrgLogos = create<OrgLogoState>((set, get) => ({
  branding: load(),
  update: (orgId, patch) => {
    if (!orgId) return;
    const next: OrgBranding = { ...get().branding[orgId], ...patch };
    if (!next.logo) delete next.logo;
    const branding = { ...get().branding, [orgId]: next };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(branding));
    } catch {
      // Storage full or blocked: the change still applies for this session.
    }
    set({ branding });
  },
}));

/** Shrink an upload to a 128px square so it is cheap to keep and crisp at badge size. */
export function readLogoFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const raw = String(reader.result);
      const img = new Image();
      img.onerror = () => resolve(raw);
      img.onload = () => {
        try {
          const size = 128;
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = size;
          const ctx = canvas.getContext("2d");
          if (!ctx) return resolve(raw);
          const scale = Math.min(size / img.width, size / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
          resolve(canvas.toDataURL("image/png"));
        } catch {
          resolve(raw);
        }
      };
      img.src = raw;
    };
    reader.readAsDataURL(file);
  });
}

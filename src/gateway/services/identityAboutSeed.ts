/**
 * Keep IDENTITY.md "About" in sync with gateway profile (name, email, org).
 * Sleep/web enrichment handle role, industry, and deeper context.
 */

import { promises as fs } from "fs";
import { getPaprDataDir, getPaprWorkspaceDir } from "../../core/utils/paprRoot.js";
import path from "path";

function settingsPath(): string {
  return path.join(getPaprDataDir(), "settings.json");
}

function workspaceDir(): string {
  return getPaprWorkspaceDir();
}

function identityPath(): string {
  return path.join(getPaprWorkspaceDir(), "IDENTITY.md");
}

function brandPath(): string {
  return path.join(getPaprWorkspaceDir(), "BRAND.md");
}

const ABOUT_PLACEHOLDER = "(Name, role, industry, organization)";

export interface GatewayProfile {
  name?: string;
  email?: string;
  imageUrl?: string;
  paprUserId?: string;
  organization?: string;
  role?: string;
}

export interface WorkspaceFileHealth {
  identityAboutComplete: boolean;
  identityAboutMissing: string[];
  brandConfigured: boolean;
  brandUnsetCount: number;
  onboardPending: boolean;
}

const ABOUT_FIELD_PATTERNS: Record<string, RegExp> = {
  name: /\*\*Name:\*\*\s*(.+)/i,
  role: /\*\*Role:\*\*\s*(.+)/i,
  organization: /\*\*Organization:\*\*\s*(.+)/i,
  email: /\*\*Email:\*\*\s*(.+)/i,
};

function organizationFromEmail(email: string): string | undefined {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return undefined;
  const personal = new Set([
    "gmail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
    "icloud.com",
    "me.com",
    "proton.me",
    "protonmail.com",
  ]);
  if (personal.has(domain)) return undefined;
  const root = domain.split(".")[0];
  if (!root || root.length < 2) return undefined;
  return root.charAt(0).toUpperCase() + root.slice(1);
}

export async function loadGatewayProfile(): Promise<GatewayProfile> {
  try {
    const raw = await fs.readFile(settingsPath(), "utf-8");
    const settings = JSON.parse(raw) as { profile?: GatewayProfile };
    const profile = settings.profile ?? {};
    if (!profile.organization?.trim() && profile.email?.trim()) {
      const inferred = organizationFromEmail(profile.email.trim());
      if (inferred) {
        return { ...profile, organization: inferred };
      }
    }
    return profile;
  } catch {
    return {};
  }
}

function parseAboutFields(aboutBody: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, pattern] of Object.entries(ABOUT_FIELD_PATTERNS)) {
    const match = aboutBody.match(pattern);
    const value = match?.[1]?.trim();
    if (value && !value.startsWith("(")) {
      fields[key] = value;
    }
  }
  return fields;
}

function extractAboutBody(content: string): string | null {
  const match = content.match(/## About\n\n([\s\S]*?)(?=\n## |\n---|\Z)/);
  return match?.[1]?.trim() ?? null;
}

function buildAboutLines(profile: GatewayProfile): string[] {
  const lines: string[] = [];
  const name = profile.name?.trim();
  const email = profile.email?.trim();
  const organization = profile.organization?.trim();
  const role = profile.role?.trim();
  if (name) lines.push(`- **Name:** ${name}`);
  if (role) lines.push(`- **Role:** ${role}`);
  if (organization) lines.push(`- **Organization:** ${organization}`);
  if (email) lines.push(`- **Email:** ${email}`);
  return lines;
}

function mergeAboutSection(content: string, profile: GatewayProfile): string | null {
  const aboutBody = extractAboutBody(content);
  if (!aboutBody) return null;

  if (aboutBody.includes(ABOUT_PLACEHOLDER)) {
    const aboutBlock = buildAboutLines(profile).join("\n");
    if (!aboutBlock) return null;
    return content.replace(
      `## About\n\n${ABOUT_PLACEHOLDER}`,
      `## About\n\n${aboutBlock}`,
    );
  }

  const existing = parseAboutFields(aboutBody);
  const merged: GatewayProfile = {
    name: existing.name ?? profile.name,
    role: existing.role ?? profile.role,
    organization: existing.organization ?? profile.organization,
    email: existing.email ?? profile.email,
  };

  const lines = buildAboutLines(merged);
  if (lines.length === 0) return null;

  const newAbout = lines.join("\n");
  if (newAbout === aboutBody) return null;

  return content.replace(
    /## About\n\n[\s\S]*?(?=\n## |\n---|\Z)/,
    `## About\n\n${newAbout}`,
  );
}

/**
 * Sync IDENTITY About from profile — replaces placeholder or fills missing fields.
 */
export async function seedIdentityAboutFromProfile(): Promise<boolean> {
  try {
    const content = await fs.readFile(identityPath(), "utf8");
    const profile = await loadGatewayProfile();
    const updated = mergeAboutSection(content, profile);
    if (!updated || updated === content) {
      return false;
    }

    await fs.writeFile(identityPath(), updated, "utf8");
    console.log("[IdentityAbout] Synced IDENTITY.md About from user profile");
    return true;
  } catch {
    return false;
  }
}

export async function getWorkspaceFileHealth(): Promise<WorkspaceFileHealth> {
  const health: WorkspaceFileHealth = {
    identityAboutComplete: false,
    identityAboutMissing: [],
    brandConfigured: false,
    brandUnsetCount: 0,
    onboardPending: false,
  };

  try {
    const onboardPath = path.join(workspaceDir(), "ONBOARD.md");
    const onboardDone = path.join(workspaceDir(), "ONBOARD.completed.md");
    health.onboardPending =
      (await fileExists(onboardPath)) && !(await fileExists(onboardDone));
  } catch {
    /* noop */
  }

  try {
    const identity = await fs.readFile(identityPath(), "utf8");
    const aboutBody = extractAboutBody(identity);
    if (!aboutBody || aboutBody.includes(ABOUT_PLACEHOLDER)) {
      health.identityAboutMissing.push("name/role/organization (template or empty)");
    } else {
      const fields = parseAboutFields(aboutBody);
      if (!fields.name) health.identityAboutMissing.push("name");
      if (!fields.role) health.identityAboutMissing.push("role");
      if (!fields.organization) health.identityAboutMissing.push("organization");
      health.identityAboutComplete = health.identityAboutMissing.length === 0;
    }
  } catch {
    health.identityAboutMissing.push("IDENTITY.md missing");
  }

  try {
    const brand = await fs.readFile(brandPath(), "utf8");
    const unsetMatches = brand.match(/\(not set\)/gi);
    health.brandUnsetCount = unsetMatches?.length ?? 0;
    health.brandConfigured = health.brandUnsetCount === 0;
  } catch {
    health.brandUnsetCount = 99;
  }

  return health;
}

export function formatWorkspaceFileHealthForSleep(
  health: WorkspaceFileHealth,
  profile: GatewayProfile,
): string {
  const lines: string[] = [
    "## Workspace file health (check before end of run)",
    "",
  ];

  if (profile.name || profile.email) {
    lines.push(
      "**Known profile (from Papr login / settings):**",
      profile.name ? `- Name: ${profile.name}` : "",
      profile.email ? `- Email: ${profile.email}` : "",
      profile.organization ? `- Organization: ${profile.organization}` : "",
      "",
    );
  }

  if (health.onboardPending) {
    lines.push(
      "- ⚠ **ONBOARD.md is still present** — user may not have completed the first-run interview. Prefer updating IDENTITY from explicit chat signals; do not skip About maintenance.",
      "",
    );
  }

  if (!health.identityAboutComplete) {
    lines.push(
      "- ⚠ **IDENTITY.md About is incomplete.** Missing:",
      ...health.identityAboutMissing.map((m) => `  - ${m}`),
      "  → Merge profile fields into `## About`, then add role/industry from chats if repeated (≥2).",
      "  → If role/industry still unknown and user has name+email, run **one** web search for public professional context; cite sources; do not guess.",
      "",
    );
  } else {
    lines.push("- ✓ IDENTITY.md About has core fields.", "");
  }

  if (!health.brandConfigured) {
    lines.push(
      `- ⚠ **BRAND.md mostly unset** (${health.brandUnsetCount} "(not set)" fields).`,
      "  → Only fill from **explicit** user brand statements in recent chats.",
      "  → If user stated company colors/fonts, update BRAND.md + brand.json together.",
      "  → Do not infer brand from website unless user asked or confirmed.",
      "",
    );
  } else {
    lines.push("- ✓ BRAND.md appears configured.", "");
  }

  return lines.filter(Boolean).join("\n");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

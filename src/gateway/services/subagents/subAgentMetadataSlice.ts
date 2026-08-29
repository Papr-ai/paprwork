import type { SubAgentProfile } from "../../../core/types/subagents.js";
import { isCustomSubAgentId } from "./subAgentIntegrity.js";

/** Cloud-synced sub-agent definition fields (excludes local run stats). */
export const SUB_AGENT_CONFIG_FIELD_KEYS = [
  "id",
  "name",
  "description",
  "systemPrompt",
  "provider",
  "model",
  "fallbackProvider",
  "fallbackModel",
  "allowedToolIds",
  "assignedSkills",
  "outputMode",
  "outputSchema",
  "maxTurns",
  "memoryPolicy",
  "icon",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof SubAgentProfile)[];

export type SubAgentConfigSlice = Pick<
  SubAgentProfile,
  (typeof SUB_AGENT_CONFIG_FIELD_KEYS)[number]
>;

function pickConfigFields(profile: SubAgentProfile): SubAgentConfigSlice {
  const out: Partial<SubAgentConfigSlice> = {};
  for (const key of SUB_AGENT_CONFIG_FIELD_KEYS) {
    const value = profile[key];
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out as SubAgentConfigSlice;
}

/** Custom profiles only — built-ins ship with gateway code. */
export function toSubAgentConfigIndexEntry(
  profile: SubAgentProfile,
): SubAgentConfigSlice | null {
  if (!isCustomSubAgentId(profile.id)) {
    return null;
  }
  return pickConfigFields(profile);
}

export function listCustomSubAgentConfigEntries(
  profiles: readonly SubAgentProfile[],
): SubAgentConfigSlice[] {
  return profiles
    .map((profile) => toSubAgentConfigIndexEntry(profile))
    .filter((entry): entry is SubAgentConfigSlice => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function subAgentConfigToProfile(
  config: SubAgentConfigSlice,
): SubAgentProfile {
  return {
    ...config,
    runCount: 0,
  };
}

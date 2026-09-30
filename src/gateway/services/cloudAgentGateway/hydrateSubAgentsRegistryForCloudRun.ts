/**
 * Hydrate data/subagents.json in a cloud agent sandbox from Mongo (Phase 4.6).
 *
 * Namespace git clone may be stale; custom profiles are authoritative in Mongo.
 */

import { promises as fs } from "fs";
import path from "path";
import type { SubAgentProfile } from "../../../core/types/subagents.js";
import {
  mergeSubAgentProfileLists,
  readSubAgentProfilesSync,
} from "../subagents/subAgentIntegrity.js";
import {
  fetchSubAgentsIndexFromCloudDirect,
} from "../syncV3/MetadataRegistryClient.js";
import {
  subAgentConfigToProfile,
  type SubAgentConfigSlice,
} from "../subagents/subAgentMetadataSlice.js";

function configEntriesToProfiles(
  entries: readonly SubAgentConfigSlice[],
): SubAgentProfile[] {
  return entries.map((entry) => subAgentConfigToProfile(entry));
}

export async function applySubAgentsHydrationFromMongo(
  paprHome: string,
  mongoEntries: readonly SubAgentConfigSlice[],
): Promise<number> {
  if (mongoEntries.length === 0) {
    return 0;
  }

  const cloneProfiles = readSubAgentProfilesSync(paprHome);
  const mongoProfiles = configEntriesToProfiles(mongoEntries);
  const merged = mergeSubAgentProfileLists(cloneProfiles, mongoProfiles).sort(
    (a, b) => a.name.localeCompare(b.name),
  );

  const dataDir = path.join(paprHome, "data");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "subagents.json"),
    `${JSON.stringify(merged, null, 2)}\n`,
    "utf8",
  );

  console.log(
    `[CloudAgentRun] Hydrated ${mongoProfiles.length} custom sub-agent profile(s) from Mongo`,
  );
  return mongoProfiles.length;
}

export async function hydrateSubAgentsRegistryForCloudRun(input: {
  paprHome: string;
  paprApiKey: string;
}): Promise<{ hydrated: number; source: "mongo" | "skipped" }> {
  const mongoEntries = await fetchSubAgentsIndexFromCloudDirect(input.paprApiKey);
  if (mongoEntries === null) {
    return { hydrated: 0, source: "skipped" };
  }
  const hydrated = await applySubAgentsHydrationFromMongo(input.paprHome, mongoEntries);
  return { hydrated, source: "mongo" };
}

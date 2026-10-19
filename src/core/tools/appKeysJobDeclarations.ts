/**
 * Rich job requiredKeys: a job can declare its keys ({ name, purpose,
 * provider, required }) where they are first used. The names still go to
 * job.json requiredKeys (runtime env injection); the declarations go to each
 * linked app's requirements.json, so publish knows what visitors need.
 */

import { z } from "zod";
import { extractCustomKeyNames } from "../../gateway/utils/keySubstitution.js";
import { isPlatformInjectedEnvKey } from "../utils/platformInjectedEnvKeys.js";
import { DeclaredKeySchema, declaredKeyToSpec, type DeclaredKey } from "./appKeys.js";

export const JobRequiredKeysSchema = z.array(
  z.union([z.string().min(1), DeclaredKeySchema]),
);

export type JobRequiredKeysInput = z.infer<typeof JobRequiredKeysSchema>;

export function jobRequiredKeyNames(
  input: JobRequiredKeysInput | undefined,
): string[] | undefined {
  if (input === undefined) return undefined;
  return [
    ...new Set(
      input
        .map((item) => (typeof item === "string" ? item : item.name).trim())
        .filter((name) => name.length > 0),
    ),
  ];
}

function declaredKeysOf(input: JobRequiredKeysInput | undefined): DeclaredKey[] {
  return (input ?? []).filter(
    (item): item is DeclaredKey => typeof item !== "string",
  );
}

/**
 * Write declared keys to every linked app; return a reminder naming whatever
 * is still undeclared (bare names, ${NAME} in the command) so the agent can
 * finish with declare_app_keys.
 */
export async function declareJobKeysOnApps(
  appIds: readonly string[],
  requiredKeys: JobRequiredKeysInput | undefined,
  command: string | undefined,
): Promise<{ reminder?: string }> {
  if (appIds.length === 0) return {};
  const declared = declaredKeysOf(requiredKeys);
  const declaredNames = new Set(declared.map((key) => key.name));

  const { getPaprRoot } = await import("../utils/paprRoot.js");
  const { upsertDeclaredAppKeys, readAppRequirements, readAppNotKeys } =
    await import("../../gateway/services/cloudAppRequirements.js");
  const paprDir = getPaprRoot();

  if (declared.length > 0) {
    const specs = declared.map(declaredKeyToSpec);
    for (const appId of appIds) {
      upsertDeclaredAppKeys(paprDir, appId, specs);
    }
    const { notifyAppRequirementsChanged } = await import(
      "../../gateway/services/appRequirementsChanged.js"
    );
    for (const appId of appIds) notifyAppRequirementsChanged(appId);
  }

  const candidates = new Set<string>([
    ...(jobRequiredKeyNames(requiredKeys) ?? []),
    ...(command ? extractCustomKeyNames(command) : []),
  ]);
  const pending: string[] = [];
  for (const name of candidates) {
    if (declaredNames.has(name) || isPlatformInjectedEnvKey(name)) continue;
    const known = appIds.every(
      (appId) =>
        readAppRequirements(paprDir, appId).some((spec) => spec.name === name) ||
        readAppNotKeys(paprDir, appId).includes(name),
    );
    if (!known) pending.push(name);
  }
  if (pending.length === 0) return {};
  return {
    reminder:
      `KEYS TO DECLARE: this job is linked to app ${appIds.join(", ")} and uses ${pending.join(", ")} without saying what they are. ` +
      `Publishing is blocked until each is declared: declare_app_keys({ appId, keys: [{ name, purpose, provider: "owner" | "user", required }], notKeys: [...] }). ` +
      `owner = the publisher supplies it; user = each visitor connects their own; notKeys = job parameters that are not secrets. ` +
      `If it is a paid API and you don't know who pays, ask the user.`,
  };
}

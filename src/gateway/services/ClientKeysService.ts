/**
 * Gateway service — resolve publishable keys for mini-app browsers (desktop).
 */

import { getPaprRoot } from "../../core/utils/paprRoot.js";
import { readAppRequirements } from "./cloudAppRequirements.js";
import {
  getAllowedClientKeyNames,
  resolveClientKeys,
  type ResolveClientKeysResult,
} from "../../core/utils/clientKeys.js";
import { getCustomKeysService } from "./CustomKeysService.js";

export async function resolveDesktopClientKeys(input: {
  appId: string;
  names?: string[];
}): Promise<
  ResolveClientKeysResult & {
    error?: string;
    status?: number;
  }
> {
  const paprDir = getPaprRoot();
  const requirements = readAppRequirements(paprDir, input.appId);
  const allowedNames = getAllowedClientKeyNames(requirements, input.names);

  if (allowedNames.length === 0) {
    const hasClientReqs = requirements.some((s) => s.clientAccess === "client");
    if (input.names?.length && !hasClientReqs) {
      return {
        keys: {},
        missing: [],
        rejected: [],
        status: 400,
        error:
          'No client-safe keys declared in requirements.json. Add clientAccess: "client" for publishable keys.',
      };
    }
    return { keys: {}, missing: [], rejected: [] };
  }

  const customKeys = getCustomKeysService();
  const keyMetadata = (await customKeys.listKeys()).map((meta) => ({
    name: meta.name,
    clientAccess: meta.clientAccess ?? "server",
  }));

  return resolveClientKeys({
    requirements,
    requestedNames: input.names,
    keyMetadata,
    getValue: (name) => customKeys.getKeyByName(name),
  });
}

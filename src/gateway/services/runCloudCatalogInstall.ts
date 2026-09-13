/**
 * Single install entry for Community / Team catalog apps.
 * Used by POST /api/cloud/install and install_cloud_app agent tool.
 */

import type { CommunityCatalogScope } from "../../core/types/communityCatalog.js";
import type { CloudAppInstallMode } from "../../core/types/cloudAppLineage.js";
import {
  browseScopeFromCatalogScope,
  catalogScopeFromBrowseScope,
  getCloudCatalogInstallModeOptions,
  requiresInstallModeChoice,
  resolveAutomaticInstallMode,
} from "../../core/utils/cloudCatalogInstallPolicy.js";
import {
  getCloudAppInstallService,
  type CloudAppInstallInput,
  type CloudAppInstallResult,
} from "./CloudAppInstallService.js";

export class CloudCatalogInstallChoiceRequiredError extends Error {
  readonly code = "install_mode_choice_required";
  readonly catalogScope: CommunityCatalogScope;
  readonly namespaceId: string;
  readonly slug: string;
  readonly visibility?: string;
  readonly options: ReturnType<typeof getCloudCatalogInstallModeOptions>;

  constructor(input: {
    catalogScope: CommunityCatalogScope;
    namespaceId: string;
    slug: string;
    visibility?: string;
    codeInstallable: boolean;
  }) {
    const options = getCloudCatalogInstallModeOptions(input);
    super(
      `Team app "${input.slug}" requires a fork vs collaborate choice. Ask the user, then call install_cloud_app with mode "fork" (my own database) or "track" (shared team database).`,
    );
    this.name = "CloudCatalogInstallChoiceRequiredError";
    this.catalogScope = input.catalogScope;
    this.namespaceId = input.namespaceId;
    this.slug = input.slug;
    this.visibility = input.visibility;
    this.options = options;
  }
}

export interface RunCloudCatalogInstallInput {
  namespaceId: string;
  slug: string;
  mode?: CloudAppInstallMode;
  shareToken?: string;
  catalogScope?: CommunityCatalogScope | "community" | "team";
  visibility?: string;
  /** When known — drives fork vs collaborate gating. Defaults true for agent installs. */
  codeInstallable?: boolean;
}

function normalizeCatalogScope(
  scope: RunCloudCatalogInstallInput["catalogScope"],
): CommunityCatalogScope | undefined {
  if (scope === "community") {
    return "global";
  }
  if (scope === "team") {
    return "namespace";
  }
  return scope;
}

export function buildCloudCatalogInstallInput(
  input: RunCloudCatalogInstallInput,
): CloudAppInstallInput {
  const catalogScope = normalizeCatalogScope(input.catalogScope);
  const codeInstallable = input.codeInstallable !== false;
  const policyInput = {
    catalogScope: catalogScope ?? "global",
    visibility: input.visibility,
    codeInstallable,
  };

  let mode = input.mode;
  if (!mode) {
    const automatic = resolveAutomaticInstallMode(policyInput);
    if (automatic === null) {
      throw new CloudCatalogInstallChoiceRequiredError({
        catalogScope: policyInput.catalogScope,
        namespaceId: input.namespaceId,
        slug: input.slug,
        visibility: input.visibility,
        codeInstallable,
      });
    }
    mode = automatic;
  }

  return {
    namespaceId: input.namespaceId,
    slug: input.slug,
    mode,
    shareToken: input.shareToken,
    catalogScope,
    visibility: input.visibility,
  };
}

export async function runCloudCatalogInstall(
  input: RunCloudCatalogInstallInput,
): Promise<CloudAppInstallResult> {
  const installInput = buildCloudCatalogInstallInput(input);
  return getCloudAppInstallService().installApp(installInput);
}

export {
  browseScopeFromCatalogScope,
  catalogScopeFromBrowseScope,
  getCloudCatalogInstallModeOptions,
  requiresInstallModeChoice,
};

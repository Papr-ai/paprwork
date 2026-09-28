import { describe, expect, it } from "vitest";
import {
  buildCloudInstallAgentSetupMessage,
  shouldOfferInstallAgentSetup,
} from "../src/gateway/services/cloudAppInstallBootstrap.js";
import type { InstallBootstrapResult } from "../src/gateway/services/cloudAppInstallBootstrap.js";
import {
  buildCloudInstallBootstrapFailureAgentMessage,
  isCloudInstallBootstrapError,
} from "../ui/utils/cloudCatalogInstall.js";
import type { CommunityCatalogEntry } from "../src/core/types/communityCatalog.js";

function emptyBootstrap(
  overrides: Partial<InstallBootstrapResult> = {},
): InstallBootstrapResult {
  return {
    appId: "app-1",
    linkedDbs: [],
    ready: true,
    needsSeed: false,
    errors: [],
    warnings: [],
    ...overrides,
  };
}

describe("shouldOfferInstallAgentSetup", () => {
  it("returns true when bootstrap recorded migration errors (fork_empty)", () => {
    expect(
      shouldOfferInstallAgentSetup(
        emptyBootstrap({
          errors: ['Migration failed for "gtm": table x has 18 columns but 15 values'],
        }),
        "fork_empty",
      ),
    ).toBe(true);
  });

  it("returns false for fork_empty when ready with only warnings", () => {
    expect(
      shouldOfferInstallAgentSetup(
        emptyBootstrap({ warnings: ["Turso pull skipped"] }),
        "fork_empty",
      ),
    ).toBe(false);
  });

  it("returns true for shared_primary when needsSeed", () => {
    expect(
      shouldOfferInstallAgentSetup(
        emptyBootstrap({ needsSeed: true }),
        "shared_primary",
      ),
    ).toBe(true);
  });
});

describe("buildCloudInstallAgentSetupMessage", () => {
  it("uses migration-failure wording when errors are present", () => {
    const message = buildCloudInstallAgentSetupMessage({
      appTitle: "GTM Gap Audit",
      appId: "abc",
      sourceSlug: "gtm-gap-audit",
      bootstrap: emptyBootstrap({
        errors: ["Migration failed: column mismatch"],
      }),
    });
    expect(message).toContain("migration failed");
    expect(message).toContain("Migration failed: column mismatch");
    expect(message).not.toContain("community app");
  });
});

describe("cloud install bootstrap UI helpers", () => {
  const entry = {
    name: "GTM Gap Audit",
    namespaceId: "ns-1",
    slug: "gtm-gap-audit",
  } as CommunityCatalogEntry;

  it("detects legacy bootstrap failure errors", () => {
    expect(
      isCloudInstallBootstrapError(
        'Database bootstrap failed: Migration failed for "gtm": …',
      ),
    ).toBe(true);
    expect(isCloudInstallBootstrapError("Install incomplete")).toBe(false);
  });

  it("builds agent message for legacy bootstrap failures", () => {
    const msg = buildCloudInstallBootstrapFailureAgentMessage(
      entry,
      "fork",
      'Database bootstrap failed: Migration failed for "gtm"',
    );
    expect(msg).toContain("gtm-gap-audit");
    expect(msg).toContain("Database bootstrap failed");
  });

  // Regression: 6fb3139c changed the gateway copy to "Couldn't set up the
  // database…" + code install_db_setup_failed, which silently stopped the
  // agent chat handoff because only the old string was matched.
  it("detects install_db_setup_failed by code and by current copy", () => {
    expect(isCloudInstallBootstrapError("anything", "install_db_setup_failed")).toBe(true);
    expect(
      isCloudInstallBootstrapError(
        'Couldn\'t set up the database for "LinkedIn Outreach". Nothing was installed — please try again.',
      ),
    ).toBe(true);
    expect(isCloudInstallBootstrapError("Install failed (500)", "per_user_db")).toBe(false);
  });

  it("includes gateway engine detail in the agent message", () => {
    const msg = buildCloudInstallBootstrapFailureAgentMessage(
      entry,
      "fork",
      'Couldn\'t set up the database for "GTM Gap Audit".',
      'Migration failed for "linkedin-outreach": no such table: action_log_new',
    );
    expect(msg).toContain("no such table: action_log_new");
    expect(msg).toContain("rolled back");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildCloudInstallAgentSetupMessage,
  shouldOfferInstallAgentSetup,
} from "../src/gateway/services/cloudAppInstallBootstrap.js";
import type { InstallBootstrapResult } from "../src/gateway/services/cloudAppInstallBootstrap.js";
import {
  buildCloudInstallBootstrapFailureAgentMessage,
  buildCloudInstallWelcomeMessage,
  buildPostInstallAgentMessage,
  INSTALL_LINKED_RESOURCES_MISSING_CODE,
  isCloudInstallBootstrapError,
  isCloudInstallLinkedResourcesError,
  planCloudInstallFailureHandoff,
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
  });

  it("detects missing linked resources install failures", () => {
    expect(
      isCloudInstallLinkedResourcesError(
        "Install incomplete — required linked resources missing (databases: db-1)",
        INSTALL_LINKED_RESOURCES_MISSING_CODE,
      ),
    ).toBe(true);
  });

  it("plans agent handoff for missing linked resources instead of user error", () => {
    const plan = planCloudInstallFailureHandoff(entry, "track", {
      ok: false,
      error:
        "Install incomplete — required linked resources missing (databases: db-f8731de2)",
      code: INSTALL_LINKED_RESOURCES_MISSING_CODE,
      detail: JSON.stringify({
        missingRequiredDbIds: ["db-f8731de2"],
        missingJobIds: [],
      }),
    });
    expect(plan.kind).toBe("agent");
    if (plan.kind === "agent") {
      expect(plan.agentMessage).toContain("db-f8731de2");
      expect(plan.agentMessage).toContain("rolled back");
    }
  });

  it("plans agent handoff for unknown install errors (catch-all)", () => {
    const plan = planCloudInstallFailureHandoff(entry, "fork", {
      ok: false,
      error: "Cloud install prepare failed (502): upstream unavailable",
    });
    expect(plan.kind).toBe("agent");
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

  it("welcome message explains the app before setup", () => {
    const msg = buildCloudInstallWelcomeMessage({
      appId: "app-1",
      appTitle: "LinkedIn Outreach",
      mode: "fork",
      catalogDescription: "Automate outreach campaigns.",
    });
    expect(msg.indexOf("Explain what this app is")).toBeLessThan(
      msg.indexOf("Then help with any remaining setup"),
    );
    expect(msg).toContain("Catalog description: Automate outreach campaigns.");
  });

  it("post-install message appends keys after overview instruction", () => {
    const msg = buildPostInstallAgentMessage({
      appId: "app-1",
      appTitle: "LinkedIn Outreach",
      mode: "fork",
      requirements: [
        { name: "LINKEDIN_LI_AT", service: "LinkedIn", required: true },
      ],
    });
    expect(msg).toContain("After the overview, still needed");
    expect(msg).toContain("LinkedIn");
  });
});

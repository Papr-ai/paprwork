import { describe, expect, it } from "vitest";
import { resolveInstallDbPolicy } from "../src/gateway/services/cloudInstallDbPolicy.js";
import {
  buildCloudCatalogInstallInput,
  CloudCatalogInstallChoiceRequiredError,
} from "../src/gateway/services/runCloudCatalogInstall.js";

describe("runCloudCatalogInstall", () => {
  it("throws choice required for team-shared apps without mode", () => {
    expect(() =>
      buildCloudCatalogInstallInput({
        namespaceId: "ns-1",
        slug: "team-app",
        catalogScope: "team",
        visibility: "team",
      }),
    ).toThrow(CloudCatalogInstallChoiceRequiredError);
  });

  it("asks community apps for a choice instead of silently forking", () => {
    // Community used to fork automatically: the right default for "I just want
    // to run this" and the wrong one for "I want to help build this", which had
    // no path at all. Now that collaborate is offered, the mode is the caller's
    // to pick, so an omitted mode is a question rather than a default.
    expect(() =>
      buildCloudCatalogInstallInput({
        namespaceId: "ns-1",
        slug: "community-app",
        catalogScope: "community",
        visibility: "public_read",
      }),
    ).toThrow(CloudCatalogInstallChoiceRequiredError);
  });

  it("does not describe a community app as a team app, or collaborate as shared data", () => {
    // The agent relays this sentence to the user, so it decides what they think
    // they are choosing between. Calling community collaborate a shared
    // database is the conflation this whole change exists to undo — and it
    // would be describing a data leak that no longer happens.
    let raised: CloudCatalogInstallChoiceRequiredError | null = null;
    try {
      buildCloudCatalogInstallInput({
        namespaceId: "ns-1",
        slug: "community-app",
        catalogScope: "community",
        visibility: "public_read",
      });
    } catch (err) {
      raised = err as CloudCatalogInstallChoiceRequiredError;
    }

    expect(raised).toBeInstanceOf(CloudCatalogInstallChoiceRequiredError);
    expect(raised?.message).toContain("Community app");
    expect(raised?.message).not.toContain("Team app");
    expect(raised?.message).not.toContain("shared team database");
    // And it still names both modes, so the agent can put the choice to the user.
    expect(raised?.message).toContain('mode "fork"');
    expect(raised?.message).toContain('mode "track"');
  });

  it("still calls a team app a team app", () => {
    let raised: CloudCatalogInstallChoiceRequiredError | null = null;
    try {
      buildCloudCatalogInstallInput({
        namespaceId: "ns-1",
        slug: "team-app",
        catalogScope: "team",
        visibility: "team",
      });
    } catch (err) {
      raised = err as CloudCatalogInstallChoiceRequiredError;
    }

    expect(raised?.message).toContain("Team app");
    expect(raised?.message).toContain("Collaborate (data sharing)");
    expect(raised?.message).toContain('installDbPolicy "shared_primary"');
  });

  it("passes explicit installDbPolicy through", () => {
    expect(
      buildCloudCatalogInstallInput({
        namespaceId: "ns-1",
        slug: "team-app",
        mode: "track",
        installDbPolicy: "fork_empty",
        catalogScope: "namespace",
        visibility: "team",
      }),
    ).toMatchObject({ mode: "track", installDbPolicy: "fork_empty" });
  });

  it("passes explicit track mode through", () => {
    expect(
      buildCloudCatalogInstallInput({
        namespaceId: "ns-1",
        slug: "team-app",
        mode: "track",
        catalogScope: "namespace",
        visibility: "team",
      }),
    ).toMatchObject({ mode: "track" });
  });

  it("reads an absent scope as community, not as team", () => {
    // catalogScope is optional on both entry points — the /api/cloud/install
    // body and the install_cloud_app tool schema — so "the caller did not say"
    // is an ordinary input, not a malformed one. The two readings are not
    // equally safe: taken as namespace it means the publisher's own database,
    // so an absent scope has to fall to the community side.
    expect(
      buildCloudCatalogInstallInput({
        namespaceId: "ns-1",
        slug: "community-app",
        mode: "track",
        visibility: "team",
      }),
    ).toMatchObject({ mode: "track", catalogScope: "global" });
  });

  it("an absent scope cannot reach the publisher's database", () => {
    // The sequence CloudAppInstallService runs: build the input, then resolve
    // data policy from the scope it carries. Asserted as a composition because
    // each half is individually correct — resolveInstallDbPolicy is right to
    // return shared_primary for a namespace install, and the defaulting is
    // right to pick community. The defect was only visible in the seam.
    const built = buildCloudCatalogInstallInput({
      namespaceId: "ns-1",
      slug: "community-app",
      mode: "track",
      visibility: "team",
    });

    expect(resolveInstallDbPolicy(built.mode ?? "fork", [], built.catalogScope)).toBe(
      "fork_empty",
    );
  });
});

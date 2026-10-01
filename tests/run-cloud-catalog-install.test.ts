import { describe, expect, it } from "vitest";
import { resolveInstallDbPolicy } from "../src/gateway/services/cloudInstallDbPolicy.js";
import {
  buildCloudCatalogInstallInput,
} from "../src/gateway/services/runCloudCatalogInstall.js";

describe("runCloudCatalogInstall", () => {
  // v5: one Install. Omitting mode never asks a question; every installable
  // copy is linked to the original and the data follows the catalog.
  it("team-shared app without mode: linked copy, data left to the gateway", () => {
    const input = buildCloudCatalogInstallInput({
      namespaceId: "ns-1",
      slug: "team-app",
      catalogScope: "team",
      visibility: "team",
    });
    expect(input.mode).toBe("track");
    // No explicit shared_primary: the gateway picks team data only when the
    // databases are shared and the server confirms team/owner access.
    expect(input.installDbPolicy).toBeUndefined();
    expect(resolveInstallDbPolicy(input.mode!, ["shared"], input.catalogScope, input.installDbPolicy, "team")).toBe("shared_primary");
    expect(resolveInstallDbPolicy(input.mode!, ["per-user"], input.catalogScope, input.installDbPolicy, "team")).toBe("fork_empty");
    expect(resolveInstallDbPolicy(input.mode!, ["shared"], input.catalogScope, input.installDbPolicy, "link_read")).toBe("fork_empty");
  });

  it("community app without mode: linked copy on its own data, never shared", () => {
    expect(
      buildCloudCatalogInstallInput({
        namespaceId: "ns-1",
        slug: "community-app",
        catalogScope: "community",
        visibility: "public_read",
      }),
    ).toMatchObject({ mode: "track", installDbPolicy: "fork_empty" });
  });

  it("explicit fork still installs a detached copy for older callers", () => {
    const input = buildCloudCatalogInstallInput({
      namespaceId: "ns-1",
      slug: "team-app",
      mode: "fork",
      catalogScope: "team",
      visibility: "team",
    });
    expect(input.mode).toBe("fork");
    expect(input.installDbPolicy).toBeUndefined();
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

import { describe, expect, it } from "vitest";
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

  it("defaults community apps to fork", () => {
    expect(
      buildCloudCatalogInstallInput({
        namespaceId: "ns-1",
        slug: "community-app",
        catalogScope: "community",
        visibility: "public_read",
      }),
    ).toMatchObject({ mode: "fork", catalogScope: "global" });
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
});

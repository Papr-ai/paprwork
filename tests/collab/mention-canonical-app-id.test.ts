import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #930: a mention about an installed copy must carry the publisher's app id,
// and the receiver must map that id back to its own local app.
describe("mention app ids (#930)", () => {
  let apps: string;
  beforeAll(() => {
    apps = mkdtempSync(join(tmpdir(), "papr-930-"));
    mkdirSync(join(apps, "publisher-app"), { recursive: true });
    writeFileSync(join(apps, "publisher-app", "metadata.json"), "{}");
    mkdirSync(join(apps, "my-copy"), { recursive: true });
    writeFileSync(join(apps, "my-copy", "metadata.json"), "{}");
    writeFileSync(join(apps, "my-copy", "papr-cloud-lineage.json"), JSON.stringify({
      schemaVersion: "1.2.0", lineageId: "lin-1", mode: "track", installedAt: "2026-11-01T00:00:00Z",
      source: { appId: "upstream-app", slug: "launch-post-studio", namespaceId: "ns1" },
    }));
  });

  it("sends the publisher's id for an installed copy, own id otherwise", async () => {
    const { canonicalAppId } = await import("../../src/gateway/services/collab/mentions.js");
    expect(await canonicalAppId("my-copy", apps)).toBe("upstream-app");
    expect(await canonicalAppId("publisher-app", apps)).toBe("publisher-app");
  });

  it("resolves an incoming id to this device's app", async () => {
    const { localAppFor } = await import("../../src/gateway/services/collab/mentions.js");
    expect(await localAppFor("publisher-app", apps)).toBe("publisher-app");
    expect(await localAppFor("upstream-app", apps)).toBe("my-copy");
    expect(await localAppFor("someone-elses-local-id", apps)).toBeNull();
  });
});

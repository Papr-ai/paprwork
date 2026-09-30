import { describe, expect, it } from "vitest";
import { buildAppRevisionJsonUrl } from "../ui/utils/publishedAppRevisionCheck";

describe("buildAppRevisionJsonUrl", () => {
  it("appends revision json path to cloud preview base", () => {
    expect(
      buildAppRevisionJsonUrl(
        "http://localhost:18789/cloud-preview/ns1/my-app/?_r=1",
      ),
    ).toBe("http://localhost:18789/cloud-preview/ns1/my-app/__papr__/app-revision.json");
  });

  it("strips index.html from preview url", () => {
    expect(
      buildAppRevisionJsonUrl("https://apps.papr.ai/ns1/my-app/index.html"),
    ).toBe("https://apps.papr.ai/ns1/my-app/__papr__/app-revision.json");
  });
});

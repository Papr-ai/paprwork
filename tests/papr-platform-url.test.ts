import { afterEach, describe, expect, it } from "vitest";
import {
  getConfiguredPaprPlatformUrl,
  getPaprBillingPlatformUrl,
  getPaprTeamPlatformUrl,
} from "../src/core/utils/paprPlatformUrl.js";

const env = process.env;

afterEach(() => {
  process.env = { ...env };
});

describe("paprPlatformUrl", () => {
  it("billing honors PAPR_PLATFORM_URL", () => {
    process.env.PAPR_PLATFORM_URL = "https://papr.ngrok.dev";
    expect(getPaprBillingPlatformUrl()).toBe("https://papr.ngrok.dev");
  });

  it("team uses same host as billing when Parse is prod and platform is dev tunnel", () => {
    process.env.PAPR_PLATFORM_URL = "https://papr.ngrok.dev";
    delete process.env.PARSE_GRAPHQL_URL;
    delete process.env.PAPR_TEAM_PLATFORM_URL;
    expect(getPaprTeamPlatformUrl()).toBe("https://papr.ngrok.dev");
  });

  it("team honors PAPR_TEAM_PLATFORM_URL override", () => {
    process.env.PAPR_PLATFORM_URL = "https://papr.ngrok.dev";
    process.env.PAPR_TEAM_PLATFORM_URL = "https://custom.example.com";
    expect(getPaprTeamPlatformUrl()).toBe("https://custom.example.com");
  });

  it("team uses same custom platform when Parse is also non-production", () => {
    process.env.PAPR_PLATFORM_URL = "https://papr.ngrok.dev";
    process.env.PARSE_GRAPHQL_URL =
      "https://parseserver-development-223473570766.us-west1.run.app/graphql";
    delete process.env.PAPR_TEAM_PLATFORM_URL;
    expect(getPaprTeamPlatformUrl()).toBe("https://papr.ngrok.dev");
  });

  it("getConfiguredPaprPlatformUrl strips trailing slash", () => {
    process.env.PAPR_PLATFORM_URL = "https://papr.ngrok.dev/";
    expect(getConfiguredPaprPlatformUrl()).toBe("https://papr.ngrok.dev");
  });
});

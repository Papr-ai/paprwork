import { describe, expect, it } from "vitest";
import {
  ensureUniqueAppTitle,
  publishSlugRetryCandidates,
  resolveUniquePublishSlug,
} from "../src/gateway/utils/uniqueAppNaming.js";

describe("uniqueAppNaming", () => {
  it("ensureUniqueAppTitle keeps first title unchanged", () => {
    expect(ensureUniqueAppTitle("Mem0 Stargazers", [])).toBe("Mem0 Stargazers");
  });

  it("ensureUniqueAppTitle appends _1 for duplicate titles (case-insensitive)", () => {
    expect(
      ensureUniqueAppTitle("mem0 stargazers", ["Mem0 Stargazers"]),
    ).toBe("mem0 stargazers_1");
  });

  it("ensureUniqueAppTitle skips excluded title on rename", () => {
    expect(
      ensureUniqueAppTitle("Mem0 Stargazers", ["Mem0 Stargazers"], {
        excludeTitle: "Mem0 Stargazers",
      }),
    ).toBe("Mem0 Stargazers");
  });

  it("resolveUniquePublishSlug keeps existing memory slug", () => {
    expect(
      resolveUniquePublishSlug("app-b", [
        {
          appId: "app-a",
          title: "Mem0 Stargazers",
          createdAt: "2026-01-01T00:00:00.000Z",
          memorySlug: "mem0-stargazers",
        },
        {
          appId: "app-b",
          title: "Mem0 Stargazers",
          createdAt: "2026-01-02T00:00:00.000Z",
          memorySlug: "mem0-stargazers-copy",
        },
      ]),
    ).toBe("mem0-stargazers-copy");
  });

  it("resolveUniquePublishSlug disambiguates legacy duplicate titles locally", () => {
    expect(
      resolveUniquePublishSlug("app-b", [
        {
          appId: "app-a",
          title: "Mem0 Stargazers",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          appId: "app-b",
          title: "Mem0 Stargazers",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      ]),
    ).toBe("mem0-stargazers-1");
  });

  it("publishSlugRetryCandidates returns incremental suffixes", () => {
    expect(publishSlugRetryCandidates("mem0-stargazers", 3)).toEqual([
      "mem0-stargazers",
      "mem0-stargazers-1",
      "mem0-stargazers-2",
    ]);
  });
});

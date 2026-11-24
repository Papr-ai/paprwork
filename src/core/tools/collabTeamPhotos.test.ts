import { describe, it, expect } from "vitest";
import { withTeamPhotos } from "./collab.js";

describe("withTeamPhotos", () => {
  const ws = [
    { userId: "u1", displayName: "Amir", email: "amir@papr.ai", imageUrl: "https://p/amir.jpg" },
    { userId: "u9", displayName: "Shawkat", email: "Shawkat@papr.ai", imageUrl: "https://p/sh.jpg" },
  ];
  it("takes the photo from the workspace team by user id, then email", () => {
    const out = withTeamPhotos([
      { userId: "u1", displayName: "Amir", email: "amir@papr.ai", imageUrl: null },
      { userId: "x2", displayName: "Shawkat", email: "shawkat@papr.ai" },
      { userId: "u3", displayName: "New", email: "new@papr.ai" },
    ], ws);
    expect(out.map((m) => m.imageUrl ?? null)).toEqual(["https://p/amir.jpg", "https://p/sh.jpg", null]);
  });
  it("keeps the member's own photo when the team has none", () => {
    expect(withTeamPhotos([{ userId: "u3", displayName: "N", email: "n@p", imageUrl: "https://own" }], ws)[0].imageUrl).toBe("https://own");
  });
});

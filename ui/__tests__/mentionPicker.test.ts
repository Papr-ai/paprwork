import { describe, expect, it } from "vitest";
import { filterTeammates, insertMention, mentionQueryAt } from "../components/Chat/mentionText";

const team = [
  { userId: "u1", displayName: "Shawkat Kabbara", email: "shawkat@papr.ai" },
  { userId: "u2", displayName: "Amir Kabbara", email: "amir@papr.ai" },
  { userId: "u3", displayName: "Sam Lee", email: "sam@papr.ai" },
];

describe("@ picker", () => {
  it("finds the query only right after @ at a word start", () => {
    expect(mentionQueryAt("ping @sha", 9)).toBe("sha");
    expect(mentionQueryAt("@", 1)).toBe("");
    expect(mentionQueryAt("mail me@papr", 12)).toBeNull();
    expect(mentionQueryAt("@sam done", 9)).toBeNull();
  });
  it("inserts the full name and keeps the rest", () => {
    expect(insertMention("hey @sha tail", 8, "Shawkat Kabbara")).toEqual({ text: "hey @Shawkat Kabbara  tail", cursor: 21 });
  });
  it("filters by any name word or email", () => {
    expect(filterTeammates(team, "kab").map((m) => m.userId)).toEqual(["u1", "u2"]);
    expect(filterTeammates(team, "sam").map((m) => m.userId)).toEqual(["u3"]);
  });
});


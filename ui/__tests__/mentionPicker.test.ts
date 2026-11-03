import { describe, expect, it } from "vitest";
import { filterTeammates, insertMention, mentionQueryAt, rankTeammates } from "../components/Chat/mentionText";

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


describe("@ dropdown", () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ userId: `s${i}`, displayName: `Sam ${String.fromCharCode(65 + i)}`, email: `sam${i}@x.ai` }));
  it("shows at most 6, best first, and counts the rest", () => {
    const r = rankTeammates([...team, ...many], "s");
    expect(r.shown).toHaveLength(6);
    expect(r.more).toBe(10); // Shawkat, Sam Lee and 14 Sams match "s"; Amir does not
    expect(rankTeammates(team, "sha").shown.map((m) => m.userId)).toEqual(["u1"]);
    expect(rankTeammates(team, "kab").shown.map((m) => m.userId)).toEqual(["u2", "u1"]);
  });
  it("puts people you picked recently first, most recent first", () => {
    const r = rankTeammates([...team, ...many], "s", 6, ["s9", "u1"]);
    expect(r.shown.slice(0, 2).map((m) => m.userId)).toEqual(["s9", "u1"]);
    expect(r.recentCount).toBe(2);
    expect(rankTeammates(team, "sam", 6, ["u1"]).recentCount).toBe(0); // recent but not a match
  });
});

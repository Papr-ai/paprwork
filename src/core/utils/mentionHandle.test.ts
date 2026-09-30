import { describe, expect, it } from "vitest";

import {
  buildUniqueMentionHandles,
  matchesMentionQuery,
  toMentionHandle,
} from "./mentionHandle.js";

describe("toMentionHandle", () => {
  it("slugifies a display name", () => {
    expect(toMentionHandle("Amir Kabbara")).toBe("amir-kabbara");
  });

  it("falls back to the email local part", () => {
    expect(toMentionHandle("", "wasseem@papr.ai")).toBe("wasseem");
    expect(toMentionHandle(undefined, "first.last@papr.ai")).toBe("first-last");
  });

  it("strips accents so the handle stays typeable", () => {
    expect(toMentionHandle("Zoë Müller")).toBe("zoe-muller");
  });

  it("collapses punctuation and trims separators", () => {
    expect(toMentionHandle("  O'Brien,  Pat!  ")).toBe("o-brien-pat");
  });

  it("never returns an empty handle", () => {
    expect(toMentionHandle("", "")).toBe("user");
    expect(toMentionHandle("!!!", undefined)).toBe("user");
  });
});

describe("buildUniqueMentionHandles", () => {
  it("keeps distinct names distinct", () => {
    const handles = buildUniqueMentionHandles([
      { userId: "1", displayName: "Amir Kabbara", email: "amir@papr.ai" },
      { userId: "2", displayName: "Wasseem Kabbara", email: "wasseem@papr.ai" },
    ]);
    expect(handles.get("1")).toBe("amir-kabbara");
    expect(handles.get("2")).toBe("wasseem-kabbara");
  });

  it("disambiguates identical names via the email local part", () => {
    // Two real people can share a display name; the picker must never show
    // one handle for both.
    const handles = buildUniqueMentionHandles([
      { userId: "1", displayName: "Alex Kim", email: "alex@papr.ai" },
      { userId: "2", displayName: "Alex Kim", email: "akim@papr.ai" },
    ]);
    expect(handles.get("1")).toBe("alex-kim");
    expect(handles.get("2")).toBe("akim");
    expect(new Set(handles.values()).size).toBe(2);
  });

  it("falls back to a numeric suffix when emails collide too", () => {
    const handles = buildUniqueMentionHandles([
      { userId: "1", displayName: "Alex Kim", email: "alex@a.com" },
      { userId: "2", displayName: "Alex Kim", email: "alex@b.com" },
      { userId: "3", displayName: "Alex Kim", email: "alex@c.com" },
    ]);
    expect(new Set(handles.values()).size).toBe(3);
    // Person 2 takes the email local part ("alex"), so person 3 is the first
    // caller to need a numeric suffix — the counter tracks handle collisions,
    // not the person's position in the roster.
    expect(handles.get("2")).toBe("alex");
    expect(handles.get("3")).toBe("alex-kim-2");
  });

  it("produces one handle per person", () => {
    const people = [
      { userId: "1", displayName: "A" },
      { userId: "2", displayName: "B" },
      { userId: "3", displayName: "C" },
    ];
    expect(buildUniqueMentionHandles(people).size).toBe(3);
  });
});

describe("matchesMentionQuery", () => {
  const person = {
    userId: "1",
    displayName: "Amir Kabbara",
    email: "amir@papr.ai",
  };

  it("matches on handle, name, and email", () => {
    expect(matchesMentionQuery(person, "amir-kabbara", "kabb")).toBe(true);
    expect(matchesMentionQuery(person, "amir-kabbara", "Amir")).toBe(true);
    expect(matchesMentionQuery(person, "amir-kabbara", "papr.ai")).toBe(true);
  });

  it("ignores a leading @ as typed", () => {
    expect(matchesMentionQuery(person, "amir-kabbara", "@amir")).toBe(true);
  });

  it("returns everything for an empty query", () => {
    expect(matchesMentionQuery(person, "amir-kabbara", "   ")).toBe(true);
  });

  it("rejects a non-match", () => {
    expect(matchesMentionQuery(person, "amir-kabbara", "zzz")).toBe(false);
  });
});

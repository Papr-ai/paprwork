import { describe, expect, it } from "vitest";
import { buildSharePeopleMenuEntries } from "../ui/utils/sharePeopleInput";

describe("buildSharePeopleMenuEntries", () => {
  const base = {
    memberUserIds: [] as string[],
    memberEmailsByUserId: new Map([
      ["u1", "teammate@papr.ai"],
      ["u2", "other@client.com"],
    ]),
    allowedEmails: [] as string[],
    allowedEmailDomains: [] as string[],
    memberMatches: [{ userId: "u1", email: "teammate@papr.ai" }],
    currentUserId: "owner",
  };

  it("offers external email when address is not a workspace member", () => {
    const entries = buildSharePeopleMenuEntries({
      ...base,
      query: "partner@client.com",
      memberMatches: [],
    });
    expect(entries).toEqual([
      { kind: "external_email", email: "partner@client.com" },
    ]);
  });

  it("prefers workspace member when email matches roster", () => {
    const entries = buildSharePeopleMenuEntries({
      ...base,
      query: "teammate@papr.ai",
      memberMatches: [],
    });
    expect(entries).toEqual([{ kind: "member", userId: "u1" }]);
  });

  it("adds domain for @company.com", () => {
    const entries = buildSharePeopleMenuEntries({
      ...base,
      query: "@client.com",
      memberMatches: [],
    });
    expect(entries).toEqual([{ kind: "domain", domain: "client.com" }]);
  });

  it("adds domain for bare domain.com", () => {
    const entries = buildSharePeopleMenuEntries({
      ...base,
      query: "client.com",
      memberMatches: [],
    });
    expect(entries).toEqual([{ kind: "domain", domain: "client.com" }]);
  });

  it("does not treat a full email as a domain", () => {
    const entries = buildSharePeopleMenuEntries({
      ...base,
      query: "person@client.com",
      memberMatches: [],
    });
    expect(entries.some((e) => e.kind === "domain")).toBe(false);
  });
});

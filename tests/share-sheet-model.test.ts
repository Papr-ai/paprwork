import { describe, expect, it } from "vitest";
import {
  perUserDataAvailable,
  resolveSharingPatch,
  sharePublishLabel,
  shareSteps,
  summarizeKeys,
  summarizeWhat,
  type SharingDraft,
} from "../ui/utils/shareSheetModel.js";

const base: SharingDraft = {
  audience: "team",
  permission: "write",
  requireSignIn: true,
  perUserIsolation: false,
};

describe("shareSheetModel", () => {
  it("private apps only ask who", () => {
    expect(shareSteps("private")).toEqual(["who"]);
    expect(shareSteps("link")).toEqual(["who", "what", "keys"]);
  });

  it("switching to private drops permission to read", () => {
    const next = resolveSharingPatch(base, { audience: "private" });
    expect(next.permission).toBe("read");
    expect(next.perUserIsolation).toBe(false);
  });

  it("Community defaults to install-a-copy with no sign-in", () => {
    const next = resolveSharingPatch(base, { audience: "public" });
    expect(next.permission).toBe("edit");
    expect(next.requireSignIn).toBe(false);
    expect(perUserDataAvailable(next)).toBe(false);
  });

  it("link defaults to sign-in and per-user data", () => {
    const next = resolveSharingPatch(
      { ...base, audience: "private", permission: "read" },
      {
        audience: "link",
      },
    );
    expect(next.permission).toBe("write");
    expect(next.requireSignIn).toBe(true);
    expect(next.perUserIsolation).toBe(true);
  });

  it("turning sign-in off on a link clears per-user data", () => {
    const link = resolveSharingPatch(base, { audience: "link" });
    const next = resolveSharingPatch(link, { requireSignIn: false });
    expect(next.perUserIsolation).toBe(false);
    expect(summarizeWhat(next)).toBe("Use your app");
  });

  it("summarizes keys as mine vs theirs", () => {
    expect(summarizeKeys(null)).toBe("Checking…");
    expect(summarizeKeys([])).toBe("None needed");
    const spec = {
      service: "x",
      category: "other",
      description: "",
      required: true,
      clientAccess: "server",
    } as const;
    expect(
      summarizeKeys([
        { ...spec, name: "A", credentialScope: "owner" },
        { ...spec, name: "B", credentialScope: "user" },
      ]),
    ).toBe("1 on yours · 1 on theirs");
  });

  it("publish label names the audience", () => {
    expect(sharePublishLabel("team", 0, false)).toBe("Publish to workspace");
    expect(sharePublishLabel("people", 3, false)).toBe("Publish to 3 people");
    expect(sharePublishLabel("public", 0, true)).toBe("Publish your copy");
  });
});

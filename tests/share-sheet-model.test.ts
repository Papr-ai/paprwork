import { describe, expect, it } from "vitest";
import type { RequiredKeySpec } from "../src/core/types/bundles.js";
import {
  missingKeysLabel,
  missingKeysTone,
  missingOwnerKeys,
  perUserDataAvailable,
  resolveSharingPatch,
  shareEditFlow,
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

const spec = (
  name: string,
  credentialScope: "owner" | "user",
  required = true,
): RequiredKeySpec => ({
  name,
  service: name,
  category: "other",
  description: "",
  required,
  credentialScope,
  clientAccess: "server",
});

describe("shareSheetModel — answers", () => {
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
      { audience: "link" },
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
});

describe("shareSheetModel — edit flow", () => {
  it("changing who walks on to what, then keys when the app has keys", () => {
    expect(shareEditFlow("who", "link", true)).toEqual(["who", "what", "keys"]);
    expect(shareEditFlow("who", "team", false)).toEqual(["who", "what"]);
  });

  it("Only me has nothing after who", () => {
    expect(shareEditFlow("who", "private", true)).toEqual(["who"]);
  });

  it("changing what walks on to keys only if there are keys", () => {
    expect(shareEditFlow("what", "public", true)).toEqual(["what", "keys"]);
    expect(shareEditFlow("what", "public", false)).toEqual(["what"]);
  });

  it("keys alone is a single step", () => {
    expect(shareEditFlow("keys", "link", true)).toEqual(["keys"]);
  });
});

describe("shareSheetModel — missing keys", () => {
  const specs = [
    spec("OPENAI_API_KEY", "owner"),
    spec("SLACK_TOKEN", "owner", false),
    spec("STRIPE_KEY", "user"),
  ];

  it("only flags Mine keys that aren't in the keychain", () => {
    const missing = missingOwnerKeys(specs, ["OPENAI_API_KEY"]);
    expect(missing.map((s) => s.name)).toEqual(["SLACK_TOKEN"]);
  });

  it("red when a required key is missing, orange when only optional ones are", () => {
    expect(missingKeysTone(missingOwnerKeys(specs, []))).toBe("bad");
    expect(missingKeysTone(missingOwnerKeys(specs, ["OPENAI_API_KEY"]))).toBe(
      "warn",
    );
    expect(
      missingKeysTone(
        missingOwnerKeys(specs, ["OPENAI_API_KEY", "SLACK_TOKEN"]),
      ),
    ).toBeNull();
  });

  it("labels and summary", () => {
    const missing = missingOwnerKeys(specs, []);
    expect(missingKeysLabel(missing)).toBe("2 keys missing");
    expect(summarizeKeys(specs, missing)).toBe("2 missing on your account");
    expect(summarizeKeys(specs, [])).toBe("2 on yours · 1 on theirs");
    expect(summarizeKeys(null)).toBe("Checking…");
    expect(summarizeKeys([])).toBe("None needed");
  });
});

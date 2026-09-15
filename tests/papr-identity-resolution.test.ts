/**
 * An identity we could not read is not an identity of nobody.
 *
 * Every owned mini-app carries an `ownerUserId`, and the ownership filter
 * hides an app whose owner is not the current user. So when the current user
 * cannot be determined, that filter removes *everything* and the read returns
 * an empty list with success — a confident wrong answer, which the renderer
 * then writes into the cache the next launch hydrates from.
 *
 * These pin the distinction that makes that impossible: `absent` (no Papr
 * account, filtering is correct) versus `unresolved` (could not tell, filtering
 * is destructive).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scopeMock = vi.hoisted(() => ({
  readActiveAppWorkspaceScope: vi.fn(),
}));

vi.mock("../src/core/utils/appWorkspaceScope.js", () => scopeMock);

let dataDir: string;

vi.mock("../src/core/utils/paprRoot.js", () => ({
  getPaprDataDir: () => dataDir,
}));

const NAMESPACED = { organizationId: "Y8D4H7Yp3Z", namespaceId: "85ZIB7mD1V" };

async function freshModule() {
  vi.resetModules();
  return import("../src/gateway/utils/paprUserId.js");
}

function writeSettings(contents: unknown | string): void {
  fs.writeFileSync(
    path.join(dataDir, "settings.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf-8",
  );
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-identity-"));
  delete process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID;
  scopeMock.readActiveAppWorkspaceScope.mockReset();
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID;
});

describe("resolvePaprUserIdentity", () => {
  it("reads the id from settings and reports it as known", async () => {
    scopeMock.readActiveAppWorkspaceScope.mockReturnValue(NAMESPACED);
    writeSettings({ profile: { paprUserId: "mkcNHhG5KP" } });

    const { resolvePaprUserIdentity } = await freshModule();

    expect(resolvePaprUserIdentity()).toEqual({
      userId: "mkcNHhG5KP",
      state: "known",
    });
  });

  it("prefers the spawn-time env id without touching disk", async () => {
    scopeMock.readActiveAppWorkspaceScope.mockReturnValue(NAMESPACED);
    process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = "fromEnv";
    // No settings.json at all: the env value must be sufficient.

    const { resolvePaprUserIdentity } = await freshModule();

    expect(resolvePaprUserIdentity()).toEqual({
      userId: "fromEnv",
      state: "known",
    });
  });

  it("falls back to paprProfile.userId when profile.paprUserId is blank", async () => {
    scopeMock.readActiveAppWorkspaceScope.mockReturnValue(NAMESPACED);
    // An empty string is a value, so a nullish fallback would stop here and
    // return "" — which reads as "no user" and hides every app.
    writeSettings({
      profile: { paprUserId: "   " },
      paprProfile: { userId: "mkcNHhG5KP" },
    });

    const { resolvePaprUserIdentity } = await freshModule();

    expect(resolvePaprUserIdentity().userId).toBe("mkcNHhG5KP");
  });

  describe("inside a namespaced workspace, no id means not yet", () => {
    beforeEach(() => {
      // A namespaced workspace is only ever created for a signed-in user.
      scopeMock.readActiveAppWorkspaceScope.mockReturnValue(NAMESPACED);
    });

    it("is unresolved when the profile has not been written yet", async () => {
      // Exactly the boot window: the file exists because the workspace was
      // scaffolded, but the main process has not synced the profile into it.
      writeSettings({ preferences: {} });

      const { resolvePaprUserIdentity } = await freshModule();

      expect(resolvePaprUserIdentity().state).toBe("unresolved");
    });

    it("is unresolved when settings.json is missing", async () => {
      const { resolvePaprUserIdentity } = await freshModule();

      expect(resolvePaprUserIdentity().state).toBe("unresolved");
    });

    it("is unresolved when settings.json is mid-write", async () => {
      writeSettings('{"profile": {"paprUse');

      const { resolvePaprUserIdentity } = await freshModule();

      expect(resolvePaprUserIdentity().state).toBe("unresolved");
    });
  });

  describe("outside a namespaced workspace, no id means nobody", () => {
    beforeEach(() => {
      // Open-source / offline: no org, no namespace, no Papr account. Hiding
      // another user's apps here is the intended behaviour, not a race.
      scopeMock.readActiveAppWorkspaceScope.mockReturnValue(null);
    });

    it("is absent when settings has no profile", async () => {
      writeSettings({ preferences: {} });

      const { resolvePaprUserIdentity } = await freshModule();

      expect(resolvePaprUserIdentity().state).toBe("absent");
    });

    it("is absent when settings.json is missing entirely", async () => {
      const { resolvePaprUserIdentity } = await freshModule();

      expect(resolvePaprUserIdentity().state).toBe("absent");
    });
  });

  describe("caching", () => {
    it("does not memoise a miss, so the profile is seen as soon as it lands", async () => {
      scopeMock.readActiveAppWorkspaceScope.mockReturnValue(NAMESPACED);
      writeSettings({ preferences: {} });

      const { resolvePaprUserIdentity } = await freshModule();
      expect(resolvePaprUserIdentity().state).toBe("unresolved");

      // The main process finishes syncing the profile. Caching the miss would
      // hold the wrong answer for the full TTL — 30 seconds of hiding every
      // app the user owns.
      writeSettings({ profile: { paprUserId: "mkcNHhG5KP" } });

      expect(resolvePaprUserIdentity()).toEqual({
        userId: "mkcNHhG5KP",
        state: "known",
      });
    });

    it("memoises a hit, because that is the hot path this cache exists for", async () => {
      scopeMock.readActiveAppWorkspaceScope.mockReturnValue(NAMESPACED);
      writeSettings({ profile: { paprUserId: "mkcNHhG5KP" } });

      const { resolvePaprUserIdentity } = await freshModule();
      expect(resolvePaprUserIdentity().userId).toBe("mkcNHhG5KP");

      fs.rmSync(path.join(dataDir, "settings.json"));

      expect(resolvePaprUserIdentity().userId).toBe("mkcNHhG5KP");
    });

    it("drops the cached hit on invalidation, so a login switch is honoured", async () => {
      scopeMock.readActiveAppWorkspaceScope.mockReturnValue(NAMESPACED);
      writeSettings({ profile: { paprUserId: "first" } });

      const { resolvePaprUserIdentity, invalidatePaprUserIdCache } =
        await freshModule();
      expect(resolvePaprUserIdentity().userId).toBe("first");

      writeSettings({ profile: { paprUserId: "second" } });
      invalidatePaprUserIdCache();

      expect(resolvePaprUserIdentity().userId).toBe("second");
    });
  });

  it("getPaprUserId still answers undefined for both no-id states", async () => {
    // Existing callers keep working: the distinction is additive, and only
    // callers that would *hide* something need to consult it.
    scopeMock.readActiveAppWorkspaceScope.mockReturnValue(NAMESPACED);

    const { getPaprUserId } = await freshModule();

    expect(getPaprUserId()).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  loadSharedPrimaryTursoStore,
  lookupSharedPrimaryTursoEntry,
  registerSharedPrimaryTursoEntries,
  resolveSharedPrimaryTursoStorePath,
} from "../src/gateway/services/sharedPrimaryTursoStore.js";

const cloudApiFetch = vi.fn();
const getPaprApiKey = vi.fn();

vi.mock("../src/gateway/utils/cloudApiClient.js", () => ({
  cloudApiFetch: (...args: unknown[]) => cloudApiFetch(...args),
}));

vi.mock("../src/gateway/utils/keyResolver.js", () => ({
  getPaprApiKey: (...args: unknown[]) => getPaprApiKey(...args),
}));

vi.mock("../src/gateway/utils/cloudActingUser.js", () => ({
  mergeCloudActingUserBody: (body: Record<string, unknown>) => body,
}));

describe("sharedPrimaryTursoStore", () => {
  let paprHome: string;

  beforeEach(async () => {
    paprHome = await fs.mkdtemp(path.join(os.tmpdir(), "papr-shared-primary-"));
  });

  afterEach(async () => {
    await fs.rm(paprHome, { recursive: true, force: true });
  });

  it("registers and looks up turso short name entries", () => {
    registerSharedPrimaryTursoEntries(
      [
        {
          tursoShortName: "d-abc12345",
          namespaceId: "ns-publisher",
          slug: "team-app",
          publisherUserId: "owner-1",
          localAppId: "app-local-1",
          shareToken: "tok-abc",
        },
      ],
      paprHome,
    );

    const entry = lookupSharedPrimaryTursoEntry("d-abc12345", paprHome);
    expect(entry).toEqual({
      namespaceId: "ns-publisher",
      slug: "team-app",
      publisherUserId: "owner-1",
      localAppId: "app-local-1",
      shareToken: "tok-abc",
    });

    const storePath = resolveSharedPrimaryTursoStorePath(paprHome);
    expect(loadSharedPrimaryTursoStore(paprHome).databases["d-abc12345"]).toBeDefined();
    expect(storePath).toContain(".shared-primary-turso.json");
  });
});

describe("fetchInstallDbTursoCredentials", () => {
  beforeEach(() => {
    cloudApiFetch.mockReset();
    getPaprApiKey.mockReset();
    getPaprApiKey.mockResolvedValue("sk-test");
  });

  it("calls install db-token endpoint and returns Turso credentials", async () => {
    cloudApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        tursoUrl: "https://turso.example.com",
        authToken: "jwt-token",
        expiresAt: "2026-01-01T00:00:00Z",
      }),
    });

    const { fetchInstallDbTursoCredentials } = await import(
      "../src/gateway/services/cloudInstallTursoCredentials.js"
    );

    const result = await fetchInstallDbTursoCredentials({
      namespaceId: "ns-publisher",
      slug: "team-app",
      tursoShortName: "d-abc12345",
      shareToken: "tok-abc",
    });

    expect(result.creds).toEqual({
      tursoUrl: "https://turso.example.com",
      authToken: "jwt-token",
    });
    expect(result.expiresAt).toBe("2026-01-01T00:00:00Z");
    expect(cloudApiFetch).toHaveBeenCalledWith(
      "/v1/cloud/apps/install/db-token",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          namespaceId: "ns-publisher",
          slug: "team-app",
          database: "d-abc12345",
          shareToken: "tok-abc",
        }),
      }),
    );
  });
});

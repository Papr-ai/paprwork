import { describe, expect, it, vi } from "vitest";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";
import {
  resolveTursoActingUserId,
  resolveTursoActingUserIdForSource,
} from "../src/gateway/services/appRuntime/tursoRuntimeIdentity.js";

vi.mock("../src/gateway/services/DatabaseRegistryService.js", () => ({
  getDatabaseRegistryService: vi.fn(),
}));

import { getDatabaseRegistryService } from "../src/gateway/services/DatabaseRegistryService.js";

const publisher = "pub-11111111-2222-3333-4444-555555555555";
const caller = "call-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const source: AppDataSource = {
  id: "db-1:main",
  type: "sqlite",
  dbId: "db-abcdef12",
  alias: "main",
  dbPath: "/tmp/data.db",
  tables: [],
  linkedAt: "2026-01-01T00:00:00.000Z",
  role: "primary",
};

describe("resolveTursoActingUserId", () => {
  it("uses publisher for shared isolation", () => {
    expect(
      resolveTursoActingUserId("shared", {
        publisherUserId: publisher,
        callerUserId: caller,
      }),
    ).toBe(publisher);
  });

  it("uses caller for per-user isolation", () => {
    expect(
      resolveTursoActingUserId("per-user", {
        publisherUserId: publisher,
        callerUserId: caller,
      }),
    ).toBe(caller);
  });

  it("requires sign-in for per-user when caller missing", () => {
    expect(() =>
      resolveTursoActingUserId("per-user", { publisherUserId: publisher }),
    ).toThrow(/Sign in required/);
  });
});

describe("resolveTursoActingUserIdForSource", () => {
  it("reads isolation from registry record", () => {
    vi.mocked(getDatabaseRegistryService).mockReturnValue({
      getRecordForSource: () => ({
        dbId: "db-abcdef12",
        isolation: "per-user",
      }),
    } as ReturnType<typeof getDatabaseRegistryService>);

    expect(
      resolveTursoActingUserIdForSource(source, {
        publisherUserId: publisher,
        callerUserId: caller,
      }),
    ).toBe(caller);
  });

  it("defaults to shared when no registry record", () => {
    vi.mocked(getDatabaseRegistryService).mockReturnValue({
      getRecordForSource: () => undefined,
    } as ReturnType<typeof getDatabaseRegistryService>);

    expect(
      resolveTursoActingUserIdForSource(source, {
        publisherUserId: publisher,
        callerUserId: caller,
      }),
    ).toBe(publisher);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DestructiveChangeError,
  resolveCloudChangeRequest,
} from "../../../ui/utils/cloudChangeRequestsApi";

function reply(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

describe("Accept with a destructive change (plan step 6)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces the server's list as a DestructiveChangeError, not a generic failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply(409, {
          detail: {
            code: "destructive_change",
            message: "Confirm first: This change can delete or overwrite the team's data",
            destructiveChanges: ["0010_drop: deletes column body from notes"],
          },
        }),
      ),
    );
    const err = await resolveCloudChangeRequest("r1", "approve").catch((e) => e);
    expect(err).toBeInstanceOf(DestructiveChangeError);
    expect((err as DestructiveChangeError).changes).toEqual([
      "0010_drop: deletes column body from notes",
    ]);
  });

  it("sends confirmDestructive only on an approve the owner confirmed", async () => {
    const fetchMock = vi.fn(async () => reply(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    await resolveCloudChangeRequest("r1", "approve");
    await resolveCloudChangeRequest("r1", "approve", { confirmDestructive: true });
    await resolveCloudChangeRequest("r1", "reject", { confirmDestructive: true });
    const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls[0]).toMatch(/\/r1\/approve$/);
    expect(urls[1]).toMatch(/\/r1\/approve\?confirmDestructive=true$/);
    expect(urls[2]).toMatch(/\/r1\/reject$/);
  });

  it("other refusals stay plain errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply(409, { detail: { code: "database_rejected", message: "Applied migrations can't be edited" } }),
      ),
    );
    const err = await resolveCloudChangeRequest("r1", "approve").catch((e) => e);
    expect(err).not.toBeInstanceOf(DestructiveChangeError);
    expect(String(err.message)).toContain("can't be edited");
  });
});

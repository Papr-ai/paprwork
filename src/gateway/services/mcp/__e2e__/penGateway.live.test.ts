/**
 * Desktop gateway ↔ memory branch (localhost:5002), no mocks on the network path:
 * real cloudApiFetch → real /v1/cloud/connections/policy → real createPenGate decision.
 */
import { describe, expect, it, vi } from "vitest";

// Only the login lookup is stubbed: everything after it (HTTP, memory server, Mongo, gate) is real.
vi.mock("../../../utils/keyResolver.js", () => ({ getPaprApiKey: async () => process.env.TEST_X_USER_API_KEY }));
import { cloudApiFetch } from "../../../utils/cloudApiClient.js";
import { clearOrgPolicyCache, getOrgPolicy } from "../mcpOrgPolicy.js";
import { createPenGate } from "../mcpPenGate.js";

const key = process.env.TEST_X_USER_API_KEY!;
const patch = (body: unknown) => cloudApiFetch("/v1/cloud/connections/policy", { method: "PATCH", body, apiKey: key });

// Live only: needs a memory server (PAPR_MEMORY_SERVER_URL) and TEST_X_USER_API_KEY. Skipped in CI.
const live = Boolean(process.env.TEST_X_USER_API_KEY && process.env.PAPR_MEMORY_SERVER_URL);

describe.skipIf(!live)("gateway ↔ memory: org cap enforced on tool calls", () => {
  it("org maxPenAccess=read blocks a change even when the key says full", async () => {
    expect((await patch({ maxPenAccess: "read" })).status).toBe(200);
    try {
      clearOrgPolicyCache();
      const { policy } = await getOrgPolicy(true);
      expect(policy?.maxPenAccess).toBe("read");
      const gate = createPenGate({
        keyLevel: async () => "full",
        orgMax: async () => (await getOrgPolicy()).policy?.maxPenAccess,
        serverName: () => "Linear",
        ask: async () => true,
      });
      await expect(gate("linear", "list_issues", { readOnlyHint: true })).resolves.toBeUndefined();
      await expect(gate("linear", "create_issue", undefined)).rejects.toThrow(/Read only/);
    } finally {
      await patch({ maxPenAccess: "full" });
    }
  }, 60_000);
});

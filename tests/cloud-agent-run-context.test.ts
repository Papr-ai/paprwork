import { describe, expect, it } from "vitest";
import { resolveTursoBookendTargets } from "../src/gateway/services/cloudAgentGateway/cloudAgentRunContext.js";
import type { CloudAgentRunRequest } from "../src/gateway/services/cloudAgentGateway/types.js";

describe("resolveTursoBookendTargets", () => {
  it("includes running jobId on writeDbIds targets for SSE notify", () => {
    const paprHome =
      "/tmp/papr-cloud-run/abc/Papr/orgs/org1/namespaces/ns1";
    const request: CloudAgentRunRequest = {
      jobId: "51abf434-1d0f-4f14-8111-fabe8eedf224",
      runId: "run-1",
      llmAuth: { provider: "anthropic", token: "test", authType: "apiKey" },
      tursoSources: [
        {
          syncKey: "db-2d6b4294",
          dbPath:
            "/Users/me/Papr/orgs/org1/namespaces/ns1/data/databases/gtm-foundations-audit/data.db",
          databaseUrl: "libsql://d-2d6b4294.turso.io",
          authToken: "jwt",
        },
      ],
    };

    const targets = resolveTursoBookendTargets(request, paprHome);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.syncKey).toBe("db-2d6b4294");
    expect(targets[0]?.dbId).toBe("db-2d6b4294");
    expect(targets[0]?.jobId).toBe("51abf434-1d0f-4f14-8111-fabe8eedf224");
    expect(targets[0]?.dbPath).toBe(
      `${paprHome}/data/databases/gtm-foundations-audit/data.db`,
    );
  });
});

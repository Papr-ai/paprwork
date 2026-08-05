import { describe, expect, it } from "vitest";
import path from "path";
import { rewritePaprPathForCloudRun } from "../src/gateway/services/cloudAgentGateway/cloudPaprPath.js";

describe("rewritePaprPathForCloudRun", () => {
  it("rewrites absolute Papr paths into cloned workspace", () => {
    const paprHome = "/tmp/papr-cloud-run/abc/Papr";
    const input = "/Users/me/Papr/data/databases/crm/data.db";
    expect(rewritePaprPathForCloudRun(input, paprHome)).toBe(
      path.join(paprHome, "data/databases/crm/data.db"),
    );
  });

  it("rewrites Jobs-relative paths", () => {
    const paprHome = "/tmp/papr-cloud-run/abc/Papr";
    expect(rewritePaprPathForCloudRun("Jobs/job-1/data/data.db", paprHome)).toBe(
      path.join(paprHome, "Jobs/job-1/data/data.db"),
    );
  });

  it("avoids double org/namespace prefix when paprHome is namespace root", () => {
    const paprHome =
      "/tmp/papr-cloud-run/abc/Papr/orgs/org1/namespaces/ns1";
    const input =
      "/Users/me/Papr/orgs/org1/namespaces/ns1/data/databases/gtm-audit/data.db";
    expect(rewritePaprPathForCloudRun(input, paprHome)).toBe(
      path.join(paprHome, "data/databases/gtm-audit/data.db"),
    );
  });
});

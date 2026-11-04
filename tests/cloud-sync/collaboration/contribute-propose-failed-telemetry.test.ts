/**
 * A proposal that fails on the desktop reports paprwork_cloud_propose_failed
 * with the step and a stable code, so a stuck "preparing" proposal can be
 * explained (Adam, Trivalence SPICED Academy, v2.7.5: prepare 200, then no
 * submit and no error anywhere we could see).
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let appsRoot = "";
const cloudApiFetch = vi.fn();
const track = vi.fn();

vi.mock("../../../src/core/utils/paprRoot.js", () => ({
  getPaprAppsRoot: () => appsRoot,
  getPaprRoot: () => path.dirname(appsRoot),
}));
vi.mock("../../../src/gateway/utils/cloudApiClient.js", () => ({
  cloudApiFetch: (...args: unknown[]) => cloudApiFetch(...args),
}));
vi.mock("../../../src/gateway/utils/paprUserId.js", () => ({
  getPaprCallerIdentity: () => ({ userId: "u1" }),
}));
vi.mock("../../../src/gateway/services/gatewayTelemetry.js", () => ({
  getGatewayTelemetry: () => ({ track: (...a: unknown[]) => Promise.resolve(track(...a)) }),
}));

const { getCloudAppContributeService } = await import(
  "../../../src/gateway/services/CloudAppContributeService.js"
);
const { classifyProposeError, scrubProposeErrorMessage } = await import(
  "../../../src/gateway/services/cloudSync/proposeFailureTelemetry.js"
);

const APP_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(async () => {
  appsRoot = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "contrib-telem-")), "apps");
  await fs.mkdir(path.join(appsRoot, APP_ID), { recursive: true });
  await fs.writeFile(
    path.join(appsRoot, APP_ID, "papr-cloud-lineage.json"),
    JSON.stringify({ lineageId: "lin-1" }),
  );
});

afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(path.dirname(appsRoot), { recursive: true, force: true });
});

const propose = (publishNow = false) =>
  getCloudAppContributeService().propose({
    installedAppId: APP_ID,
    sourceNamespaceId: "ns",
    sourceSlug: "slug",
    title: "t",
    description: "d",
    publishNow,
  } as never);

describe("propose() failure telemetry", () => {
  it("prepare failing reports step=prepare with the HTTP status", async () => {
    cloudApiFetch.mockResolvedValue(new Response("nope", { status: 503 }));
    await expect(propose(true)).rejects.toThrow(/Prepare contribute failed \(503\)/);
    expect(track).toHaveBeenCalledTimes(1);
    const [event, props] = track.mock.calls[0]!;
    expect(event).toBe("paprwork_cloud_propose_failed");
    expect(props).toMatchObject({
      step: "prepare",
      error_code: "prepare_http",
      http_status: 503,
      publish_now: true,
      installed_app_id: APP_ID,
    });
    expect(props.request_id).toBeUndefined();
  });

  it("a failure after prepare carries the request id and step=push", async () => {
    // Prepare succeeds with a clone URL that can't be reached, so the push
    // step throws (the case that left Adam's proposals in "preparing").
    cloudApiFetch.mockImplementation(async (url: string) => {
      if (url === "/v1/cloud/apps/changes/prepare") {
        return new Response(
          JSON.stringify({
            id: "req-1",
            targetAppId: "22222222-2222-4222-8222-222222222222",
            cloneUrl: "file:///nonexistent/repo.git",
            token: "ghs_secret",
            branch: "contrib/x/req-1",
            repoPath: "",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    await expect(propose()).rejects.toThrow();
    const props = track.mock.calls[0]![1];
    expect(props).toMatchObject({ step: "push", request_id: "req-1", publish_now: false });
    expect(JSON.stringify(props)).not.toContain("ghs_secret");
  });

  it("telemetry throwing never replaces the real error", async () => {
    track.mockImplementation(() => {
      throw new Error("telemetry down");
    });
    cloudApiFetch.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(propose()).rejects.toThrow(/Prepare contribute failed \(500\)/);
  });
});

describe("classifyProposeError", () => {
  it.each([
    [Object.assign(new Error("overlap"), { code: "contribute_conflicts" }), "contribute_conflicts"],
    [new Error("No changes to contribute — your copy matches the publisher's"), "no_changes"],
    [new Error("Couldn't tell which version of the publisher's app this copy is based on."), "base_unknown"],
    [new Error("Command timed out after 180000ms"), "timeout"],
    [new Error("fatal: unable to access repo"), "git_error"],
    [new Error("Submit contribute failed (502): GitHub returned 403"), "submit_http"],
    [new Error("something else"), "unknown"],
  ])("%s → %s", (err, code) => {
    expect(classifyProposeError(err).code).toBe(code);
  });
});

describe("scrubProposeErrorMessage", () => {
  it("removes URLs and GitHub tokens and caps length", () => {
    const out = scrubProposeErrorMessage(
      "fatal: could not push to https://x-access-token:ghs_abc123@github.com/o/r.git ghp_zzz " + "x".repeat(400),
    );
    expect(out).not.toMatch(/ghs_|ghp_|github\.com/);
    expect(out).toContain("<url>");
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

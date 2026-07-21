import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  getPaprDataDir,
  getPaprJobsRoot,
  getPaprRoot,
  isCloudAgentGatewayMode,
} from "../src/core/utils/paprRoot.js";

describe("cloud agent gateway path resolution", () => {
  const previousPaprHome = process.env.PAPR_HOME;
  const previousGatewayMode = process.env.GATEWAY_MODE;
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "papr-cloud-path-"));
    process.env.PAPR_HOME = path.join(tempRoot, "Papr");
    await fs.mkdir(path.join(process.env.PAPR_HOME, "Jobs", "job-1", "data"), {
      recursive: true,
    });
    await fs.mkdir(path.join(process.env.PAPR_HOME, "data"), { recursive: true });
    await fs.writeFile(
      path.join(process.env.PAPR_HOME, "data", "jobs.json"),
      "[]",
      "utf8",
    );
  });

  afterEach(async () => {
    if (previousPaprHome === undefined) delete process.env.PAPR_HOME;
    else process.env.PAPR_HOME = previousPaprHome;
    if (previousGatewayMode === undefined) delete process.env.GATEWAY_MODE;
    else process.env.GATEWAY_MODE = previousGatewayMode;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("uses PAPR_HOME for Jobs and data paths", () => {
    expect(getPaprRoot()).toBe(process.env.PAPR_HOME);
    expect(getPaprJobsRoot()).toBe(path.join(process.env.PAPR_HOME!, "Jobs"));
    expect(getPaprDataDir()).toBe(path.join(process.env.PAPR_HOME!, "data"));
  });

  it("detects cloud agent gateway mode", () => {
    process.env.GATEWAY_MODE = "cloud_agent";
    expect(isCloudAgentGatewayMode()).toBe(true);
    delete process.env.GATEWAY_MODE;
    expect(isCloudAgentGatewayMode()).toBe(false);
  });
});

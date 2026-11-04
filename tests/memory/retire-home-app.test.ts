/**
 * The Home dashboard app is retired. Boot takes it off the device and keeps the Focus data:
 * the Focus DB must lose Home's schema ownership BEFORE the app goes, or deleting it tombstones the DB.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("Home app is retired", () => {
  it("is no longer bundled or installed on boot", () => {
    expect(existsSync(join(root, "src/resources/default-apps/home-dashboard"))).toBe(false);
    const apps = read("src/gateway/services/AppService.ts");
    expect(apps).not.toMatch(/installDefaultApps|repairHomeAndWorkspaceOnStartup|ensureHomeDailyBriefReady|defaultHomeBundle/);
    expect(read("src/gateway/services/JobsService.ts")).not.toMatch(/syncHomeDailyBriefFromBundle|repairHomeAndWorkspaceOnStartup/);
  });

  it("releases the Focus DB, re-links Focus jobs, then removes the app without tombstoning anything", () => {
    const src = read("src/gateway/services/retireHomeApp.ts");
    const jobs = src.indexOf("ensureFocusSystemJobs()"), release = src.indexOf("releaseSchemaOwner("), remove = src.indexOf("removeRetiredApp(");
    expect(jobs).toBeGreaterThan(0);
    expect(release).toBeGreaterThan(jobs);
    expect(remove).toBeGreaterThan(release);
    expect(src).toMatch(/isCloudAgentGatewayMode\(\)\) return false/);
    const apps = read("src/gateway/services/AppService.ts");
    const fn = apps.slice(apps.indexOf("async removeRetiredApp("), apps.indexOf("async copyAppToNamespace("));
    expect(fn).toMatch(/skipSchemaOwnerRegistryTombstone: true/);
    expect(fn).toMatch(/backups", "retired-apps"/);
    expect(fn).not.toMatch(/deleteJob|tombstone\(/);
  });

  it("boot calls it in place of the old Home repair", () => {
    const boot = read("src/gateway/services/jobs/deferredStartupBootstrap.ts");
    expect(boot).toMatch(/retireHomeApp\(\)/);
    expect(boot).not.toMatch(/repairHomeAndWorkspaceOnStartup|installPendingDefaultJobs/);
  });
});

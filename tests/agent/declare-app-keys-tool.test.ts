import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { useIsolatedPaprWorkspace } from "../setup/isolatedWorkspace.js";

describe("declare_app_keys tool", () => {
  useIsolatedPaprWorkspace("papr-declare-keys");

  it("reports undeclared keys, then writes declarations and notKeys", async () => {
    const { getPaprRoot } = await import("../../src/core/utils/paprRoot.js");
    const root = getPaprRoot();
    expect(root).not.toContain(`${path.sep}Papr${path.sep}orgs${path.sep}Y8D4H7Yp3Z`);
    fs.mkdirSync(path.join(root, "apps", "app-1"), { recursive: true });
    fs.mkdirSync(path.join(root, "Jobs", "job-1"), { recursive: true });
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "jobs.json"), JSON.stringify({ jobs: [{ id: "job-1", appIds: ["app-1"] }] }));
    fs.writeFileSync(
      path.join(root, "Jobs", "job-1", "job.json"),
      JSON.stringify({ id: "job-1", command: 'python3 run.py "${TASK}" "${PROMO_SECRET}"' }),
    );

    const { declareAppKeysTool } = await import("../../src/core/tools/appKeys.js");
    const exec = (args: unknown) =>
      (declareAppKeysTool as unknown as { execute: (a: unknown) => Promise<any> }).execute(args);

    const before = await exec({ appId: "app-1", keys: [], notKeys: [] });
    expect(before.data.readyToPublish).toBe(false);
    expect(before.data.stillUndeclared.map((k: { name: string }) => k.name)).toEqual(["PROMO_SECRET", "TASK"]);

    const after = await exec({
      appId: "app-1",
      keys: [{ name: "PROMO_SECRET", purpose: "Signs promo codes", provider: "owner", required: true }],
      notKeys: ["TASK"],
    });
    expect(after.data.readyToPublish).toBe(true);
    const file = JSON.parse(fs.readFileSync(path.join(root, "apps", "app-1", "requirements.json"), "utf8"));
    expect(file.notKeys).toEqual(["TASK"]);
    expect(file.requirements[0]).toMatchObject({ name: "PROMO_SECRET", credentialScope: "owner" });
  });
});

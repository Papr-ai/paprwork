/**
 * AuthFlow must call the same hooks on every render. A useEffect placed after
 * conditional returns breaks when stage switches to `org` (common for new users).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const authFlowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../ui/components/Auth/AuthFlow.tsx",
);

const paprLoginPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/electron/ipc/paprLogin.ts",
);

describe("AuthFlow hooks invariant", () => {
  it("declares all useEffect hooks before any stage branch return", () => {
    const source = readFileSync(authFlowPath, "utf8");
    const fnStart = source.indexOf("export function AuthFlow");
    expect(fnStart).toBeGreaterThan(-1);

    const body = source.slice(fnStart);
    const firstStageBranch = body.search(/\n  if \(stage === "/);
    expect(firstStageBranch).toBeGreaterThan(-1);

    const lastUseEffect = body.lastIndexOf("useEffect(");
    expect(lastUseEffect).toBeGreaterThan(-1);
    expect(lastUseEffect).toBeLessThan(firstStageBranch);
  });

  it("shows a loading shell when org stage lacks setupRequest", () => {
    const source = readFileSync(authFlowPath, "utf8");
    expect(source).toContain('stage === "org" && !setupRequest');
    expect(source).toContain("Preparing your organization setup");
  });

  it("routes deferred Parse provisioning to manual org setup before auto finalize", () => {
    const source = readFileSync(paprLoginPath, "utf8");
    const deferredIdx = source.indexOf("if (isProvisioningDeferred(plan))");
    expect(deferredIdx).toBeGreaterThan(-1);
    const notifyIdx = source.indexOf("notifySetupRequired", deferredIdx);
    expect(notifyIdx).toBeGreaterThan(deferredIdx);
    const finalizeIdx = source.indexOf(
      "return await finalizeLoginWithProvisioning",
      deferredIdx,
    );
    expect(finalizeIdx).toBeGreaterThan(notifyIdx);
  });
});

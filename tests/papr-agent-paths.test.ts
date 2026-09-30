import os from "os";
import path from "path";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/core/utils/paprWorkspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/utils/paprWorkspace.js")>();
  return {
    ...actual,
    readActiveWorkspacePointer: vi.fn(),
    getPaprBaseDir: vi.fn(() => path.join(os.homedir(), "Papr")),
  };
});

import { readActiveWorkspacePointer } from "../src/core/utils/paprWorkspace.js";
import {
  formatPaprPathForAgent,
  getLegacyPaprMisrouteBlockReason,
  isPaprAppsOrJobsSearchPath,
  parseMiniAppIdFromAgentPath,
  resolvePaprAgentPath,
} from "../src/core/utils/paprAgentPaths.js";

const home = os.homedir();
const legacyBase = path.join(home, "Papr");
const activeHome = path.join(
  home,
  "Papr/orgs/org-1/namespaces/ns-1",
);

describe("paprAgentPaths", () => {
  afterEach(() => {
    vi.mocked(readActiveWorkspacePointer).mockReset();
  });

  test("resolvePaprAgentPath rewrites legacy ~/Papr/apps to active apps root", () => {
    vi.mocked(readActiveWorkspacePointer).mockReturnValue({
      organizationId: "org-1",
      namespaceId: "ns-1",
      paprHome: activeHome,
      userDataPath: path.join(home, ".paprwork-v2/orgs/org-1/namespaces/ns-1"),
      activatedAt: new Date().toISOString(),
    });

    const legacy = path.join(legacyBase, "apps", "app-123", "app.ts");
    const resolved = resolvePaprAgentPath(`~/Papr/apps/app-123/app.ts`);

    expect(resolved).toBe(path.join(activeHome, "apps", "app-123", "app.ts"));
    expect(resolved).not.toBe(legacy);
  });

  test("getLegacyPaprMisrouteBlockReason blocks write to flat ~/Papr/apps", () => {
    vi.mocked(readActiveWorkspacePointer).mockReturnValue({
      organizationId: "org-1",
      namespaceId: "ns-1",
      paprHome: activeHome,
      userDataPath: path.join(home, ".paprwork-v2/orgs/org-1/namespaces/ns-1"),
      activatedAt: new Date().toISOString(),
    });

    const legacyFile = path.join(legacyBase, "apps", "app-123", "style.css");
    const reason = getLegacyPaprMisrouteBlockReason(legacyFile);

    expect(reason).toContain("Legacy path");
    expect(reason).toContain("edit_app_file");
    expect(reason).toContain("app-123");
  });

  test("formatPaprPathForAgent uses ~ prefix", () => {
    expect(formatPaprPathForAgent(path.join(activeHome, "apps"))).toBe(
      "~/Papr/orgs/org-1/namespaces/ns-1/apps",
    );
  });

  test("isPaprAppsOrJobsSearchPath matches org/namespace and legacy paths", () => {
    expect(isPaprAppsOrJobsSearchPath("~/Papr/apps/foo/")).toBe(true);
    expect(
      isPaprAppsOrJobsSearchPath(
        "~/Papr/orgs/org-1/namespaces/ns-1/apps/foo/",
      ),
    ).toBe(true);
    expect(
      isPaprAppsOrJobsSearchPath(
        "~/Papr/orgs/org-1/namespaces/ns-1/Jobs/job-1/",
      ),
    ).toBe(true);
    expect(isPaprAppsOrJobsSearchPath("~/Documents/project")).toBe(false);
  });

  test("parseMiniAppIdFromAgentPath supports org/namespace layout", () => {
    expect(
      parseMiniAppIdFromAgentPath(
        "~/Papr/orgs/org-1/namespaces/ns-1/apps/app-123/index.html",
      ),
    ).toBe("app-123");
  });

  test("parseMiniAppIdFromAgentPath supports $PAPR_HOME shorthand", () => {
    expect(
      parseMiniAppIdFromAgentPath(
        "$PAPR_HOME/apps/aa07a65e-147f-480b-b287-79ce016acab9/data-sources.json",
      ),
    ).toBe("aa07a65e-147f-480b-b287-79ce016acab9");
  });
});

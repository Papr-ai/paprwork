import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildBackendActionEnv } from "../../../src/gateway/services/appRuntime/appBackendRunner.js";
import { checkMiniAppTableAcl } from "../../../src/gateway/utils/miniAppTableAclLint.js";

describe("row ACL: role / team principals and segment filter", () => {
  it("python helper enforces role, team and segment scopes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "papr-acl-roles-"));
    try {
      copyFileSync(
        path.resolve("src/gateway/services/appRuntime/backendDbHelper.py"),
        path.join(dir, "papr_db.py"),
      );
      const out = execFileSync(
        "python3",
        [path.resolve("tests/fixtures/acl/acl_principals_check.py"), dir],
        { encoding: "utf8" },
      );
      expect(out).toContain("principals acl ok");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("injects role/team only for a verified signed-in caller", () => {
    const env = buildBackendActionEnv({
      appId: "a",
      action: "x",
      params: { PAPR_CALLER_ROLE: "admin", PAPR_CALLER_TEAM_MEMBER: "1" },
      callerIdentity: { userId: "u1" },
      callerAccess: { role: "contributor", teamMember: false },
      loggedIn: true,
    });
    expect(env.PAPR_CALLER_ROLE).toBe("contributor");
    expect(env.PAPR_CALLER_TEAM_MEMBER).toBeUndefined();

    const anon = buildBackendActionEnv({
      appId: "a",
      action: "x",
      callerAccess: { role: "admin", teamMember: true },
      loggedIn: false,
    });
    expect(anon.PAPR_CALLER_ROLE).toBeUndefined();
    expect(anon.PAPR_CALLER_TEAM_MEMBER).toBeUndefined();

    const bogus = buildBackendActionEnv({
      appId: "a",
      action: "x",
      callerIdentity: { userId: "u1" },
      callerAccess: { role: "owner" },
      loggedIn: true,
    });
    expect(bogus.PAPR_CALLER_ROLE).toBeUndefined();
  });

  it("lint accepts acl_segment_filter as a row filter", () => {
    const issues = checkMiniAppTableAcl(
      new Map([[
        "backend/list.py",
        'w,a=acl_segment_filter("standup_id","standup_participants","standup_id")\nquery(con, f"SELECT * FROM topics WHERE {w}", a)',
      ]]),
      new Set(["topics"]),
    );
    expect(issues).toEqual([]);
  });
});

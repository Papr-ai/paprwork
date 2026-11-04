/**
 * Focus data is native: services reach the Focus DB directly, never through /api/db/* with
 * the Home app id, so Focus works with no Home app installed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FOCUS_DB_SCOPE, FOCUS_DB_SLUG, focusDbPath } from "../../src/gateway/services/focusDb.js";

const root = join(__dirname, "..", "..");
const services = join(root, "src", "gateway", "services");
const FOCUS_SERVICES = ["goalsStore.ts", "workspaceTasks.ts", "goalsTasksProjection.ts", "focusCloud/focusCloudSync.ts"];

describe("Focus DB is native", () => {
  it("keeps the existing file so nobody's data moves", () => {
    expect(FOCUS_DB_SLUG).toBe("home-daily-briefs");
    expect(focusDbPath("/x/data")).toBe(join("/x/data", "databases", "home-daily-briefs", "data.db"));
  });

  it("is not scoped to an app id", () => {
    expect(FOCUS_DB_SCOPE).not.toMatch(/^[0-9a-f]{8}-/);
  });

  it.each(FOCUS_SERVICES)("%s has no Home app id and no /api/db loopback", (file) => {
    const src = readFileSync(join(services, file), "utf8");
    expect(src).not.toContain("DEFAULT_HOME_APP_ID");
    expect(src).not.toMatch(/\/api\/db\//);
    expect(src).toMatch(/focusDb\.js/);
  });

  it("ships the schema with Papr Work, same files as the Home bundle had", () => {
    const native = readdirSync(join(root, "src", "resources", "focus", "db-migrations")).sort();
    const home = readdirSync(join(root, "src", "resources", "default-apps", "home-dashboard", "db-migrations")).sort();
    expect(native).toEqual(home);
    for (const f of native) {
      expect(readFileSync(join(root, "src", "resources", "focus", "db-migrations", f), "utf8")).toBe(
        readFileSync(join(root, "src", "resources", "default-apps", "home-dashboard", "db-migrations", f), "utf8"),
      );
    }
  });
});

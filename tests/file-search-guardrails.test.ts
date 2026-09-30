import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/core/utils/paprRoot.js", () => ({
  getPaprRoot: () => "/tmp/papr-home",
  getPaprAppsRoot: () => "/tmp/papr-home/apps",
  getPaprJobsRoot: () => "/tmp/papr-home/Jobs",
}));

import {
  assessPaprSearchScope,
  SEARCH_SKIP_DIR_NAMES,
} from "../src/core/tools/fileSearch.js";

describe("assessPaprSearchScope", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("blocks searching entire Papr home without appId", () => {
    const result = assessPaprSearchScope("/tmp/papr-home");
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.error).toContain("search_app_files");
  });

  it("auto-scopes Papr home to one app when appId provided", () => {
    const appId = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
    const result = assessPaprSearchScope("/tmp/papr-home", appId);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(`/tmp/papr-home/apps/${appId}`);
    expect(result.autoScoped).toBe(true);
  });

  it("blocks searching all apps root", () => {
    const result = assessPaprSearchScope("/tmp/papr-home/apps");
    expect(result.blocked).toBe(true);
  });

  it("blocks searching all jobs root", () => {
    const result = assessPaprSearchScope("/tmp/papr-home/Jobs");
    expect(result.blocked).toBe(true);
    expect(result.error).toContain("search_agent_memory");
  });

  it("allows search inside one app directory", () => {
    const appId = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
    const result = assessPaprSearchScope(
      `/tmp/papr-home/apps/${appId}/src`,
    );
    expect(result.ok).toBe(true);
    expect(result.blocked).toBeUndefined();
  });

  it("skips heavy dependency directories during walk", () => {
    expect(SEARCH_SKIP_DIR_NAMES.has("node_modules")).toBe(true);
    expect(SEARCH_SKIP_DIR_NAMES.has(".git")).toBe(true);
    expect(SEARCH_SKIP_DIR_NAMES.has("venv")).toBe(true);
  });
});

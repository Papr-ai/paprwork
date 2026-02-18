import { describe, expect, test } from "vitest";
import { getAllToolIds } from "../src/core/tools/index.js";

describe("App/Jobs tool registry", () => {
  test("registers app and job orchestration tools", () => {
    const ids = getAllToolIds();
    expect(ids).toContain("create_app");
    expect(ids).toContain("create_job");
    expect(ids).toContain("run_job");
    expect(ids).toContain("read_job_logs");
    expect(ids).toContain("link_app_data_source");
    expect(ids).toContain("read_app_data_sources");
  });
});

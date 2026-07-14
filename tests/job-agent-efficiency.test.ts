import { describe, expect, it } from "vitest";
import { coerceAppIdsValue } from "../src/core/utils/coerceAppIds.js";
import { isJobsIndexBashWriteBlocked } from "../src/core/utils/jobsIndexBashGuard.js";
import { buildPostEditSnippet } from "../src/core/utils/postEditSnippet.js";

describe("coerceAppIdsValue", () => {
  const appId = "8d8e93c7-cdef-4167-8316-b4d6ee79a9a6";

  it("passes through arrays", () => {
    expect(coerceAppIdsValue([appId])).toEqual([appId]);
  });

  it("parses JSON string arrays", () => {
    expect(coerceAppIdsValue(`["${appId}"]`)).toEqual([appId]);
  });

  it("wraps a single UUID string", () => {
    expect(coerceAppIdsValue(appId)).toEqual([appId]);
  });

  it("accepts standalone sentinel", () => {
    expect(coerceAppIdsValue("__standalone__")).toEqual(["__standalone__"]);
  });
});

describe("isJobsIndexBashWriteBlocked", () => {
  it("blocks jq writes to jobs.json", () => {
    expect(
      isJobsIndexBashWriteBlocked(
        `jq '. + [{id:"x"}]' ~/Papr/data/jobs.json > ~/Papr/data/jobs.json.tmp`,
      ),
    ).toBe(true);
  });

  it("allows read-only cat", () => {
    expect(
      isJobsIndexBashWriteBlocked("cat ~/Papr/data/jobs.json | head"),
    ).toBe(false);
  });

  it("allows jq read without redirect", () => {
    expect(
      isJobsIndexBashWriteBlocked(
        `jq '.[] | select(.id=="abc")' ~/Papr/data/jobs.json`,
      ),
    ).toBe(false);
  });
});

describe("buildPostEditSnippet", () => {
  it("returns full content for small files", () => {
    const content = "line one\nline two\n";
    const result = buildPostEditSnippet(content, { focusLine: 2 });
    expect(result.postEditSnippet).toBe(content);
    expect(result.snippetTruncated).toBe(false);
  });

  it("centers snippet around focus line for large files", () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `// line ${i + 1} ${"x".repeat(40)}`,
    );
    const content = lines.join("\n");
    const result = buildPostEditSnippet(content, { focusLine: 200 });
    expect(result.snippetTruncated).toBe(true);
    expect(result.postEditSnippet).toContain("line 200");
    expect(result.totalLines).toBe(400);
  });
});

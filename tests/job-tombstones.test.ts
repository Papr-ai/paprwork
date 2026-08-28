import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  addJobTombstones,
  readJobTombstones,
} from "../src/gateway/services/jobs/jobTombstones.js";

describe("jobTombstones", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("adds and reads removed job ids", async () => {
    const paprDir = join(tmpdir(), `papr-tombstones-${Date.now()}`);
    mkdirSync(join(paprDir, "data"), { recursive: true });
    dirs.push(paprDir);

    await addJobTombstones(paprDir, ["job-a", "job-b"]);
    await addJobTombstones(paprDir, ["job-b", "job-c"]);

    const tombstones = await readJobTombstones(paprDir);
    expect(tombstones.has("job-a")).toBe(true);
    expect(tombstones.has("job-b")).toBe(true);
    expect(tombstones.has("job-c")).toBe(true);
    expect(tombstones.size).toBe(3);
  });
});

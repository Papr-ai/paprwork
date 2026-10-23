import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  addJobTombstones,
  readJobTombstones,
} from "../../../src/gateway/services/jobs/jobTombstones.js";

describe("jobTombstones", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  test("parallel adds do not collide or lose ids", async () => {
    const paprDir = join(tmpdir(), `papr-tombstones-par-${Date.now()}`);
    mkdirSync(join(paprDir, "data"), { recursive: true });
    dirs.push(paprDir);

    const ids = Array.from({ length: 12 }, (_, i) => `job-${i}`);
    await Promise.all(ids.map((id) => addJobTombstones(paprDir, [id])));

    const tombstones = await readJobTombstones(paprDir);
    expect(tombstones.size).toBe(ids.length);
  });
});

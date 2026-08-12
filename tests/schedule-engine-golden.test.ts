import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  computeFollowingNextRunAt,
  computeInitialNextRunAt,
  computeMisfireSkipNextRunAt,
} from "../src/gateway/services/jobs/scheduleEngine.js";
import type { JobSchedule } from "../src/gateway/services/jobs/types.js";

interface GoldenFixture {
  name: string;
  fn: "computeInitialNextRunAt" | "computeFollowingNextRunAt" | "computeMisfireSkipNextRunAt";
  schedule: JobSchedule;
  anchor: string;
  expectAfterAnchorMs?: number;
  expectDefined?: boolean;
  expectStrictlyAfterAnchor?: boolean;
  expectIso?: string;
}

const fixturesPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/schedule-engine-golden-fixtures.json",
);

const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8")) as GoldenFixture[];

describe("schedule-engine golden fixtures", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      const anchor = new Date(fixture.anchor);
      let result: string | undefined;
      if (fixture.fn === "computeInitialNextRunAt") {
        result = computeInitialNextRunAt(fixture.schedule, anchor);
      } else if (fixture.fn === "computeFollowingNextRunAt") {
        result = computeFollowingNextRunAt(fixture.schedule, anchor);
      } else {
        result = computeMisfireSkipNextRunAt(fixture.schedule, anchor);
      }

      if (fixture.expectDefined) {
        expect(result).toBeDefined();
      }
      if (fixture.expectIso) {
        expect(result).toBe(fixture.expectIso);
      }
      if (fixture.expectAfterAnchorMs !== undefined) {
        expect(result).toBeDefined();
        const delta =
          new Date(result!).getTime() - anchor.getTime();
        expect(delta).toBe(fixture.expectAfterAnchorMs);
      }
      if (fixture.expectStrictlyAfterAnchor) {
        expect(result).toBeDefined();
        expect(new Date(result!).getTime()).toBeGreaterThan(anchor.getTime());
      }
    });
  }
});

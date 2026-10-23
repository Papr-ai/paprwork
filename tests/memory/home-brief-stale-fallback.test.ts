import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const home = join(process.cwd(), "src/resources/default-apps/home-dashboard");

type BriefRow = { date: string; brief_json: string };

interface HomeDataApi {
  todayKey(): string;
  isBriefDateKey(date: string): boolean;
  parseBriefJson(raw: string | null | undefined): Record<string, unknown> | null;
  withBriefMeta(
    brief: Record<string, unknown>,
    briefDate: string,
  ): Record<string, unknown>;
  mostRecentBriefFromRows(rows: BriefRow[]): Record<string, unknown> | null;
  briefFromRows(rows: BriefRow[], date?: string): Record<string, unknown>;
  sample(): Record<string, unknown>;
}

function loadHomeDataApi(todayKey: string): HomeDataApi {
  const src = readFileSync(join(home, "data.js"), "utf8");
  const sandbox: {
    Data?: HomeDataApi;
    Date: DateConstructor;
  } = {
    Date: class MockDate extends Date {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (args.length === 0) {
          super(`${todayKey}T12:00:00`);
          return;
        }
        super(...args);
      }

      static now(): number {
        return new MockDate().getTime();
      }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src.replace("const Data =", "var Data ="), sandbox);
  if (!sandbox.Data) {
    throw new Error("Failed to load home dashboard Data API");
  }
  return sandbox.Data;
}

function validBrief(title: string) {
  return JSON.stringify({
    hero: { date: "Monday", title, subtitle: "subtitle", stats: [] },
    sections: [{ type: "priorities", title: "Priorities", items: [] }],
  });
}

describe("home brief stale fallback", () => {
  it("returns today's brief when present", () => {
    const Data = loadHomeDataApi("2026-09-08");
    const rows: BriefRow[] = [
      { date: "2026-09-08", brief_json: validBrief("Today") },
      { date: "2026-09-07", brief_json: validBrief("Yesterday") },
    ];
    const brief = Data.briefFromRows(rows);
    expect(brief._briefDate).toBe("2026-09-08");
    expect(brief._isStale).toBe(false);
    expect((brief.hero as { title: string }).title).toBe("Today");
  });

  it("falls back to the most recent real brief when today is missing", () => {
    const Data = loadHomeDataApi("2026-09-08");
    const rows: BriefRow[] = [
      { date: "2026-09-07", brief_json: validBrief("Yesterday") },
      { date: "2026-09-04", brief_json: validBrief("Older") },
    ];
    const brief = Data.briefFromRows(rows);
    expect(brief._isSample).toBeUndefined();
    expect(brief._isStale).toBe(true);
    expect(brief._briefDate).toBe("2026-09-07");
    expect((brief.hero as { title: string }).title).toBe("Yesterday");
  });

  it("returns sample data only when no valid briefs exist", () => {
    const Data = loadHomeDataApi("2026-09-08");
    const brief = Data.briefFromRows([]);
    expect(brief._isSample).toBe(true);
  });

  it("loads a specific historical date and marks non-today rows stale", () => {
    const Data = loadHomeDataApi("2026-09-08");
    const rows: BriefRow[] = [
      { date: "2026-09-04", brief_json: validBrief("Sept 4") },
    ];
    const brief = Data.briefFromRows(rows, "2026-09-04");
    expect(brief._briefDate).toBe("2026-09-04");
    expect(brief._isStale).toBe(true);
    expect(brief._isSample).toBeUndefined();
  });
});

describe("home dashboard stale brief UI contract", () => {
  it("app.js distinguishes sample mode from stale real brief mode", () => {
    const appJs = readFileSync(join(home, "app.js"), "utf8");
    expect(appJs).toMatch(/isStaleBrief/);
    expect(appJs).toMatch(/renderStaleBriefBanner/);
    expect(appJs).toMatch(/Today's brief isn't ready yet/);
    expect(appJs).toMatch(/testBrief\._isSample === true/);
    expect(appJs).not.toMatch(/this\.dates\.length === 0 \|\| testBrief\._isSample/);
  });
});

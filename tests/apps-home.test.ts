import { describe, expect, it } from "vitest";
import {
  dropOnItem,
  fileIntoCategory,
  moveToTopLevel,
  reconcileLayout,
  seedLayout,
  ungroupFolder,
  withoutIds,
  type HomeLayout,
} from "../ui/utils/appsHome";

const cat: Record<string, string> = { a: "Sales", b: "Sales", c: "Sales", d: "Research", e: "Other" };
const categoryOf = (id: string) => cat[id] ?? null;

describe("apps home layout", () => {
  it("seeds collections only for categories with 3+ apps", () => {
    const l = seedLayout(["a", "d", "b", "c", "e"], categoryOf);
    expect(l.order).toEqual(["f:sales", "d", "e"]);
    expect(l.folders["f:sales"]!.ids).toEqual(["a", "b", "c"]);
  });

  it("dropping an app onto an app makes a new collection in place", () => {
    const l: HomeLayout = { order: ["x", "y", "z"], folders: {} };
    const { layout, created } = dropOnItem(l, "z", "x", "into");
    expect(created).toBeTruthy();
    expect(layout.order).toEqual([created, "y"]);
    expect(layout.folders[created!]!.ids).toEqual(["x", "z"]);
  });

  it("a collection left with one app dissolves into that app", () => {
    const l: HomeLayout = { order: ["f:s", "q"], folders: { "f:s": { name: "S", ids: ["a", "b"] } } };
    const next = moveToTopLevel(l, "b");
    expect(next.order).toEqual(["a", "q", "b"]);
    expect(next.folders).toEqual({});
  });

  it("collections never nest", () => {
    const l: HomeLayout = {
      order: ["f:s", "f:t"],
      folders: { "f:s": { name: "S", ids: ["a", "b"] }, "f:t": { name: "T", ids: ["c", "d"] } },
    };
    const { layout } = dropOnItem(l, "f:t", "a", "before");
    expect(layout).toBe(l);
  });

  it("reconcile drops removed apps and puts unseen ones first", () => {
    const saved: HomeLayout = { order: ["f:s", "gone"], folders: { "f:s": { name: "S", ids: ["a", "b"] } } };
    const { layout, added } = reconcileLayout(saved, ["a", "b", "new"]);
    expect(added).toEqual(["new"]);
    expect(layout.order).toEqual(["new", "f:s"]);
  });

  it("files a new app into its category, building the collection from loose apps", () => {
    const l: HomeLayout = { order: ["n", "d", "x"], folders: {} };
    const c = (id: string) => ({ n: "Research", d: "Research" })[id] ?? null;
    const next = fileIntoCategory(l, "n", "Research", c)!;
    expect(next.order).toEqual(["f:research", "x"]);
    expect(next.folders["f:research"]!.ids).toEqual(["n", "d"]);
  });

  it("ungroup puts apps back in the collection's spot", () => {
    const l: HomeLayout = { order: ["p", "f:s", "q"], folders: { "f:s": { name: "S", ids: ["a", "b"] } } };
    expect(ungroupFolder(l, "f:s").order).toEqual(["p", "a", "b", "q"]);
  });

  it("withoutIds keeps unplaced apps out of the saved layout", () => {
    const l: HomeLayout = { order: ["n", "a"], folders: {} };
    expect(withoutIds(l, ["n"]).order).toEqual(["a"]);
  });
});

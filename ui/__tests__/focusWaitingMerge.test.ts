import { describe, expect, it } from "vitest";
import { pickWaiting, type Section } from "../components/Focus/page/brief";

const sec = (title: string, n = 1) => ({ type: "alerts", title, items: Array.from({ length: n }, (_, i) => ({ _id: `${title}${i}` })) }) as unknown as Section;

describe("pickWaiting: one Waiting on in Focus", () => {
  it("lifts the brief's Waiting On section out of the brief sections", () => {
    const { notes, sections } = pickWaiting([sec("Next actions"), sec("Waiting On", 3), sec("Intel")]);
    expect(notes?.items).toHaveLength(3);
    expect(sections.map((s) => s.title)).toEqual(["Next actions", "Intel"]);
  });
  it("leaves the brief alone when it has no Waiting on", () => {
    const all = [sec("Next actions"), sec("Waiting for approval")];
    expect(pickWaiting(all)).toEqual({ notes: null, sections: all });
  });
});

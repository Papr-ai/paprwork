import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildProposalChangeSet } from "../src/gateway/services/cloudSync/contributeChangeSet.js";
import { mergeContributeDataIndexesIntoRepo } from "../src/gateway/services/cloudSync/contributeDataIndexMerge.js";
import {
  planJobFold,
  remapJobIdsInContent,
} from "../src/gateway/services/cloudSync/contributeJobIdentity.js";
import { jobJsonForProposal } from "../src/gateway/services/cloudSync/proposalFileMerge.js";

// PR #2 on LinkedIn Outreach: the publisher's scraper is b55…; the contributor's
// copy also had a second "LinkedIn Search Scraper" (3c1…) that the app called.
const PUB = "b55ef2d4-2626-4c57-9170-2a0d6bd2bc4c";
const DUP = "3c16888c-f646-41ef-adc6-9ebb66a1114c";
const OTHER = "55e4c8e3-feaa-471d-a283-69f78dc580a2";
const NEW = "aaaaaaaa-1111-4222-8333-444444444444";

const publisherJobs = [
  { id: PUB, name: "LinkedIn Search Scraper" },
  { id: OTHER, name: "LinkedIn Reply Detector" },
];

describe("planJobFold", () => {
  it("folds a same-name duplicate the app calls onto the publisher's job", () => {
    const plan = planJobFold({
      localJobs: [
        { id: PUB, name: "LinkedIn Search Scraper" },
        { id: DUP, name: "LinkedIn Search Scraper" },
        { id: OTHER, name: "LinkedIn Reply Detector" },
      ],
      publisherJobs,
      appCode: `export const SCRAPER_JOB = '${DUP}';`,
    });
    expect([...plan.remap]).toEqual([[DUP, PUB]]);
    expect([...plan.drop]).toEqual([]);
  });

  it("leaves out a duplicate nothing calls", () => {
    const plan = planJobFold({
      localJobs: [{ id: PUB, name: "LinkedIn Search Scraper" }, { id: DUP, name: "linkedin search scraper " }],
      publisherJobs,
      appCode: `export const SCRAPER_JOB = '${PUB}';`,
    });
    expect(plan.remap.size).toBe(0);
    expect([...plan.drop]).toEqual([DUP]);
  });

  it("keeps genuinely new jobs and never folds onto an ambiguous name", () => {
    const plan = planJobFold({
      localJobs: [{ id: NEW, name: "Sales Nav Enricher" }, { id: DUP, name: "Twin" }],
      publisherJobs: [...publisherJobs, { id: "p1", name: "Twin" }, { id: "p2", name: "Twin" }],
      appCode: `${NEW} ${DUP}`,
    });
    expect(plan.remap.size).toBe(0);
    expect(plan.drop.size).toBe(0);
  });

  it("rewrites whole ids in code", () => {
    expect(remapJobIdsInContent(`const J='${DUP}'`, new Map([[DUP, PUB]]))).toBe(`const J='${PUB}'`);
  });
});

describe("folded job in the change set", () => {
  it("proposes the duplicate's edits under the publisher's folder, deleting nothing", () => {
    const cs = buildProposalChangeSet([
      {
        repoDir: `jobs/${PUB}`,
        kind: "job",
        noDeletes: true,
        base: new Map([
          ["code/scrape.py", "old\n"],
          ["code/accounts.py", "company search\n"],
        ]),
        local: new Map([
          ["code/scrape.py", "salesnav\n"],
          ["code/extract_salesnav.js", "x\n"],
        ]),
      },
    ]);
    expect([...cs.writes.keys()].sort()).toEqual([
      `jobs/${PUB}/code/extract_salesnav.js`,
      `jobs/${PUB}/code/scrape.py`,
    ]);
    expect(cs.deletes).toEqual([]);
  });

  it("an added empty runtimeCalls is not a job.json edit", () => {
    const base = JSON.stringify({ id: PUB, name: "S", command: "python3 code/scrape.py" });
    const local = JSON.stringify({ id: PUB, name: "S", command: "python3 code/scrape.py", runtimeCalls: [] });
    expect(jobJsonForProposal(base, local)).toBeNull();
  });
});

describe("data/jobs.json in proposals", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "contrib-jobs-"));
    dirs.push(root);
    const repoDir = path.join(root, "repo");
    const contributor = path.join(root, "papr");
    const forkAppId = "fork-app";
    fs.mkdirSync(path.join(repoDir, "data"), { recursive: true });
    fs.mkdirSync(path.join(contributor, "data"), { recursive: true });
    fs.mkdirSync(path.join(contributor, "apps", forkAppId), { recursive: true });
    fs.writeFileSync(path.join(contributor, "apps", forkAppId, "data-sources.json"), JSON.stringify({ sources: [] }));
    const job = (id: string, name: string) => ({
      id, name, type: "python", status: "pending", appIds: [forkAppId],
      createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    });
    fs.writeFileSync(
      path.join(contributor, "data", "jobs.json"),
      JSON.stringify([job(PUB, "LinkedIn Search Scraper"), job(DUP, "LinkedIn Search Scraper"), job(NEW, "Enricher")]),
    );
    return { repoDir, contributor, forkAppId };
  }

  it("is not written when the proposal adds no job", async () => {
    const { repoDir, contributor, forkAppId } = setup();
    const result = await mergeContributeDataIndexesIntoRepo({
      repoDir, contributorPaprDir: contributor, forkAppId, targetAppId: "owner-app",
      proposalJobIds: [DUP], newJobIds: [],
    });
    expect(result.paths).not.toContain("data/jobs.json");
    expect(fs.existsSync(path.join(repoDir, "data", "jobs.json"))).toBe(false);
  });

  it("only gains the genuinely new job", async () => {
    const { repoDir, contributor, forkAppId } = setup();
    await mergeContributeDataIndexesIntoRepo({
      repoDir, contributorPaprDir: contributor, forkAppId, targetAppId: "owner-app",
      proposalJobIds: [DUP, NEW], newJobIds: [NEW],
    });
    const jobs = JSON.parse(fs.readFileSync(path.join(repoDir, "data", "jobs.json"), "utf8")) as { id: string }[];
    expect(jobs.map((j) => j.id)).toEqual([NEW]);
  });
});

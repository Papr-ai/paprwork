import { describe, expect, it } from "vitest";
import { parseBulletGoals, parseChatRefs, parseGoals } from "../src/gateway/services/workspaceGoals.js";
import {
  citedBy,
  scoreFocusCandidates,
  tokenize,
  whyLine,
  type ActivityChat,
  type FocusCandidateInput,
} from "../src/gateway/services/focusGoalsScoring.js";

const NOW = Date.parse("2026-09-28T12:00:00Z");

const BULLETS = `
- **(G1) Close pre-seed Tranche 1** — $1.25M target. Status: **in-progress**. Next milestone: IM Fund SAFE signature + wire, target close **Sep 25, 2026**. Tranche 2 pipeline grows. (from chat: "SAFE Execution Summary and Tranche" 2026-09-02; "Update Papr Blurb Locally" 2026-09-19) Entities: project/papr-preseed-round, app/investor-review. Evidence: > "keep it" — Chats/Use LinkedIn to grab the profile....txt
- **(G2) Land the Techstars Demo Day pitch** — Status: **in-progress, traction numbers at-risk**. Next milestone: pick a defensible figure (committed vs. Stripe-collected) before rehearsing.
- **(G6) Ship Stage-A pretraining for papr-embed-v2** — Status: **proposed**. Level: L1. Period: 2026-Q3. Confidence: **high** (8 explicit mentions). New sub-goal proposed: **G6a (L2, Parent: G6)** — NCCL guard. Entities: projects/papr-embed-v2-training.
- **(G9) Old thing** — Status: **done**.
`;

describe("parseBulletGoals", () => {
  it("reads one-line Sleep bullets into structured goals", () => {
    const goals = parseBulletGoals(BULLETS);
    expect(goals.map((g) => g.id)).toEqual(["G1", "G2", "G6", "G9"]);
    const [g1, g2, g6, g9] = goals;
    expect(g1.title).toBe("Close pre-seed Tranche 1");
    expect(g1.status).toBe("on-track");
    expect(g1.priority).toBe(1);
    expect(g1.nextMilestone).toBe("IM Fund SAFE signature + wire, target close Sep 25, 2026");
    expect(g1.entities).toEqual(["project/papr-preseed-round", "app/investor-review"]);
    expect(g1.chatRefs).toEqual(
      expect.arrayContaining(["safe execution summary and tranche", "update papr blurb locally", "use linkedin to grab the profile"]),
    );
    expect(g2.status).toBe("at-risk");
    expect(g2.nextMilestone).toContain("committed vs. Stripe-collected");
    // A sub-goal mentioned inside G6's text must not make G6 its own child.
    expect(g6.level).toBe("L1");
    expect(g6.parent).toBeUndefined();
    expect(g6.confidence).toBe("high");
    expect(g6.period).toBe("2026-Q3");
    expect(g6.mentions).toBe(8);
    expect(g9.status).toBe("done");
  });

  it("parseGoals merges bullets with ### blocks without duplicating ids", () => {
    const md = `### G1 — Block wins\n- Level: L1\n- Status: on-track\n${BULLETS}`;
    const goals = parseGoals(md);
    expect(goals.filter((g) => g.id === "G1")).toHaveLength(1);
    expect(goals.find((g) => g.id === "G1")?.title).toBe("Block wins");
    expect(goals.map((g) => g.id)).toContain("G6");
  });

  it("parseChatRefs reads both citation styles", () => {
    expect(parseChatRefs('x (from chats: "Finding Demo Day Pitch" 2026-09-03, "Hooks") Chats/Lawyer Requests.txt')).toEqual([
      "lawyer requests",
      "finding demo day pitch",
    ]);
  });
});

function chat(id: string, text: string, hours7: number, hours30 = hours7): ActivityChat {
  return { id, text, updatedAt: "2026-09-27T10:00:00Z", hours7, hours30 };
}

const GOALS: FocusCandidateInput[] = [
  { id: "G1", title: "Close Tranche 2 of the pre-seed round", origin: "identity", status: "on-track", level: "L1", priority: 1, chatRefs: ["investor review app"] },
  { id: "G2", title: "Land the Techstars Demo Day pitch", origin: "identity", status: "on-track", level: "L1", priority: 2 },
  { id: "G3", title: "Grow agency revenue", origin: "identity", status: "on-track", level: "L1", priority: 3 },
  { id: "G4", title: "Ship papr-embed-v2 H100 pretraining", origin: "identity", status: "proposed", level: "L1", priority: 4 },
  { id: "G4a", title: "NCCL timeout guard for H100 runs", origin: "identity", status: "proposed", level: "L2", parent: "G4", priority: 5 },
];

const FILLER = Array.from({ length: 30 }, (_, i) => chat(`f${i}`, `Misc chat ${i} about calendars lunch plans`, 0.1));

describe("scoreFocusCandidates", () => {
  it("ranks by where time actually went and explains why", () => {
    const res = scoreFocusCandidates({
      goals: GOALS,
      onboarding: [],
      chats: [
        chat("a", "New Chat \n papr-embed-v2 h100 pretraining run", 30),
        chat("b", "Investor Review App \n avatars", 4),
        chat("c", "Pitch hooks \n Techstars demo day", 1),
        ...FILLER,
      ],
      logs: [],
      tasks: [{ title: "Rehearse", goalId: "G2", due: "2026-09-30" }],
      apps: [],
      now: NOW,
    });
    expect(res.top.map((g) => g.id)).toEqual(["G4", "G1", "G2"]);
    const g4 = res.top[0];
    expect(g4.signals.hours7).toBe(30);
    expect(g4.why).toContain("30h in chats this week");
    // G1 matched only through Sleep's cited chat title, not keywords.
    expect(res.top[1].signals.chats30).toBe(1);
    // Hours are never double-counted: aligned share uses each chat's single best goal.
    expect(res.hoursFor(["G4", "G1", "G2"])).toBeCloseTo(35, 5);
    expect(res.weekHours).toBeCloseTo(38, 5);
  });

  it("never picks a goal together with its own sub-goal", () => {
    const res = scoreFocusCandidates({
      goals: GOALS,
      onboarding: [],
      chats: [chat("a", "NCCL timeout guard h100", 20), chat("b", "papr-embed-v2 h100 pretraining", 20), ...FILLER],
      logs: [],
      tasks: [],
      apps: [],
      now: NOW,
    });
    const ids = res.top.map((g) => g.id);
    expect(ids.includes("G4") && ids.includes("G4a")).toBe(false);
  });

  it("onboarding goals boost the matching goal, and stand alone when nothing matches", () => {
    const res = scoreFocusCandidates({
      goals: GOALS,
      onboarding: [
        { id: "P-1", title: "Grow agency revenue to $10K MRR", origin: "onboarding" },
        { id: "P-2", title: "Write and publish daily", origin: "onboarding" },
        { id: "U-1", title: "Research competitors", origin: "usecase" },
      ],
      chats: FILLER,
      logs: [],
      tasks: [],
      apps: [],
      now: NOW,
    });
    expect(res.ranked.find((g) => g.id === "G3")?.signals.onboarding).toBe(true);
    expect(res.ranked.find((g) => g.id === "P-2")?.origin).toBe("onboarding");
    expect(res.ranked.find((g) => g.id === "U-1")).toBeUndefined();
  });

  it("falls back to IDENTITY order when there is no activity at all", () => {
    const res = scoreFocusCandidates({ goals: GOALS.slice(0, 3), onboarding: [], chats: [], logs: [], tasks: [], apps: [], now: NOW });
    expect(res.top.map((g) => g.id)).toEqual(["G1", "G2", "G3"]);
    expect(res.evidence).toBe("From your goals");
  });
});

describe("helpers", () => {
  it("tokenize keeps hyphenated names whole and drops filler", () => {
    expect(tokenize("Ship the papr-embed-v2 model")).toEqual(expect.arrayContaining(["papr-embed-v2", "embed", "model"]));
    expect(tokenize("Ship the papr-embed-v2 model")).not.toContain("ship");
  });

  it("citedBy matches truncated file titles", () => {
    expect(citedBy(["add papr-embed-v1 models to patent appli"], "Add papr-embed-v1 Models to Patent Application \n x")).toBe(true);
    expect(citedBy(["new chat about x"], "New \n y")).toBe(false);
  });

  it("whyLine prefers onboarding, then time", () => {
    const base = { chats30: 5, hours7: 3, hours30: 6, logDays: 0, openTasks: 0, appsOpened: 0 };
    expect(whyLine({ origin: "identity", status: "on-track", signals: { ...base, onboarding: true } })).toBe(
      "You set it in onboarding · 3h in chats this week",
    );
    expect(whyLine({ origin: "identity", status: "on-track", signals: { ...base, overdue: 2, hours7: 0, chats30: 0 } })).toBe(
      "2 overdue tasks",
    );
  });
});

describe("focus picks: repeating goals", () => {
  it("keeps daily/weekly, drops anything else, and never stores a due date on a habit", async () => {
    const { normalizePick } = await import("../src/gateway/services/focusGoals.js");
    const daily = normalizePick(
      { id: "F-1", title: " Post daily on X and LinkedIn ", target: "1 post on X and LinkedIn", due: "2026-11-30", repeat: "daily" },
      0,
      1,
    );
    expect(daily).toMatchObject({ id: "F-1", title: "Post daily on X and LinkedIn", repeat: "daily", due: undefined });
    const once = normalizePick({ id: "G1", goalId: "G1", due: "2026-11-30", repeat: "hourly" as never }, 0, 1);
    expect(once).toMatchObject({ id: "G1", due: "2026-11-30", repeat: undefined });
  });
});

describe("startOfWeek", () => {
  it("resets weekly hours on Monday 00:00 local", async () => {
    const { startOfWeek } = await import("../src/gateway/services/focusGoals");
    const mon = startOfWeek(new Date(2026, 9, 5, 20, 48).getTime());
    expect(new Date(mon)).toEqual(new Date(2026, 9, 5, 0, 0));
    expect(new Date(startOfWeek(new Date(2026, 9, 11, 23, 0).getTime()))).toEqual(new Date(2026, 9, 5, 0, 0));
  });
});

describe("isSameGoal", () => {
  it("detaches a rewrite that shares no words with its goal", async () => {
    const { isSameGoal } = await import("../src/gateway/services/focusGoals");
    expect(isSameGoal("Distribution via content creation", "Validate MHAR depth-router + file patent claims")).toBe(false);
    expect(isSameGoal("Validate MHAR router by Friday", "Validate MHAR depth-router + file patent claims")).toBe(true);
  });
});

describe("user-written goals + per-turn hours", () => {
  const corpus = [
    ...Array.from({ length: 98 }, (_, i) => `filler${i} word${i}`),
    "linkedin post ideas",
    "left navigation redesign sidebar",
  ];
  const goals: FocusCandidateInput[] = [
    { id: "G7", title: "Redesign left navigation sidebar", origin: "identity", status: "on-track" },
    {
      id: "pick:G4",
      title: "Distribution via content creation, build following",
      origin: "custom",
      extraKeywords: "1 post on x and linkedIn, comment and engage daily",
    },
  ];
  const chat: ActivityChat = {
    id: "c1",
    text: "Help me redesign our left navigation sidebar",
    updatedAt: "2026-09-28T10:00:00Z",
    hours7: 4,
    hours30: 4,
    turns: [
      { text: "Help me redesign our left navigation sidebar", hours7: 1 },
      { text: "Where should I place images in the article I'm going to post on Substack, X and LinkedIn", hours7: 2 },
      { text: "the fold animation is hard to read, fix it", hours7: 1 },
    ],
  };

  it("scores the user's own goal and moves this week's time with each turn", () => {
    const res = scoreFocusCandidates({ goals, onboarding: [], chats: [chat], corpus, logs: [], tasks: [], apps: [], now: NOW });
    const own = res.ranked.find((g) => g.id === "pick:G4")!;
    const nav = res.ranked.find((g) => g.id === "G7")!;
    expect(own.signals.hours7).toBeCloseTo(3, 5);
    expect(nav.signals.hours7).toBeCloseTo(1, 5);
    expect(res.hoursFor(["pick:G4"])).toBeCloseTo(3, 5);
    expect(res.weekHours).toBeCloseTo(4, 5);
    // Already picked by the user — never offered back as one of Pen's top three.
    expect(res.top.some((g) => g.origin === "custom")).toBe(false);
  });
});

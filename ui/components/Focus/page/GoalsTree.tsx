/**
 * Goals: the L1 → L2 → L3 tree from IDENTITY.md. Sleep drafts it (Status: proposed); you confirm, edit,
 * close or reject. One-click writes PATCH the goal; anything that needs words goes to Pen.
 * Port of goals.js + goals_api.js + focus_start.js (first run stays on Focus).
 */
import { useState } from "react";
import { focusApi, openChat, type GoalsResult, type WsGoal } from "./focusApi";
import { requestMemoryEntity } from "../../../lib/memoryNav";
import { switchToMemoryTab } from "../../../lib/ensureDefaultChatTab";

const STATUS: Record<string, string> = { proposed: "Draft", "on-track": "On track", "at-risk": "At risk", blocked: "Blocked", done: "Done" };
const FMT = 'Keep the block format in IDENTITY.md "## Goals" (Level / Status / Confidence / Priority / Parent / Entities / Next milestone / Owner / Evidence), keep L1s mutually exclusive, name the projects/companies/people each goal runs through (Entities: line, using real entities/** slugs), and show me the final tree.';

const line = (g: WsGoal) => `${g.id} [${g.level}${g.parent ? ` → ${g.parent}` : ""}] — ${g.title} [${g.status}, ${g.confidence} confidence, priority ${g.priority}]${g.nextMilestone ? ` · next: ${g.nextMilestone}` : ""}${g.entities?.length ? ` · entities: ${g.entities.join(", ")}` : ""}`;
const summary = (g: WsGoal | undefined, gid: string) => {
  if (!g) return `Goal ${gid}`;
  const bits = [`"${g.title}"`, g.level];
  if (g.parent) bits.push(`parent ${g.parent}`);
  if (g.nextMilestone) bits.push(`next: ${g.nextMilestone}`);
  return `${bits.join(" · ")} (${gid})`;
};

export function goalPrompt(mode: string, goals: WsGoal[], gid = ""): string {
  const one = goals.find((g) => g.id === gid);
  const list = goals.map(line).join("\n");
  switch (mode) {
    case "draft": return "Draft my goals for me. Read IDENTITY.md (Goals format, Current Projects, Domain Context), MEMORY.md, the last 7 daily logs, my Papr onboarding goals/use cases, and my Papr Memory goal records. Propose a tree: 2–5 L1 long-term OUTCOMES (mutually exclusive), the L2 mid-term goals under each, and L3 tactical steps with dates. Give each a Confidence (high = I said it directly, medium = strong inference, low = one signal), a Priority within its level, the Entities it runs through (real entities/** slugs — an L2 is usually one project or company), and cite the evidence quote. Write them into IDENTITY.md \"## Goals\" as Status: proposed, then show me the tree so I can confirm, edit, or reject each one.";
    case "reject": return `This draft goal isn't mine — please remove it from IDENTITY.md ## Goals:\n\n${summary(one, gid)}\n\nAsk me briefly why it doesn't fit before you remove it. If it has sub-goals, ask what to do with those too.`;
    case "close": return `I want to close this goal:\n\n${summary(one, gid)}\n\nAsk whether we achieved it or are dropping it, and what happened in one line.`;
    case "edit-one": return `I want to edit this goal in IDENTITY.md:\n\n${summary(one, gid)}`;
    default: return `Let's update my goals in IDENTITY.md (## Goals). Current tree:\n\n${list}\n\nAsk me what changed — anything done, at risk, new, reprioritised, or mis-levelled — then rewrite the block. ${FMT}`;
  }
}

function openEntity(ref: string) {
  const [type, ...rest] = ref.split("/");
  switchToMemoryTab();
  requestMemoryEntity({ id: ref, type: type.replace(/s$/, ""), label: rest.join("/").replace(/-/g, " "), description: "", props: {} });
}

interface Props { data: GoalsResult; canOpen: (id: string) => boolean; onOpen: (id: string) => void; onChanged: () => void }

export function GoalsTree({ data, canOpen, onOpen, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const patch = async (key: string, ids: string[], body: Record<string, unknown>) => {
    setBusy(key);
    try { for (const id of ids) await focusApi.patchGoal(id, body); onChanged(); setFailed((f) => { const { [key]: _, ...r } = f; return r; }); }
    catch (e) { setFailed((f) => ({ ...f, [key]: (e as Error).message })); }
    setBusy(null);
  };
  const confirm = (id: string) => void patch(`c:${id}`, [id], { status: "on-track", confidence: "high" });
  const chat = (mode: string, gid?: string) => openChat(goalPrompt(mode, data.goals, gid));
  const Btn = ({ k, cls = "", onClick, children }: { k: string; cls?: string; onClick: () => void; children: React.ReactNode }) => (
    <button className={`goals-btn tiny ${cls}`.trim()} disabled={busy === k} title={failed[k]} onClick={onClick}>{failed[k] ? "Retry" : children}</button>
  );
  const Title = ({ g }: { g: WsGoal }) => canOpen(g.id)
    ? <button type="button" className="goal-title goal-open" onClick={() => onOpen(g.id)}>{g.title}</button>
    : <span className="goal-title">{g.title}</span>;
  const Actions = ({ g }: { g: WsGoal }) => {
    if (g.status === "done" || g.status === "dropped") {
      return <div className="goal-outcome">{g.status === "done" ? "✓" : "✗"} {g.outcome || (g.status === "done" ? "Achieved" : "Dropped")}{g.closed ? ` · ${g.closed}` : ""}
        <button className="goals-btn tiny ghost goal-hover" disabled={busy === `r:${g.id}`} onClick={() => void patch(`r:${g.id}`, [g.id], { status: "on-track" })}>Reopen</button></div>;
    }
    if (g.status !== "proposed") {
      return <div className="goal-confirm goal-hover"><Btn k={`e:${g.id}`} cls="ghost" onClick={() => chat("edit-one", g.id)}>Edit</Btn><Btn k={`x:${g.id}`} cls="ghost" onClick={() => chat("close", g.id)}>Close</Btn></div>;
    }
    return <div className="goal-confirm"><Btn k={`c:${g.id}`} onClick={() => confirm(g.id)}>Confirm</Btn><Btn k={`e:${g.id}`} cls="ghost" onClick={() => chat("edit-one", g.id)}>Edit</Btn><Btn k={`n:${g.id}`} cls="ghost" onClick={() => chat("reject", g.id)}>Not a goal</Btn></div>;
  };
  const Badges = ({ g }: { g: WsGoal }) => <>
    {g.status !== "unknown" ? <span className={`goal-status ${g.status}`}>{STATUS[g.status] ?? ""}</span> : null}
    {g.confidence && g.confidence !== "unknown" && g.confidence !== "high" ? <span className={`goal-conf ${g.confidence}`} title="How sure we are this is your goal">{g.confidence} confidence</span> : null}
    {g.parentMissing ? <span className="goal-conf low" title="Parent goal not found">no parent</span> : null}
    {g.level === "L1" && g.period ? <span className="goal-period">{g.period}</span> : null}
  </>;
  const Node = ({ g }: { g: WsGoal }) => {
    const kids = g.children ?? [], l3 = kids.filter((k) => k.level === "L3"), l2 = kids.filter((k) => k.level !== "L3");
    return (
      <div className={`goal ${g.level} ${g.status}`}>
        <div className="goal-head"><Title g={g} /><Badges g={g} /></div>
        {g.nextMilestone ? <div className="goal-next">Next: {g.nextMilestone}</div> : null}
        {g.entities?.length ? <div className="goal-entities">{g.entities.map((r) => (
          <a key={r} className={`goal-entity ${r.split("/")[0]}`} href="#" title={r} onClick={(e) => { e.preventDefault(); openEntity(r); }}>{(r.split("/")[1] ?? r).replace(/-/g, " ")}</a>
        ))}</div> : null}
        <Actions g={g} />
        {l2.length ? <details className="goal-l2s"><summary>{l2.length} sub-goal{l2.length > 1 ? "s" : ""}</summary><div className="goal-children">{l2.map((k) => <Node key={k.id} g={k} />)}</div></details> : null}
        {l3.length ? <details className="goal-l3s"><summary>{l3.length} tactical</summary>{l3.map((k) => <Node key={k.id} g={k} />)}</details> : null}
      </div>
    );
  };

  const closed = (g: WsGoal) => g.status === "done" || g.status === "dropped";
  const all = data.tree?.length ? data.tree : data.goals.map((g) => ({ ...g, children: [] }));
  const roots = all.filter((g) => !closed(g));
  const past = [...all.filter(closed), ...(data.archive ?? [])];
  const byPeriod = past.reduce<Record<string, WsGoal[]>>((m, g) => ((m[g.period || "—"] ||= []).push(g), m), {});
  const drafts = data.goals.filter((g) => g.status === "proposed").map((g) => g.id);
  return (
    <section className="goals">
      <div className="goals-head">
        <h2 className="section-title">Goals {data.proposedCount ? <span className="goals-drafts">{data.proposedCount} draft{data.proposedCount > 1 ? "s" : ""} to confirm</span> : null}</h2>
        <div className="goals-actions">
          {data.proposedCount > 1 ? <button className="goals-btn tiny" disabled={busy === "all"} onClick={() => void patch("all", drafts, { status: "on-track", confidence: "high" })}>Confirm all</button> : null}
          <button className="goals-btn ghost" onClick={() => chat("edit")}>Update goals</button>
        </div>
      </div>
      <div className="goals-tree">{roots.map((g) => <Node key={g.id} g={g} />)}</div>
      {past.length ? (
        <details className="goals-past"><summary>Past goals ({past.length})</summary>
          {Object.entries(byPeriod).map(([p, gs]) => (
            <div key={p} className="goals-past-period"><h3>{p}</h3>
              {gs.map((g) => <div key={g.id} className={`goal past ${g.level} ${g.status}`}><div className="goal-head"><Title g={g} /></div><Actions g={g} /></div>)}
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}

/** First run: "What are you working toward?" Both buttons stay on Focus. */
export function GoalsEmpty({ onDraft, onWrite }: { onDraft: () => Promise<boolean>; onWrite: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <section className="goals goals-empty">
      <div className="goals-empty-text">
        <strong>What are you working toward?</strong>
        <span>I can draft your goals from your Papr onboarding, chats and memory — long-term objectives, the mid-term goals under them, and this week&apos;s tactical steps — for you to confirm. Or tell me directly.</span>
      </div>
      <div className="goals-actions">
        <button className="goals-btn" disabled={busy} onClick={async () => { setBusy(true); const ok = await onDraft(); setBusy(false); if (!ok) openChat(goalPrompt("draft", [])); }}>
          {busy ? "Pen is picking…" : "Draft my goals"}
        </button>
        <button className="goals-btn ghost" onClick={onWrite}>I&apos;ll tell you</button>
      </div>
    </section>
  );
}

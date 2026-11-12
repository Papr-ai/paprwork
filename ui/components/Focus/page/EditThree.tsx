/**
 * Edit your three: keep, edit or swap. Pen proposes, you dispose: never a blank page, never more than
 * three. Edits stay in a draft until Save / Lock in (PUT /api/workspace/focus). Port of three_edit.js.
 */
import { useState } from "react";
import { focusApi, type FocusGoal, type FocusPick, type FocusState } from "./focusApi";
import { goalSub } from "./fmt";
import { SparkIcon } from "./icons";
import { GoalForm, type GoalFields } from "./GoalForm";

type Draft = FocusGoal & { origTitle?: string };

/** PUT body: custom goals carry their text, Pen's carry the goal id (and the title only if renamed). */
export function picksFrom(goals: Draft[]): FocusPick[] {
  return goals.filter((g) => g.title).map((g) => g.origin === "custom"
    ? { id: g.id, title: g.title, target: g.target, due: g.due, repeat: g.repeat, scope: g.scope }
    : { id: g.id, goalId: g.id, title: g.edited || (g.origTitle && g.title !== g.origTitle) ? g.title : undefined, target: g.target, due: g.due, repeat: g.repeat, scope: g.scope });
}

interface Props { data: FocusState | null; focusId?: string; promoteId?: string; startOwn?: boolean; onSaved: (s: FocusState) => void; onClose: () => void }

export function EditThree({ data, focusId, promoteId, startOwn, onSaved, onClose }: Props) {
  const [draft, setDraft] = useState<Draft[]>(() => {
    const d: Draft[] = (data?.three ?? []).map((g) => ({ ...g, origTitle: g.title }));
    if (startOwn && d.length < 3) d.push({ id: `F-new-${Date.now()}`, title: "", why: "Written by you", origin: "custom", signals: {} } as Draft);
    return d as Draft[];
  });
  const [pool, setPool] = useState<Draft[]>(() => (data?.candidates ?? []).map((g) => ({ ...g, origTitle: g.title })));
  const [editing, setEditing] = useState(() => (startOwn ? `own:${draft.find((g) => !g.title)?.id ?? draft[0]?.id}` : focusId ?? ""));
  const [swapping, setSwapping] = useState("");
  const [promote, setPromote] = useState(promoteId ?? "");
  const [saving, setSaving] = useState(false);

  const first = data?.source === "pen" && !data?.confirmed;
  const blank = !data?.three?.length;
  const pr = promote ? pool.find((x) => x.id === promote) : undefined;

  const use = (gid: string, cid: string) => {
    const i = draft.findIndex((g) => g.id === gid), j = pool.findIndex((c) => c.id === cid);
    if (i < 0 || j < 0) return;
    const nd = draft.slice(), np = pool.slice();
    const [picked] = np.splice(j, 1);
    np.unshift(nd[i]); nd[i] = picked;
    setDraft(nd); setPool(np); setSwapping(""); setPromote("");
  };
  const save = (gid: string, f: GoalFields) => {
    const own = editing === `own:${gid}`, i = draft.findIndex((g) => g.id === gid);
    const nd = draft.slice();
    if (own) {
      if (nd[i].title) setPool([nd[i], ...pool]);
      nd[i] = { id: `F-${Date.now()}`, ...f, why: "Written by you", origin: "custom", signals: {} };
    } else nd[i] = { ...nd[i], ...f };
    setDraft(nd); setEditing("");
  };
  const add = () => {
    if (draft.length < 3) {
      const slot: Draft = { id: `F-new-${Date.now()}`, title: "", why: "Written by you", origin: "custom", signals: {} };
      setDraft([...draft, slot]); setEditing(`own:${slot.id}`);
    } else setEditing(`own:${draft[0].id}`);
    setSwapping("");
  };
  const put = async (fn: () => Promise<FocusState>) => {
    setSaving(true);
    try { const s = await fn(); onSaved(s); return s; } catch { return null; } finally { setSaving(false); }
  };
  const lock = async () => {
    const picks = picksFrom(draft);
    if (picks.length && (await put(() => focusApi.saveThree(picks)))) onClose();
  };
  const repick = async () => {
    const s = await put(() => focusApi.repick());
    if (s) { setDraft(s.three.map((g) => ({ ...g, origTitle: g.title }))); setPool(s.candidates.map((g) => ({ ...g, origTitle: g.title }))); setEditing(""); }
  };

  const sub = pr ? `Pick the goal "${pr.title}" replaces. Three at most.` : blank ? "Name up to three outcomes you want to move. Pen builds your brief around them."
    : first ? `${data?.evidence || "From your goals"}. Keep them, edit one, or swap it out.` : "Change what's changed. Pen keeps the rest as is.";

  return (
    <div className="t3wrap">
      <p className="hero-date">{first ? "Pen's picks" : "Edit Focus"}</p>
      <h2 className="hero-title">{first ? "Pen picked your priority goals." : "Your priority goals."}</h2>
      <p className="t3sub">{sub}</p>
      <div className="t3cards">
        {draft.map((g, i) => {
          const own = editing === `own:${g.id}`, isEditing = own || editing === g.id;
          if (pr && !isEditing) {
            return (
              <article key={g.id} className="t3card"><span className="t3num">{i + 1}</span>
                <div className="t3body"><h3>{g.title}</h3>{goalSub(g) ? <p className="t3done">{goalSub(g)}</p> : null}</div>
                <div className="t3acts"><button type="button" className="on" onClick={() => use(g.id, pr.id)}>Replace with this</button></div>
              </article>
            );
          }
          return (
            <article key={g.id} className={`t3card${isEditing ? " editing" : ""}`}><span className="t3num">{i + 1}</span>
              <div className="t3body">
                {isEditing ? (
                  <GoalForm g={g} own={own} onSave={(f) => save(g.id, f)} onCancel={() => { setEditing(""); setDraft(draft.filter((x) => x.title)); }} />
                ) : (
                  <><h3>{g.title}</h3>{goalSub(g) ? <p className="t3done">{goalSub(g)}</p> : null}<p className="t3why"><SparkIcon />{g.why}</p></>
                )}
                {swapping === g.id ? (
                  <div className="t3swap"><small>Swap for</small>
                    {pool.map((x) => <button key={x.id} type="button" className="t3cand" onClick={() => use(g.id, x.id)}><b>{x.title}</b><span>{x.why}</span></button>)}
                    <button type="button" className="t3cand own" onClick={() => { setEditing(`own:${g.id}`); setSwapping(""); }}><b>Write my own</b></button>
                  </div>
                ) : null}
              </div>
              {isEditing ? null : (
                <div className="t3acts">
                  <button type="button" onClick={() => { setEditing(editing === g.id ? "" : g.id); setSwapping(""); }}>Edit</button>
                  <button type="button" className={swapping === g.id ? "on" : ""} onClick={() => { setSwapping(swapping === g.id ? "" : g.id); setEditing(""); }}>Swap</button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {draft.length < 3 && !editing ? <button type="button" className="t3add" onClick={add}>Add a goal</button> : null}
      <footer className="t3foot">
        <button type="button" className="hfocus-primary" disabled={saving} onClick={() => void lock()}>{first ? "Lock in my three" : "Save"}</button>
        <button type="button" className="hfocus-ghost" onClick={onClose}>{first ? "Not now" : "Cancel"}</button>
      </footer>
      <p className="t3note">Three at most. Pen never changes them on its own. <button type="button" className="t3link" onClick={() => void repick()}>Let Pen pick again</button></p>
    </div>
  );
}

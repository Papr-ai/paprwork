/**
 * Briefs + reviews for the Focus page: load, step through days, review items, generate today's brief.
 * Port of app.js (init, render, review, generateRealBrief) without the iframe.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { focusApi, openChat, type BriefRow, type ReviewRow } from "./focusApi";
import { briefDates, briefFor, itemTitle, parseBrief, reviewMap, todayKey, type Brief, type BriefItem } from "./brief";
import { sampleBrief } from "./sampleBrief";

const BRIEF_JOB = "Daily Brief Generator";

export function useBrief() {
  const [rows, setRows] = useState<BriefRow[]>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [idx, setIdx] = useState(0);
  const [generating, setGenerating] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await focusApi.today();
      setRows(d.briefs); setReviews(d.reviews); setError(null);
    } catch (e) { setError((e as Error).message); }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { type?: string; data?: { name?: string; status?: string; error?: string } } | undefined;
      if (d?.type === "focus:changed") void load();
      if (d?.type === "jobs:status-changed" && d.data?.name === BRIEF_JOB && (d.data.status === "completed" || d.data.status === "failed")) {
        void load();
        setGenerating((g) => {
          if (g && d.data?.status === "failed") openChat(`My daily brief failed: ${d.data.error || "the Daily Brief Generator job failed"}. Please fix the Daily Brief Generator job.`);
          return null;
        });
      }
    };
    window.addEventListener("gateway-broadcast", on);
    window.addEventListener("papr-workspace-switch-complete", load);
    return () => { window.removeEventListener("gateway-broadcast", on); window.removeEventListener("papr-workspace-switch-complete", load); };
  }, [load]);

  const dates = useMemo(() => { const d = briefDates(rows); return d.length ? d : [todayKey()]; }, [rows]);
  const marks = useMemo(() => reviewMap(reviews), [reviews]);
  const isSample = loaded && !error && !rows.some((r) => parseBrief(r.brief_json));
  const brief: Brief | null = useMemo(() => {
    if (isSample) return briefFor([{ date: todayKey(), brief_json: sampleBrief() }], marks);
    return briefFor(rows, marks, idx === 0 ? undefined : dates[idx]);
  }, [rows, marks, idx, dates, isSample]);

  /** Check / x / undo. Optimistic; the Focus DB is canonical and the brief job reads it back. */
  const review = useCallback(async (i: BriefItem, next: "complete" | "irrelevant" | "active", note?: string) => {
    const key = i._id;
    setReviews((rs) => {
      const rest = rs.filter((r) => r.item_key !== key);
      return next === "active" ? rest : [...rest, { item_key: key, status: next, note: note ?? null, updated_at: new Date().toISOString() }];
    });
    if (isSample) return;
    try {
      if (next === "active") {
        await focusApi.unreview(key, brief?.date ?? todayKey());
        if (i.task_id) await focusApi.setTaskDone(i.task_id, false).catch(() => undefined);
      } else {
        await focusApi.review(key, { briefDate: brief?.date ?? todayKey(), section: i._section, itemType: i._type, title: itemTitle(i), status: next, note, taskId: i.task_id });
        // A brief item that maps to a task: completing it completes the task at its source.
        if (i.task_id && next === "complete") await focusApi.setTaskDone(i.task_id, true).catch(() => undefined);
      }
    } catch { /* kept locally; the next load shows the server's state */ }
  }, [brief?.date, isSample]);

  const generate = useCallback(async () => {
    setGenerating("Setting up...");
    try {
      const { jobId } = await focusApi.briefJob();
      setGenerating("Generating...");
      await focusApi.runJob(jobId).catch((e: Error) => { if (!/409|already running/i.test(e.message)) throw e; });
      setGenerating("Working...");
    } catch (e) {
      setGenerating("Opening chat...");
      openChat(`My daily brief failed: ${(e as Error).message}. Please fix the Daily Brief Generator job.`);
      window.setTimeout(() => setGenerating(null), 2500);
    }
  }, []);

  return { brief, dates, idx, setIdx, error, loaded, isSample, review, generate, generating, reload: load };
}

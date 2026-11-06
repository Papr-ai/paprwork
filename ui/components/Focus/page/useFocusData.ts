/**
 * Your three, the goal tree and tasks for the Focus page. Loaded once, refreshed on workspace switch,
 * and when Focus comes back into view after a minute (goals change in chat; Sleep re-ranks evidence).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { focusApi, type FocusGoal, type FocusState, type GoalsResult, type TasksResult } from "./focusApi";

export function useFocusData() {
  const [state, setState] = useState<FocusState | null>(null);
  const [goals, setGoals] = useState<GoalsResult | null>(null);
  const [tasks, setTasks] = useState<TasksResult | null>(null);
  const [loaded, setLoaded] = useState(false);
  const loadedAt = useRef(0);

  const reloadState = useCallback(async (): Promise<FocusState | null> => {
    let next: FocusState | null = null;
    try { next = await focusApi.state(); } catch { /* keep null */ }
    setState(next);
    loadedAt.current = Date.now();
    return next;
  }, []);
  const reloadGoals = useCallback(async () => {
    try { setGoals(await focusApi.goals()); } catch { setGoals(null); }
  }, []);
  const reloadTasks = useCallback(async () => {
    try { setTasks(await focusApi.tasks()); } catch { setTasks(null); }
  }, []);
  const reloadAll = useCallback(async () => {
    await Promise.all([reloadState(), reloadGoals(), reloadTasks()]);
    setLoaded(true);
  }, [reloadState, reloadGoals, reloadTasks]);

  useEffect(() => {
    void reloadAll();
    const onVisible = () => {
      if (!document.hidden && Date.now() - loadedAt.current > 60_000) void reloadState();
    };
    const onSwitch = () => void reloadAll();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("papr-workspace-switch-complete", onSwitch);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("papr-workspace-switch-complete", onSwitch);
    };
  }, [reloadAll, reloadState]);

  const three = state?.three ?? [];
  /** Any ranked goal: one of the three or one outside it (every goal has a detail view). */
  const find = useCallback(
    (id: string): FocusGoal | null => [...(state?.three ?? []), ...(state?.candidates ?? [])].find((g) => g.id === id) ?? null,
    [state],
  );

  return { state, setState, goals, tasks, loaded, three, find, reloadState, reloadGoals, reloadTasks, reloadAll };
}

export type FocusData = ReturnType<typeof useFocusData>;

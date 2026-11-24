/**
 * Urgent = you're blocked (credits out, Papr Cloud paused). Pen leans out of the rail with the one fix,
 * the same Lean as a nudge, but right away and without nudge caps. One at a time, newest first; it parks
 * as Pen's dot if you ignore it, and goes away by itself once the thing is fixed (the notice resolves).
 * This replaces the old global PaprQuotaBanner and the amber dot on your avatar.
 */
import { useEffect, useRef } from "react";
import type { Notice } from "../../../src/core/types/notices";
import { isUrgent } from "../../../src/core/notifications/needsYou";
import { useNoticeStore } from "../../stores/noticeStore";
import type { AgentNudgeData } from "./useAgentNudge";

export const urgentKey = (n: Notice) => `urgent:${n.key}`;

export function urgentNudge(n: Notice): AgentNudgeData {
  const fix = (n.actions ?? []).find((a) => a.intent !== "dismiss")?.label ?? "Fix it";
  return { key: urgentKey(n), kind: "urgent", line: n.title, sub: n.body, go: fix, later: "Later", action: { type: "notice", key: n.key } };
}

interface Lean { nudge: AgentNudgeData | null; lean: (n: AgentNudgeData) => void; dismiss: () => void }

export function useUrgentLean(lean: Lean): void {
  const urgent = useNoticeStore((s) => s.notices.filter(isUrgent).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null);
  const shown = useRef(new Set<string>());
  const ref = useRef(lean);
  ref.current = lean;
  const key = urgent?.key ?? "";
  useEffect(() => {
    const cur = ref.current.nudge;
    // Fixed: put Pen back.
    if (cur?.key.startsWith("urgent:") && cur.key !== (urgent ? urgentKey(urgent) : "")) ref.current.dismiss();
    if (!urgent || shown.current.has(urgent.key)) return;
    shown.current.add(urgent.key);
    ref.current.lean(urgentNudge(urgent));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

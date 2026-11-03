/**
 * Needs you, read from the notice store: the Focus list, the Later list, muted sources and the one
 * count on Pen. Same rules as the gateway (core/notifications/needsYou), so the count and the list agree.
 */
import { useMemo } from "react";
import { useNoticeStore } from "./noticeStore";
import { gateway } from "../src/lib/gateway";
import { focusReason, laterList, mutedSources, needsYou } from "../../src/core/notifications/needsYou";
import { typeKey } from "../../src/core/notifications/prefs";

export function useNeedsYou() {
  const notices = useNoticeStore((s) => s.notices);
  const prefs = useNoticeStore((s) => s.prefs);
  const tick = useNoticeStore((s) => s.tick);
  return useMemo(() => {
    const now = Date.now();
    const needs = needsYou(notices, prefs, now);
    /** Why each promoted item is here ("Waiting since yesterday"); empty when Focus is its home. */
    const reasons = Object.fromEntries(needs.map((n) => [n.key, focusReason(n, prefs, now) ?? ""]));
    return { needs, reasons, later: laterList(notices, now), muted: mutedSources(prefs, now) };
    // tick: recompute when a Later or mute runs out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notices, prefs, tick]);
}

/** The count on Pen: how many things are waiting on you right now. */
export const useNeedsYouCount = () => useNeedsYou().needs.length;

const send = (type: string, payload: Record<string, unknown>) =>
  gateway.send(type, payload).then((r) => (r.success ? (r.data as { until?: string | null }) : null)).catch(() => null);

export const putOff = (key: string) => send("notifications:later", { key });
export const bringBack = (key: string) => send("notifications:unlater", { key });
export const muteSource = (sourceId: string) => send("notifications:mute", { sourceId });
export const unmuteSource = (sourceId: string) => send("notifications:unmute", { sourceId });
export const turnOffType = (sourceId: string, typeId: string) =>
  send("notifications:set-prefs", { prefs: { types: { [typeKey(sourceId, typeId)]: false } } });

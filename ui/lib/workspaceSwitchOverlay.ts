import { useSyncExternalStore } from "react";

export type WorkspaceSwitchOverlayPhase =
  | "preparing"
  | "core"
  | "artifacts"
  | "services";

export interface WorkspaceSwitchOverlaySnapshot {
  active: boolean;
  phase: WorkspaceSwitchOverlayPhase;
  organizationName?: string;
  namespaceName?: string;
}

let snapshot: WorkspaceSwitchOverlaySnapshot = {
  active: false,
  phase: "preparing",
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getWorkspaceSwitchOverlaySnapshot(): WorkspaceSwitchOverlaySnapshot {
  return snapshot;
}

export function subscribeWorkspaceSwitchOverlay(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function beginWorkspaceSwitchOverlay(labels?: {
  organizationName?: string;
  namespaceName?: string;
}): void {
  snapshot = {
    active: true,
    phase: "preparing",
    organizationName: labels?.organizationName,
    namespaceName: labels?.namespaceName,
  };
  emit();
}

export function setWorkspaceSwitchOverlayPhase(
  phase: WorkspaceSwitchOverlayPhase,
): void {
  if (!snapshot.active) {
    return;
  }
  snapshot = { ...snapshot, phase };
  emit();
  window.dispatchEvent(
    new CustomEvent("papr-workspace-switch-phase", { detail: { phase } }),
  );
}

export function endWorkspaceSwitchOverlay(): void {
  snapshot = { active: false, phase: "preparing" };
  emit();
}

export function parseWorkspaceSwitchLabels(detail: unknown): {
  organizationName?: string;
  namespaceName?: string;
} {
  if (!detail || typeof detail !== "object") {
    return {};
  }
  const record = detail as Record<string, unknown>;
  return {
    organizationName:
      typeof record.organizationName === "string"
        ? record.organizationName
        : undefined,
    namespaceName:
      typeof record.namespaceName === "string" ? record.namespaceName : undefined,
  };
}

export function workspaceSwitchPhaseLabel(
  phase: WorkspaceSwitchOverlayPhase,
): string {
  switch (phase) {
    case "preparing":
      return "Preparing your workspace…";
    case "core":
      return "Loading agents and chats…";
    case "artifacts":
      return "Loading apps…";
    case "services":
      return "Loading jobs and plans…";
  }
}

export function formatWorkspaceSwitchTarget(snapshot: WorkspaceSwitchOverlaySnapshot): string | null {
  const parts = [snapshot.organizationName, snapshot.namespaceName].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" · ");
}

export function useWorkspaceSwitchOverlay(): WorkspaceSwitchOverlaySnapshot {
  return useSyncExternalStore(
    subscribeWorkspaceSwitchOverlay,
    getWorkspaceSwitchOverlaySnapshot,
    getWorkspaceSwitchOverlaySnapshot,
  );
}

/** Test hook — reset overlay state between unit tests. */
export function resetWorkspaceSwitchOverlayForTests(): void {
  snapshot = { active: false, phase: "preparing" };
  listeners.clear();
}

/**
 * Agent focus context — UI-visible mini-app + recent file edits.
 * Injected as a volatile user message (not system prompt) for prompt-cache stability.
 */

export interface UiActiveAppFocus {
  appId: string;
  title: string;
}

export interface UiActiveJobFocus {
  jobId: string;
  name: string;
}

/** Sent from renderer with each agent:stream / chat:inspect-context request. */
export interface UiAgentFocusContext {
  activeApp?: UiActiveAppFocus;
  activeJob?: UiActiveJobFocus;
}

export type LastEditedKind = "mini_app" | "job" | "repo_file";

export interface LastEditedFileRef {
  kind: LastEditedKind;
  /** Repo-relative path (mini-app/job filename) or absolute path (repo_file). */
  path: string;
  appId?: string;
  jobId?: string;
  filename?: string;
  repoRoot?: string;
  editedAt: string;
}

export interface ResolvedAgentFocusContext {
  activeApp?: UiActiveAppFocus & {
    files?: string[];
  };
  activeJob?: UiActiveJobFocus & {
    files?: string[];
  };
  lastEdited?: LastEditedFileRef[];
}

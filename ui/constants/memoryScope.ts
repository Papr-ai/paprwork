export type MemoryAudience = "user" | "namespace" | "org";

/** Shown in chat scope picker menu — not the raw transcript. */
export const MEMORY_SCOPE_EXPLAINER =
  "Shares extracted knowledge from this chat — not the raw transcript.";

export const MEMORY_AUDIENCE_LABELS: Record<
  MemoryAudience,
  { label: string; description: string; optionHint: string }
> = {
  user: {
    label: "Only me",
    description: "Memories stay private to your account",
    optionHint: "Extracted facts stay on your account",
  },
  namespace: {
    label: "Team",
    description: "Team members can search shared memories",
    optionHint: "Team can search extracted facts",
  },
  org: {
    label: "Organization",
    description: "Anyone in your organization can search shared memories",
    optionHint: "Organization can search extracted facts",
  },
};

export type PlatformFeedbackKind = "bug" | "feature";

export const PLATFORM_BUG_REPORT_MESSAGE = `I want to report a bug in Papr Work.

Please help me write a clear GitHub issue for the Papr team. Ask me:
1. What I was trying to do
2. What happened instead (and what I expected)
3. Steps to reproduce, if I know them
4. Whether I want to include an email for follow-up (optional)

When you have enough detail, show me a draft title and body for approval. After I confirm, submit with create_platform_issue (type: bug). I need to be logged into Papr (Settings → AI Models) for automatic submission. Share the issue link when done.`;

export const PLATFORM_FEATURE_REQUEST_MESSAGE = `I want to request a feature for Papr Work.

Please help me write a clear GitHub issue for the Papr team. Ask me:
1. What problem I'm trying to solve
2. What I'd like Papr Work to do instead
3. How important this is to my workflow

When you have enough detail, show me a draft title and body for approval. After I confirm, submit with create_platform_issue (type: feature). I need to be logged into Papr (Settings → AI Models) for automatic submission. Share the issue link when done.`;

export function platformFeedbackChatTitle(kind: PlatformFeedbackKind): string {
  return kind === "bug" ? "Report bug" : "Feature request";
}

export function platformFeedbackInitialMessage(
  kind: PlatformFeedbackKind,
): string {
  return kind === "bug"
    ? PLATFORM_BUG_REPORT_MESSAGE
    : PLATFORM_FEATURE_REQUEST_MESSAGE;
}

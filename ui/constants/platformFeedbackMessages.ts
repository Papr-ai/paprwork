export type PlatformFeedbackKind = "bug" | "feature";

export const PLATFORM_BUG_REPORT_MESSAGE = `I want to report a bug in Papr Work.

Important: the GitHub issue will be **public** — title and body are posted as-is. Please don't include my name, email, file paths, app names, chat content, or what I'm working on in the issue text.

Help me write a public-safe issue. Ask me:
1. Which Papr Work feature misbehaved (chat, settings, jobs UI, etc.)
2. What happened vs what I expected
3. Generic steps to reproduce, if I know them
4. Whether I want to share an email for follow-up (optional — kept private by Papr, not on GitHub)

When you have enough detail, show me a public-safe draft title and body for approval. Remind me it will be posted publicly. After I confirm, submit with create_platform_issue (type: bug). I need to be logged into Papr (Settings → AI Models) for automatic submission.`;

export const PLATFORM_FEATURE_REQUEST_MESSAGE = `I want to request a feature for Papr Work.

Important: the GitHub issue will be **public** — title and body are posted as-is. Please don't include my name, email, file paths, app names, or private workflow details in the issue text.

Help me write a public-safe issue. Ask me:
1. What Papr Work should do differently (product gap)
2. The desired behavior in generic terms
3. Why it would help (without describing my private use case in detail)

When you have enough detail, show me a public-safe draft title and body for approval. Remind me it will be posted publicly. After I confirm, submit with create_platform_issue (type: feature). I need to be logged into Papr (Settings → AI Models) for automatic submission.`;

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

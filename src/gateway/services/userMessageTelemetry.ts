import { isHiddenContinueMessage } from "../../core/constants/hiddenContinue.js";

export type UserMessageTelemetryContext = {
  chatId: string;
  userMessage: string;
  model: string;
  provider: string;
  authType?: string;
  usesPaprProxy: boolean;
};

/** Properties shared by message_sent and user_message_sent. No message content. */
export function messageSentProperties(
  context: UserMessageTelemetryContext,
): Record<string, unknown> {
  return {
    chat_id: context.chatId,
    message_length: context.userMessage.length,
    model: context.model,
    provider: context.provider,
    auth_type: context.authType ?? "apiKey",
    uses_papr_proxy: context.usesPaprProxy,
  };
}

/**
 * Properties for the canonical active-use event. Sent only after the reply
 * succeeds (finished or stopped by the user), never for failed sends.
 * Synthetic recovery turns are excluded from active-user KPIs.
 */
export function userMessageSentProperties(
  context: UserMessageTelemetryContext,
): Record<string, unknown> | null {
  if (isHiddenContinueMessage(context.userMessage)) return null;
  return messageSentProperties(context);
}

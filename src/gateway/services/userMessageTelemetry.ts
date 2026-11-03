const HIDDEN_CONTINUE_PREFIX = "[__papr_continue__]";

export type UserMessageTelemetryContext = {
  chatId: string;
  userMessage: string;
  model: string;
  provider: string;
  authType?: string;
  usesPaprProxy: boolean;
};

/**
 * Build the canonical active-use event after gateway auth succeeds.
 * Synthetic recovery turns are intentionally excluded from active-user KPIs.
 */
export function userMessageSentProperties(
  context: UserMessageTelemetryContext,
): Record<string, unknown> | null {
  if (context.userMessage.startsWith(HIDDEN_CONTINUE_PREFIX)) return null;
  return {
    chat_id: context.chatId,
    message_length: context.userMessage.length,
    model: context.model,
    provider: context.provider,
    auth_type: context.authType ?? "apiKey",
    uses_papr_proxy: context.usesPaprProxy,
  };
}

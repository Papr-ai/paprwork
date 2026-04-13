/**
 * Chat IDs for user-created tabs vs internal sessions stored in the same DB.
 * @see AgentService — agent job runs use `job:jobId:runId`
 * @see SubAgentService — delegation mini-chats use `delegation:delegationId`
 */
export function isUserFacingChatId(chatId: string): boolean {
  if (chatId.startsWith("job:")) return false;
  if (chatId.startsWith("delegation:")) return false;
  return true;
}

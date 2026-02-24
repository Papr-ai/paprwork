/**
 * Parse ChatGPT conversation mapping into linear message list
 * Follows the parent-child tree from current_node backwards
 */

export interface ParsedChatGPTMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  metadata: {
    model?: string;
    tokenCount?: number;
    thinkingEffort?: string;
    citations?: unknown[];
    searchResults?: unknown[];
    toolCalls?: unknown[];
    finishReason?: string;
    turnExchangeId?: string;
    isHidden?: boolean;
  };
}

export function parseChatGPTConversation(data: any): ParsedChatGPTMessage[] {
  const { mapping, current_node } = data;
  if (!mapping || !current_node) return [];

  const messages: ParsedChatGPTMessage[] = [];
  const visited = new Set<string>();

  // Walk backwards from current_node to root
  let nodeId = current_node;
  while (nodeId && mapping[nodeId]) {
    if (visited.has(nodeId)) break; // Prevent infinite loops
    visited.add(nodeId);

    const node = mapping[nodeId];
    const msg = node.message;

    if (msg && msg.author) {
      const role = msg.author.role as "user" | "assistant" | "system";
      
      // Skip hidden system messages
      const isHidden = msg.metadata?.is_visually_hidden_from_conversation === true;
      
      // Extract content
      let content = "";
      if (msg.content?.parts && Array.isArray(msg.content.parts)) {
        content = msg.content.parts.join("\n");
      } else if (msg.content?.user_profile) {
        content = msg.content.user_profile;
      }

      // Only add if has visible content or is assistant/user
      if (content || (role !== "system" && !isHidden)) {
        messages.unshift({
          id: msg.id,
          role,
          content,
          timestamp: msg.create_time || 0,
          metadata: {
            model: msg.metadata?.model_slug || msg.metadata?.resolved_model_slug,
            tokenCount: msg.metadata?.token_count,
            thinkingEffort: msg.metadata?.thinking_effort,
            citations: msg.metadata?.citations,
            searchResults: msg.metadata?.search_result_groups,
            finishReason: msg.metadata?.finish_details?.type,
            turnExchangeId: msg.metadata?.turn_exchange_id,
            isHidden,
          },
        });
      }
    }

    nodeId = node.parent;
  }

  return messages;
}

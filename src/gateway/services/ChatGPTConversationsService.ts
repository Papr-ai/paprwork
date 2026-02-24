/**
 * ChatGPTConversationsService - Fetch conversation history from ChatGPT backend-api
 * Uses OAuth access token to retrieve user's prior conversations
 */

export interface ChatGPTConversation {
  id: string;
  title: string;
  create_time: number; // Unix timestamp
  update_time: number; // Unix timestamp
  model_slug?: string;
  conversation_template_id?: string | null;
  is_archived: boolean;
  workspace_id?: string | null;
}

export interface ChatGPTConversationsListResponse {
  items: ChatGPTConversation[];
  total: number;
  limit: number;
  offset: number;
  has_next?: boolean;
}

export interface ChatGPTConversationsOptions {
  limit?: number;
  offset?: number;
  order?: "created" | "updated"; // API accepts 'created' or 'updated' (descending by default)
  isArchived?: boolean;
  isStarred?: boolean;
}

export class ChatGPTConversationsService {
  private baseUrl = "https://chatgpt.com/backend-api";

  /**
   * List conversations from ChatGPT
   */
  async listConversations(
    accessToken: string,
    options: ChatGPTConversationsOptions = {},
  ): Promise<ChatGPTConversationsListResponse> {
    const {
      limit = 28,
      offset = 0,
      order = "updated", // Default to 'updated' (descending)
      isArchived = false,
      isStarred = false,
    } = options;

    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
      order,
      is_archived: String(isArchived),
      is_starred: String(isStarred),
    });

    const url = `${this.baseUrl}/conversations?${params.toString()}`;

    console.log(
      `[ChatGPTConversationsService] Fetching conversations: ${url}`,
    );

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to fetch conversations: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const data =
      (await response.json()) as ChatGPTConversationsListResponse;
    console.log(
      `[ChatGPTConversationsService] Fetched ${data.items.length} conversations (total: ${data.total})`,
    );

    return data;
  }

  /**
   * Get a single conversation with full message history
   * Endpoint confirmed: /conversation/{id} (NOT /textdocs)
   * 
   * Note: Cloudflare may block this - requires browser-like headers
   */
  async getConversation(
    accessToken: string,
    conversationId: string,
  ): Promise<unknown> {
    const url = `${this.baseUrl}/conversation/${conversationId}`;

    console.log(
      `[ChatGPTConversationsService] Fetching conversation: ${conversationId}`,
    );

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      
      // Check if it's a Cloudflare challenge
      if (errorText.includes("challenge-platform") || errorText.includes("_cf_chl_opt")) {
        throw new Error(
          `Cloudflare bot protection blocked the request. Try using the ChatGPT web interface to view this conversation, or wait and try again later.`,
        );
      }
      
      throw new Error(
        `Failed to fetch conversation ${conversationId}: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}`,
      );
    }

    return await response.json();
  }
}

/**
 * Agent Service - Main process service for managing AI agents
 *
 * Responsibilities:
 * - Manage parallel chat sessions for concurrent streaming
 * - Handle streaming responses with proper chatId routing
 * - Coordinate with StorageManager for persistence
 * - Generate chat titles
 * - Export chats to ~/Papr/ folder
 */

import path from "path";
import os from "os";
import { v4 as uuidv4 } from 'uuid';
import { streamText } from 'ai';
import { ToolRegistry } from "../../core/agents/ToolRegistry.js";
import {
  allTools,
  sanitizeToolOutput,
  truncateResult,
  getApiKeysForSanitization,
} from "../../core/tools/index.js";
import { buildSystemPrompt } from "../../core/agents/SystemPrompt.js";
import type { StreamChunk } from "../../core/types/index.js";
import type { AgentConfigInternal } from "../../core/types/agents.js";
import { StorageManager } from './StorageManager.js';
import { ChatSessionManager } from './ChatSessionManager.js';
import { TitleGenerationService } from './TitleGenerationService.js';
import { ChatExporter } from './storage/ChatExporter.js';
import type { StoredMessage } from './storage/IStorageProvider.js';

export class AgentService {
  private storageManager: StorageManager;
  private sessionManager: ChatSessionManager;
  private titleService: TitleGenerationService | null = null;
  private chatExporter: ChatExporter;
  private toolRegistry: ToolRegistry;
  private userDataPath: string;
  private systemPrompt: string;
  private initialized: boolean = false;
  private keysLoaded: boolean = false;
  private storageMode: 'local' | 'papr' | 'hybrid' = 'local';

  constructor() {
    // Use home directory for user data
    const homeDir = os.homedir();
    this.userDataPath = path.join(homeDir, ".paprwork-v2");
    
    this.storageManager = new StorageManager();
    this.sessionManager = new ChatSessionManager(this.storageManager);
    this.chatExporter = new ChatExporter();
    this.toolRegistry = new ToolRegistry();
    this.systemPrompt = ""; // Will be built during initialization
  }

  /**
   * Initialize agent service with storage and tools
   * NOTE: Keys are NOT loaded here - they're lazy-loaded on first message
   */
  async initialize(storageConfig: {
    mode: 'local' | 'papr' | 'hybrid';
    userDataPath?: string;  // Optional override for testing
    paprApiKey?: string;
    openaiApiKey?: string;
  }): Promise<void> {
    if (this.initialized) return;

    this.storageMode = storageConfig.mode;

    // Use provided userDataPath or default
    if (storageConfig.userDataPath) {
      this.userDataPath = storageConfig.userDataPath;
    }

    // Initialize storage (starts in local mode if keys not provided)
    await this.storageManager.initialize({
      mode: storageConfig.mode,
      userDataPath: this.userDataPath,
      paprApiKey: storageConfig.paprApiKey,
      paprBaseUrl: process.env.PAPR_BASE_URL,
    });

    // Initialize chat exporter (creates ~/Papr/ folder)
    await this.chatExporter.initialize();

    // Initialize title service if OpenAI key is available
    if (storageConfig.openaiApiKey) {
      this.titleService = new TitleGenerationService(storageConfig.openaiApiKey);
      this.keysLoaded = true;
    }

    // Register all available tools
    for (const tool of allTools) {
      this.toolRegistry.register(tool as any);
    }

    // Build system prompt with available tools and keys
    this.systemPrompt = buildSystemPrompt({
      userDataPath: this.userDataPath,
      workspacePath: process.cwd(),
      availableTools: allTools.map(t => t.id),
      customKeys: [], // Will be updated when keys are loaded
    });

    console.log(`✓ AgentService initialized`);
    console.log(`  Storage mode: ${storageConfig.mode}`);
    console.log(`  Tools loaded: ${allTools.length}`);
    console.log(`  System prompt: ${this.systemPrompt.length} characters`);
    this.initialized = true;
  }

  /**
   * Lazy-load API keys (only called on first message)
   * This ensures ZERO keychain popups on app startup
   */
  private async ensureKeysLoaded(): Promise<void> {
    if (this.keysLoaded) return;

    console.log('[AgentService] Lazy-loading API keys (first message)...');
    
    try {
      const { getApiKeys } = await import("../utils/keyResolver.js");
      const keys = await getApiKeys(["PAPR_API_KEY", "OPENAI_API_KEY"]);
      
      // Upgrade storage if PAPR key becomes available
      if (keys.PAPR_API_KEY && this.storageMode !== 'local') {
        console.log('[AgentService] PAPR key available - upgrading to hybrid mode');
        await this.storageManager.initialize({
          mode: 'hybrid',
          userDataPath: this.userDataPath,
          paprApiKey: keys.PAPR_API_KEY,
          paprBaseUrl: process.env.PAPR_BASE_URL,
        });
      }

      // Initialize title service if OpenAI key is available
      if (keys.OPENAI_API_KEY && !this.titleService) {
        this.titleService = new TitleGenerationService(keys.OPENAI_API_KEY);
        console.log('[AgentService] Title generation enabled');
      }

      this.keysLoaded = true;
      console.log('[AgentService] Keys loaded successfully');
    } catch (error) {
      console.warn('[AgentService] Failed to load keys:', error);
      // Continue with local mode
      this.keysLoaded = true; // Don't try again
    }
  }

  // ===== Chat Management =====

  /**
   * Create a new chat (or use existing temp chat)
   */
  async createChat(chatId?: string, title?: string): Promise<string> {
    const finalChatId = chatId || uuidv4(); // Just UUID, no "chat-" prefix (prefix is only for UI tab IDs)
    await this.storageManager.createChat(finalChatId, title || 'New Chat');
    return finalChatId;
  }

  /**
   * Generate title for a chat based on first message
   * Uses gpt-5-mini-2025-08-07 for fast, cheap title generation
   */
  async generateChatTitle(chatId: string, firstMessage: string): Promise<string> {
    // Ensure keys are loaded (needed for title generation)
    await this.ensureKeysLoaded();
    
    if (!this.titleService) {
      // No OpenAI key available, use smart fallback
      console.log('[AgentService] No title service available, using fallback');
      
      // Use the same fallback logic as TitleGenerationService
      const fallback = this.generateFallbackTitle(firstMessage);
      await this.storageManager.updateChat(chatId, { title: fallback });
      return fallback;
    }

    // Generate with AI (async, non-blocking)
    const title = await this.titleService.generateTitle(firstMessage);
    await this.storageManager.updateChat(chatId, { title });
    
    console.log(`✓ Generated title for ${chatId}: "${title}"`);
    return title;
  }

  /**
   * Fallback title generation (when OpenAI key not available)
   * Same logic as TitleGenerationService.fallbackTitle()
   */
  private generateFallbackTitle(message: string): string {
    // Clean up the message
    let title = message
      .replace(/\n/g, ' ')           // Remove newlines
      .replace(/\s+/g, ' ')           // Collapse multiple spaces
      .trim();

    // Remove common prefixes
    const prefixes = [
      'can you ',
      'could you ',
      'please ',
      'i want to ',
      'i need to ',
      'how do i ',
      'how can i ',
      'what is ',
      'what are ',
      'why ',
      'when ',
      'where ',
      'who ',
    ];
    
    const lowerTitle = title.toLowerCase();
    for (const prefix of prefixes) {
      if (lowerTitle.startsWith(prefix)) {
        title = title.substring(prefix.length);
        // Capitalize first letter
        title = title.charAt(0).toUpperCase() + title.slice(1);
        break;
      }
    }

    // Truncate if too long
    if (title.length > 40) {
      // Try to break at word boundary
      const truncated = title.substring(0, 40);
      const lastSpace = truncated.lastIndexOf(' ');
      
      if (lastSpace > 20) {
        title = truncated.substring(0, lastSpace) + '...';
      } else {
        title = truncated + '...';
      }
    }

    return title || 'New Chat';
  }

  /**
   * Update chat title
   */
  async updateChatTitle(chatId: string, title: string): Promise<void> {
    await this.storageManager.updateChat(chatId, { title });
  }

  // ===== Streaming with Parallel Support =====

  /**
   * Stream agent response with full persistence and parallel support
   * Each chat streams independently with its own session
   * 
   * @param config - Must include apiKey (fetched via IPC in WebSocket handler)
   */
  async *streamAgent(
    chatId: string,
    userMessage: string,
    config: AgentConfigInternal,
  ): AsyncGenerator<StreamChunk & { chatId: string }> {
    if (!this.initialized) {
      throw new Error('AgentService not initialized');
    }

    // Lazy-load API keys on first message (no keychain popup on startup!)
    await this.ensureKeysLoaded();

    // Get or create chat session (supports parallel streaming)
    // Note: chatId should already be permanent (created via chat:create before streaming)
    const session = await this.sessionManager.getSession(chatId, config);
    
    // Create abort controller for this stream
    const abortController = new AbortController();
    this.sessionManager.setAbortController(chatId, abortController);
    this.sessionManager.setStreaming(chatId, true);

    // Track response state for error recovery
    let assistantText = '';
    let thinkingText = '';
    const toolCalls: any[] = [];
    const toolResults: any[] = [];

    try {
      // 1. Save user message
      const userMsg: StoredMessage = {
        id: `msg-${uuidv4()}`,
        chat_id: chatId,
        role: 'user',
        content: userMessage,
        timestamp: new Date().toISOString(),
        sync_status: 'local',
      };
      await this.storageManager.saveMessage(chatId, userMsg);

      // 2. Load message history for LLM context
      const history = await this.storageManager.loadMessagesForLLM(chatId);

      // 3. Stream response from Mastra agent

      // Convert stored messages to AI SDK format
      const messages = history
        .map((msg: any) => {
          // Extract role
          const role = (msg.role || msg.message_role) as 'user' | 'assistant' | 'system';
          
          // Extract content - handle both string and object formats
          let content: string;
          if (typeof msg.content === 'object' && msg.content?.text) {
            // Content is an object with { text, thinking, toolCalls }
            content = msg.content.text;
          } else if (typeof msg.content === 'string') {
            // Content is a plain string
            content = msg.content;
          } else if (msg.message) {
            // Fallback to legacy 'message' field
            content = msg.message;
          } else {
            // Invalid message - skip it
            return null;
          }
          
          // Ensure role is valid
          if (!role || !['user', 'assistant', 'system'].includes(role)) {
            return null;
          }
          
          return { role, content };
        })
        .filter((msg): msg is { role: 'user' | 'assistant' | 'system'; content: string } => msg !== null);

      // Add system prompt if not already in history
      // Use provided system prompt or default
      const systemPrompt = config.systemPrompt || this.systemPrompt;
      if (systemPrompt && !messages.some(m => m.role === 'system')) {
        messages.unshift({
          role: 'system',
          content: systemPrompt,
        });
      }

      // Add current user message
      messages.push({
        role: 'user',
        content: userMessage,
      });

      // Get model from session
      const model = (session.agent as any).model;

      // Prepare provider options for reasoning models
      const providerOptions: any = {};
      
      // For OpenAI GPT-5.x models with reasoning effort and summary
      if (config.provider === 'openai' && config.reasoning?.effort) {
        providerOptions.openai = {
          reasoningEffort: config.reasoning.effort, // 'low' | 'medium' | 'high' | 'xhigh'
          reasoningSummary: 'detailed', // Enable detailed reasoning summaries for streaming
        };
      }

      // Get registered tools for the model
      const tools = this.toolRegistry.getToolsForMastra();
      
      // DEBUG: Log context size to diagnose context_length_exceeded
      const messagesJson = JSON.stringify(messages);
      const toolsJson = JSON.stringify(tools);
      const estimatedTokens = Math.ceil(messagesJson.length / 4);
      const toolTokens = Math.ceil(toolsJson.length / 4);
      console.log(`[AgentService] Context breakdown:`);
      console.log(`  Messages: ${messages.length} messages, ~${estimatedTokens} tokens`);
      console.log(`  Tools: ${Object.keys(tools).length} tools, ~${toolTokens} tokens`);
      console.log(`  Total: ~${estimatedTokens + toolTokens} tokens`);
      messages.forEach((msg, i) => {
        const msgTokens = Math.ceil(msg.content.length / 4);
        console.log(`    Msg ${i} (${msg.role}): ${msgTokens} tokens`);
      });
      
      // Stream from AI SDK directly with abort signal and tools
      const result = await streamText({
        model,
        messages,
        tools: tools as any, // Cast due to AI SDK's complex ToolSet type
        // Allow up to 100 steps (tool roundtrips) before stopping
        // High limit allows complex multi-tool workflows to complete naturally
        // LLMs are smart enough to stop on their own when done
        stopWhen: (options) => options.steps.length >= 100,
        // Safety timeout: 5 minutes max for entire generation
        timeout: { totalMs: 5 * 60 * 1000 },
        abortSignal: abortController.signal,
        ...(Object.keys(providerOptions).length > 0 && { providerOptions }),
      });

      // Use fullStream to get all chunk types (text, reasoning, tool calls, etc.)
      // This gives us access to reasoning-delta chunks for thinking tokens
      const TEXT_BUFFER_MIN = 50; // chars before emitting (vs. per-token)
      let textBuffer = '';
      let reasoningBuffer = '';

      for await (const chunk of result.fullStream) {
        // Debug: Log chunk types to see what we're receiving
        if (chunk.type !== 'text-delta') {
          console.log(`[AgentService] Received chunk type: ${chunk.type}`);
        }
        
        switch (chunk.type) {
          case 'text-delta': {
            // Text content
            assistantText += chunk.text;
            textBuffer += chunk.text;

            if (textBuffer.length >= TEXT_BUFFER_MIN) {
              yield {
                type: 'text-delta',
                payload: { text: textBuffer },
                chatId,
              } as any;
              textBuffer = '';
            }
            break;
          }

          case 'reasoning-start': {
            // Reasoning started (Responses API with reasoningSummary)
            console.log('[AgentService] Reasoning started');
            break;
          }

          case 'reasoning-delta': {
            // Reasoning/thinking content from Responses API (GPT-5.x models)
            // With reasoningSummary: 'detailed', we get token-by-token streaming
            const reasoningText = chunk.text || '';
            thinkingText += reasoningText;
            reasoningBuffer += reasoningText;

            if (reasoningBuffer.length >= TEXT_BUFFER_MIN) {
              yield {
                type: 'reasoning-delta',
                payload: { text: reasoningBuffer },
                chatId,
              } as any;
              reasoningBuffer = '';
            }
            break;
          }

          case 'reasoning-end': {
            // Reasoning completed
            console.log('[AgentService] Reasoning ended');
            
            // Flush any remaining reasoning buffer
            if (reasoningBuffer.length > 0) {
              yield {
                type: 'reasoning-delta',
                payload: { text: reasoningBuffer },
                chatId,
              } as any;
              reasoningBuffer = '';
            }
            break;
          }

          case 'tool-call': {
            // Tool call initiated by the model
            const toolCall = {
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              args: (chunk as any).input || (chunk as any).args,
            };
            toolCalls.push(toolCall);
            
            yield {
              type: 'tool-call',
              payload: toolCall,
              chatId,
            } as any;
            break;
          }

          case 'tool-result': {
            // Tool execution result
            // CRITICAL: Sanitize and truncate before streaming to prevent:
            // 1. API key leakage in tool output
            // 2. Token overflow from large results
            const rawResult = (chunk as any).output || (chunk as any).result;
            const apiKeys = getApiKeysForSanitization();
            
            // Sanitize recursively (handles nested objects/arrays)
            let sanitizedResult = sanitizeToolOutput(rawResult, apiKeys);
            
            // DEBUG: Log raw result size BEFORE truncation
            const rawSize = typeof rawResult === 'string' ? rawResult.length : JSON.stringify(rawResult).length;
            console.log(`[AgentService] Tool ${chunk.toolName || 'unknown'} raw result: ${rawSize} chars`);
            
            // Truncate if string (structured data stays as-is)
            if (typeof sanitizedResult === 'string') {
              const truncated = truncateResult(sanitizedResult);
              console.log(`[AgentService] After truncation: ${truncated.length} chars`);
              sanitizedResult = truncated;
            } else if (sanitizedResult && typeof sanitizedResult === 'object') {
              // For structured results, truncate string fields
              const truncateStrings = (obj: any): any => {
                if (typeof obj === 'string') {
                  return truncateResult(obj);
                }
                if (Array.isArray(obj)) {
                  return obj.map(truncateStrings);
                }
                if (obj && typeof obj === 'object') {
                  const result: any = {};
                  for (const [key, value] of Object.entries(obj)) {
                    result[key] = truncateStrings(value);
                  }
                  return result;
                }
                return obj;
              };
              sanitizedResult = truncateStrings(sanitizedResult);
            }
            
            const toolResult = {
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              result: sanitizedResult,
            };
            toolResults.push(toolResult);
            
            yield {
              type: 'tool-result',
              payload: toolResult,
              chatId,
            } as any;
            break;
          }

          case 'error': {
            // Stream error - sanitize to prevent key leakage
            const apiKeys = getApiKeysForSanitization();
            const sanitizedError = sanitizeToolOutput(chunk.error, apiKeys);
            
            yield {
              type: 'error',
              payload: { error: sanitizedError },
              chatId,
            } as any;
            break;
          }

          case 'tool-error': {
            // Tool execution error - sanitize to prevent key leakage
            const apiKeys = getApiKeysForSanitization();
            const toolError = chunk as any;
            const sanitizedError = sanitizeToolOutput(
              toolError.error || JSON.stringify(toolError),
              apiKeys
            );
            
            console.error(`[AgentService] Tool error (${toolError.toolName || 'unknown'}):`, sanitizedError);
            
            yield {
              type: 'tool-error',
              payload: {
                toolCallId: toolError.toolCallId,
                toolName: toolError.toolName,
                error: sanitizedError,
              },
              chatId,
            } as any;
            break;
          }

          case 'finish': {
            // Stream finished
            // The finish chunk contains usage info, final reasoning, etc.
            break;
          }

          // Ignore other chunk types for now
          default:
            break;
        }
      }

      // Flush remaining buffers
      if (textBuffer.length > 0) {
        yield {
          type: 'text-delta',
          payload: { text: textBuffer },
          chatId,
        } as any;
      }

      if (reasoningBuffer.length > 0) {
        yield {
          type: 'reasoning-delta',
          payload: { text: reasoningBuffer },
          chatId,
        } as any;
      }

      // 4. Save assistant message with thinking and tool calls
      const assistantMsg: StoredMessage = {
        id: `msg-${uuidv4()}`,
        chat_id: chatId,
        role: 'assistant',
        content: assistantText,
        thinking: thinkingText || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls.map(tc => ({
          id: tc.toolCallId,
          name: tc.toolName,
          args: tc.args,
          result: toolResults.find(tr => tr.toolCallId === tc.toolCallId)?.result,
          status: 'success' as const,
        })) : undefined,
        timestamp: new Date().toISOString(),
        model: config.model,
        sync_status: 'local',
      };
      await this.storageManager.saveMessage(chatId, assistantMsg);

      // 5. Export chat to ~/Papr/ folder
      const allMessages = await this.storageManager.loadMessages(chatId);
      const chatMeta = await this.storageManager.getChat(chatId);
      await this.chatExporter.exportChat(chatId, chatMeta?.title || null, allMessages);

      // 6. Check if summarization is needed (50K tokens threshold)
      const stats = await this.storageManager.getChatStats(chatId);
      if (stats.token_count > 50000) {
        // Trigger summarization in background (don't await)
        this.triggerSummarization(chatId).catch(console.error);
      }

    } catch (error) {
      // Save partial assistant message with error indicator
      // This ensures user sees what happened when they reopen the chat
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      let errorContent = assistantText;
      if (!errorContent && toolCalls.length > 0) {
        // If there was no text but there were tool calls, show the tool context
        errorContent = `⚠️ Response interrupted after ${toolCalls.length} tool call(s)`;
      }
      if (!errorContent) {
        errorContent = '❌ An error occurred while generating the response';
      }
      
      // Append error info to content
      errorContent += `\n\n---\n❌ **Error**: ${errorMessage}`;
      
      const errorMsg: StoredMessage = {
        id: `msg-${uuidv4()}`,
        chat_id: chatId,
        role: 'assistant',
        content: errorContent,
        thinking: thinkingText || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls.map(tc => ({
          id: tc.toolCallId,
          name: tc.toolName,
          args: tc.args,
          result: toolResults.find(tr => tr.toolCallId === tc.toolCallId)?.result,
          status: 'error' as const,
        })) : undefined,
        error: errorMessage,
        incomplete: true,
        timestamp: new Date().toISOString(),
        model: config.model,
        sync_status: 'local',
      };
      
      try {
        await this.storageManager.saveMessage(chatId, errorMsg);
        console.log(`[AgentService] Saved partial response with error for chat ${chatId}`);
      } catch (saveError) {
        console.error(`[AgentService] Failed to save error message:`, saveError);
      }
      
      // Re-throw to propagate to WebSocket handler
      throw error;
    } finally {
      // Clear streaming state
      this.sessionManager.setStreaming(chatId, false);
      this.sessionManager.setAbortController(chatId, null as any);
    }
  }

  /**
   * Stop streaming for a specific chat
   */
  async stopStreaming(chatId: string): Promise<void> {
    await this.sessionManager.abortSession(chatId);
  }

  /**
   * Trigger summarization for a chat (background operation)
   */
  private async triggerSummarization(chatId: string): Promise<void> {
    try {
      console.log(`🔄 Triggering summarization for chat ${chatId}`);
      const summary = await this.storageManager.fetchAndCacheSummary(chatId);
      
      if (summary) {
        console.log(`✓ Summary cached for chat ${chatId}`);
        console.log(`  Topics: ${summary.topics?.join(', ')}`);
      }
    } catch (error) {
      console.error(`Failed to generate summary for chat ${chatId}:`, error);
    }
  }

  // ===== Chat Operations =====

  /**
   * Get chat history
   */
  async getChatHistory(chatId: string): Promise<StoredMessage[]> {
    return await this.storageManager.loadMessages(chatId);
  }

  /**
   * Delete a chat
   */
  async deleteChat(chatId: string): Promise<void> {
    // Clear session if active
    await this.sessionManager.clearSession(chatId);
    
    // Delete from storage
    await this.storageManager.deleteChat(chatId);
  }

  /**
   * List all chats
   */
  async listChats() {
    return await this.storageManager.listChats();
  }

  /**
   * Get chat stats
   */
  async getChatStats(chatId: string) {
    return await this.storageManager.getChatStats(chatId);
  }

  // ===== Session Management =====

  /**
   * Get all active streaming sessions
   */
  getActiveSessions() {
    return this.sessionManager.getAllActiveSessions();
  }

  /**
   * Check if a chat is currently streaming
   */
  isStreaming(chatId: string): boolean {
    return this.sessionManager.isStreaming(chatId);
  }

  /**
   * Get tool registry
   */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  /**
   * Get storage manager
   */
  getStorageManager(): StorageManager {
    return this.storageManager;
  }

  /**
   * Get session manager
   */
  getSessionManager(): ChatSessionManager {
    return this.sessionManager;
  }

  /**
   * Get title service
   */
  getTitleService(): TitleGenerationService | null {
    return this.titleService;
  }

  /**
   * Update OpenAI API key (for title generation)
   */
  setOpenAIApiKey(apiKey: string): void {
    if (!this.titleService) {
      this.titleService = new TitleGenerationService(apiKey);
    } else {
      this.titleService.setApiKey(apiKey);
    }
  }

  /**
   * Shutdown service - cleanup all sessions
   */
  async shutdown(): Promise<void> {
    console.log("[AgentService] Shutting down");
    await this.sessionManager.clearAllSessions();
  }
}

// Singleton instance
let agentServiceInstance: AgentService | null = null;

/**
 * Get or create AgentService singleton
 */
export function getAgentService(): AgentService {
  if (!agentServiceInstance) {
    agentServiceInstance = new AgentService();
  }
  return agentServiceInstance;
}

/**
 * Initialize AgentService (call on app ready)
 */
export async function initializeAgentService(config: {
  mode: 'local' | 'papr' | 'hybrid';
  paprApiKey?: string;
  openaiApiKey?: string;
}): Promise<AgentService> {
  const service = getAgentService();
  await service.initialize(config);
  return service;
}

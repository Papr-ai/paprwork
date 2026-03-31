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
import { v4 as uuidv4 } from "uuid";
import { streamText, generateObject, jsonSchema } from "ai";
import type { LanguageModel, ToolSet, StepResult } from "ai";
import { ToolRegistry } from "../../core/agents/ToolRegistry.js";
import { allTools, getApiKeysForSanitization } from "../../core/tools/index.js";
import { buildSystemPrompt } from "../../core/agents/SystemPrompt.js";
import type {
  StreamChunk,
  TextDeltaPayload,
  ReasoningDeltaPayload,
  ToolCallPayload,
  ToolResultPayload,
  ErrorPayload,
} from "../../core/types/index.js";
import type { AgentConfigInternal, Provider } from "../../core/types/agents.js";
import { StorageManager } from "./StorageManager.js";
import { ChatSessionManager } from "./ChatSessionManager.js";
import { TitleGenerationService } from "./TitleGenerationService.js";
import { getSkillService, type SkillRecord } from "./SkillService.js";
import { ChatExporter } from "./storage/ChatExporter.js";
import type { StoredMessage } from "./storage/IStorageProvider.js";
import { generateFallbackTitle } from "./agent/fallbackTitle.js";
import { buildModelMessages } from "./agent/historyFormatter.js";
import {
  type ToolCallEvent,
  type ToolResultEvent,
} from "./agent/streamChunks.js";
import { orchestrateModelStream } from "./agent/streamOrchestrator.js";
import {
  createAssistantStoredMessage,
  createErrorStoredMessage,
} from "./agent/messagePersistence.js";
import { getWorkspaceService } from "./WorkspaceService.js";
import type { WorkspaceContextData } from "../../core/agents/SystemPrompt.js";

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
  private storageMode: "local" | "papr" | "hybrid" = "local";

  private readonly appAutomationToolIds = new Set([
    "create_app",
    "list_apps",
    "create_job",
    "run_job",
    "link_app_data_source",
  ]);

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
    mode: "local" | "papr" | "hybrid";
    userDataPath?: string; // Optional override for testing
    paprApiKey?: string;
    openaiApiKey?: string;
  }): Promise<void> {
    if (this.initialized) return;

    this.storageMode = storageConfig.mode;

    // Use provided userDataPath or default
    if (storageConfig.userDataPath) {
      this.userDataPath = storageConfig.userDataPath;
    }

    console.log("[AgentService] Initializing storage...");
    // Initialize storage (starts in local mode if keys not provided)
    await this.storageManager.initialize({
      mode: storageConfig.mode,
      userDataPath: this.userDataPath,
      paprApiKey: storageConfig.paprApiKey,
    });
    console.log("[AgentService] Storage initialized");

    console.log("[AgentService] Initializing chat exporter...");
    // Initialize chat exporter (creates ~/Papr/ folder)
    await this.chatExporter.initialize();
    console.log("[AgentService] Chat exporter initialized");

    // Initialize title service (no API key needed, handles OAuth/API key routing internally)
    this.titleService = new TitleGenerationService();
    console.log("[AgentService] Title service initialized");

    console.log("[AgentService] Registering tools...");
    // Register all available tools
    for (const tool of allTools) {
      const registryTool = tool as unknown as Parameters<
        ToolRegistry["register"]
      >[0];
      this.toolRegistry.register(registryTool);
    }
    console.log("[AgentService] Tools registered");

    console.log("[AgentService] Building system prompt...");
    // Build compact default prompt.
    // Extended app playbook is injected contextually per request.
    this.systemPrompt = buildSystemPrompt({
      userDataPath: this.userDataPath,
      workspacePath: process.cwd(),
      availableTools: allTools.map((t) => t.id),
      customKeys: [], // Will be updated when keys are loaded
      includeExtendedAppPlaybook: false,
    });
    console.log("[AgentService] System prompt built");

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

    console.log("[AgentService] Lazy-loading API keys (first message)...");

    try {
      const { getApiKeys } = await import("../utils/keyResolver.js");
      const keys = await getApiKeys(["PAPR_API_KEY", "OPENAI_API_KEY"]);

      // Upgrade storage to hybrid mode if PAPR key is available
      // This always runs on first message - gateway starts in local mode,
      // then upgrades to hybrid once we can confirm the PAPR key exists
      if (keys.PAPR_API_KEY) {
        console.log(
          "[AgentService] PAPR key available - upgrading to hybrid mode",
        );
        await this.storageManager.initialize({
          mode: "hybrid",
          userDataPath: this.userDataPath,
          paprApiKey: keys.PAPR_API_KEY,
        });
        this.storageMode = "hybrid";
      } else {
        console.log("[AgentService] No PAPR key found - staying in local mode");
      }

      // Title service initialized at startup (handles OAuth/API key routing internally)
      if (!this.titleService) {
        this.titleService = new TitleGenerationService();
        console.log("[AgentService] Title generation enabled");
      }

      // Only mark keys as fully loaded once we're in hybrid mode (or confirmed no PAPR key)
      this.keysLoaded = true;
      console.log(
        `[AgentService] Keys loaded. Storage mode: ${this.storageMode}`,
      );
    } catch (error) {
      console.warn("[AgentService] Failed to load keys:", error);
      // Don't set keysLoaded=true on error so we retry next message
      // But avoid infinite retry loops by marking loaded after N failures (handled by caller)
    }
  }

  // ===== Chat Management =====

  /**
   * Create a new chat (or use existing temp chat)
   */
  async createChat(chatId?: string, title?: string): Promise<string> {
    const finalChatId = chatId || uuidv4(); // Just UUID, no "chat-" prefix (prefix is only for UI tab IDs)
    await this.storageManager.createChat(finalChatId, title || "New Chat");
    return finalChatId;
  }

  /**
   * Generate title for a chat based on first message
   * Uses gpt-5-mini-2025-08-07 for fast, cheap title generation
   */
  async generateChatTitle(
    chatId: string,
    firstMessage: string,
  ): Promise<string> {
    // Ensure keys are loaded (needed for title generation)
    await this.ensureKeysLoaded();

    if (!this.titleService) {
      // No OpenAI key available, use smart fallback
      console.log("[AgentService] No title service available, using fallback");

      const fallback = generateFallbackTitle(firstMessage);
      await this.storageManager.updateChat(chatId, { title: fallback });
      
      // Broadcast chat list update
      const { broadcast } = await import("../websocket/index.js");
      broadcast({ type: "chat:list-updated" });
      
      return fallback;
    }

    // Generate with AI (async, non-blocking)
    const title = await this.titleService.generateTitle(firstMessage);
    await this.storageManager.updateChat(chatId, { title });

    console.log(`✓ Generated title for ${chatId}: "${title}"`);
    
    // Broadcast chat list update
    const { broadcast } = await import("../websocket/index.js");
    broadcast({ type: "chat:list-updated" });
    
    return title;
  }

  /**
   * Update chat title
   */
  async updateChatTitle(chatId: string, title: string): Promise<void> {
    await this.storageManager.updateChat(chatId, { title });
    
    // Broadcast chat list update
    const { broadcast } = await import("../websocket/index.js");
    broadcast({ type: "chat:list-updated" });
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
    options?: { allowedToolIds?: string[]; maxSteps?: number },
  ): AsyncGenerator<StreamChunk & { chatId: string }> {
    if (!this.initialized) {
      throw new Error("AgentService not initialized");
    }

    // ⏱️ PERFORMANCE TRACKING
    const perfStart = performance.now();
    const timings: Record<string, number> = {};
    let t = performance.now();

    // Lazy-load API keys on first message (no keychain popup on startup!)
    await this.ensureKeysLoaded();
    timings.ensureKeys = performance.now() - t;

    // Get or create chat session (supports parallel streaming)
    // Note: chatId should already be permanent (created via chat:create before streaming)
    t = performance.now();
    const session = await this.sessionManager.getSession(chatId, config);
    timings.getSession = performance.now() - t;

    // Create abort controller for this stream
    const abortController = new AbortController();
    this.sessionManager.setAbortController(chatId, abortController);
    this.sessionManager.setStreaming(chatId, true);

    // Track response state for error recovery
    let assistantText = "";
    let thinkingText = "";
    let toolCalls: ToolCallEvent[] = [];
    let toolResults: ToolResultEvent[] = [];
    let sequence: Array<{ type: "text" | "tool" | "thinking"; data: any }> = [];
    let tokenUsage:
      | { promptTokens: number; completionTokens: number; totalTokens: number }
      | undefined;

    // Context pressure monitoring — declared here so catch block can read them
    // 150k = 75% of Claude's 200k window; safe abort margin for tool-heavy loops
    const CONTEXT_ABORT_THRESHOLD = 120000; // Conservative: leave room for output tokens
    let contextPressureAborted = false;

    try {
      // 1. Save user message
      t = performance.now();
      const userMsg: StoredMessage = {
        id: `msg-${uuidv4()}`,
        chat_id: chatId,
        role: "user",
        content: userMessage,
        timestamp: new Date().toISOString(),
        sync_status: "local",
      };
      await this.storageManager.saveMessage(chatId, userMsg);
      timings.saveUserMessage = performance.now() - t;

      // 2. Load message history for LLM context
      t = performance.now();
      const historyRaw = await this.storageManager.loadMessagesForLLM(chatId);

      // Extract summary if present (injected by storage providers)
      let conversationSummary: string | undefined;
      
      // DEBUG: Check historyRaw before filtering
      if (historyRaw.length > 0) {
        console.log(`[AgentService] 🔍 historyRaw[0] keys:`, Object.keys(historyRaw[0]));
        if (historyRaw.length > 1) {
          console.log(`[AgentService] 🔍 historyRaw[1] keys:`, Object.keys(historyRaw[1]));
          console.log(`[AgentService] 🔍 historyRaw[1]:`, JSON.stringify(historyRaw[1]).substring(0, 200));
        }
      }
      
      const history = historyRaw.filter((msg) => {
        if (typeof msg === "object" && msg !== null && "__summary" in msg) {
          conversationSummary = (msg as { __summary: string }).__summary;
          return false; // Remove from history
        }
        return true; // Keep in history
      });

      timings.loadHistory = performance.now() - t;

      console.log(`[AgentService] 📥 Loaded ${historyRaw.length} messages from storage (before summary extraction)`);
      console.log(`[AgentService] 📥 After summary extraction: ${history.length} messages`);
      
      // DEBUG: Check what fields exist in first message
      if (history.length > 0) {
        console.log(`[AgentService] 🔍 First message keys:`, Object.keys(history[0]));
        console.log(`[AgentService] 🔍 First message:`, JSON.stringify(history[0]).substring(0, 200));
      }
      
      // Log FIRST 5 and LAST 10 messages from raw history to debug ordering
      console.log(`[AgentService] 📋 FIRST 5 messages in history array:`);
      history.slice(0, 5).forEach((msg: any, i: number) => {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const preview = content.substring(0, 60);
        // Try to extract timestamp if available
        const timestamp = msg.timestamp || msg.createdAt || 'no-timestamp';
        console.log(`  [${i}] ${msg.role} [${timestamp}]: ${preview}...`);
      });
      
      console.log(`[AgentService] 📋 LAST 10 messages in history array:`);
      const startIdx = Math.max(0, history.length - 10);
      history.slice(startIdx).forEach((msg: any, i: number) => {
        const actualIdx = startIdx + i;
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const preview = content.substring(0, 60);
        const timestamp = msg.timestamp || msg.createdAt || 'no-timestamp';
        console.log(`  [${actualIdx}] ${msg.role} [${timestamp}]: ${preview}...`);
      });

      const historyCount = history.length;
      const historySize = JSON.stringify(history).length;
      const estimatedHistoryTokens = Math.ceil(historySize / 4);

      // 3. Gather enabled skills for system prompt context
      t = performance.now();
      let enabledSkills:
        | Array<{ id: string; name: string; description: string }>
        | undefined;
      try {
        const skillService = getSkillService();
        const allSkills = await skillService.listSkills();
        const active = allSkills.filter((s: SkillRecord) => s.enabled);
        console.log(`[AgentService] 📚 Loaded ${active.length} enabled skills for system prompt`);
        if (active.length > 0) {
          enabledSkills = active.map((s: SkillRecord) => ({
            id: s.id,
            name: s.name,
            description: s.description,
          }));
          console.log(`[AgentService] Skills sample: ${enabledSkills.slice(0, 3).map(s => s.name).join(', ')}...`);
        }
      } catch (error) {
        console.warn('[AgentService] ⚠️  Skills not initialized yet:', (error as Error).message);
        // Skills not initialized yet — proceed without them
      }
      timings.loadSkills = performance.now() - t;

      // 4. Build system prompt and messages
      t = performance.now();
      const systemPrompt =
        config.systemPrompt ||
        (await this.buildContextualSystemPrompt(
          chatId,
          history,
          enabledSkills,
        ));
      const messages = buildModelMessages(
        history,
        userMessage,
        systemPrompt,
        conversationSummary,
      );
      timings.buildMessages = performance.now() - t;

      // DEBUG: Log message structure to debug empty content blocks
      console.log(
        `[AgentService] 🔍 Built ${messages.length} messages for model:`,
      );
      messages.forEach((msg, i) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const textParts = msg.content.filter((p: any) => p.type === "text");
          const toolCallParts = msg.content.filter(
            (p: any) => p.type === "tool-call",
          );
          console.log(
            `  ${i}. assistant: ${textParts.length} text parts, ${toolCallParts.length} tool-call parts`,
          );
          textParts.forEach((p: any, j: number) => {
            console.log(
              `    text[${j}]: "${p.text.substring(0, 50)}${p.text.length > 50 ? "..." : ""}"`,
            );
          });
        } else if (msg.role === "tool") {
          console.log(
            `  ${i}. tool: ${Array.isArray(msg.content) ? msg.content.length : 0} results`,
          );
        } else {
          const contentPreview =
            typeof msg.content === "string"
              ? msg.content.substring(0, 50)
              : JSON.stringify(msg.content).substring(0, 50);
          console.log(
            `  ${i}. ${msg.role}: "${contentPreview}${contentPreview.length >= 50 ? "..." : ""}"`,
          );
        }
      });

      // Set tool execution context (so tools can access chatId)
      const { setToolContext } = await import("../../core/tools/context.js");
      setToolContext(chatId);

      // Get model from session
      const sessionWithModel = session.agent as unknown as {
        model: LanguageModel;
      };
      const model = sessionWithModel.model;

      // Prepare provider options for reasoning models
      const providerOptions: {
        openai?: {
          reasoningEffort: "low" | "medium" | "high" | "xhigh";
          reasoningSummary: "detailed";
        };
        google?: {
          thinkingConfig: {
            includeThoughts: boolean;
            thinkingBudget?: number;
          };
        };
        ollama?: {
          think: boolean;
          options?: {
            num_ctx?: number; // Context window size (default: 4096)
            seed?: number;
            repeat_penalty?: number;
            top_k?: number;
            min_p?: number;
          };
        };
      } = {};

      // For OpenAI GPT-5.x models with reasoning effort and summary
      if (config.provider === "openai" && config.reasoning?.effort) {
        providerOptions.openai = {
          reasoningEffort: config.reasoning.effort, // 'low' | 'medium' | 'high' | 'xhigh'
          reasoningSummary: "detailed", // Enable detailed reasoning summaries for streaming
        };
      }

      // For Google Gemini models with thinking capabilities
      if (
        config.provider === "google" &&
        config.thinkingBudget !== undefined &&
        config.thinkingBudget > 0
      ) {
        providerOptions.google = {
          thinkingConfig: {
            includeThoughts: true, // Enable thought summaries in stream
            thinkingBudget: config.thinkingBudget, // Token budget for thinking
          },
        };
      }

      // For Ollama models - enable thinking mode and increase context window
      if (config.provider === "ollama") {
        providerOptions.ollama = {
          think: true, // Enable thinking mode for Qwen models (required for tool calling)
          options: {
            num_ctx: 32768, // Set context window to 32K (Qwen 3.5 supports up to 128K)
            // Default is 4096 which is too small for 70 tools (~8.5K tokens)
          },
        };
      }

      // Get registered tools for the model
      t = performance.now();
      const tools = this.toolRegistry.getToolsForMastra(
        options?.allowedToolIds,
      );
      timings.getTools = performance.now() - t;

      // Log context size breakdown
      const messagesJson = JSON.stringify(messages);
      const toolsJson = JSON.stringify(tools);
      const estimatedMessageTokens = Math.ceil(messagesJson.length / 4);
      const toolTokens = Math.ceil(toolsJson.length / 4);
      const totalEstimatedTokens = estimatedMessageTokens + toolTokens;

      console.log(`[AgentService] 📊 Context Analysis for ${chatId}:`);
      console.log(
        `  History: ${historyCount} messages, ~${estimatedHistoryTokens} tokens`,
      );
      console.log(
        `  Messages (with system): ${messages.length} messages, ~${estimatedMessageTokens} tokens`,
      );
      console.log(
        `  Tools: ${Object.keys(tools).length} tools, ~${toolTokens} tokens`,
      );
      console.log(`  Total context: ~${totalEstimatedTokens} tokens`);
      console.log(
        `  Config: maxTokens=${config.maxTokens || "NOT SET"}, maxSteps=${options?.maxSteps || 100}`,
      );
      console.log(`[AgentService] ⏱️ Setup Timing:`);
      console.log(`  Ensure keys: ${timings.ensureKeys.toFixed(2)}ms`);
      console.log(`  Get session: ${timings.getSession.toFixed(2)}ms`);
      console.log(`  Save user msg: ${timings.saveUserMessage.toFixed(2)}ms`);
      console.log(`  Load history: ${timings.loadHistory.toFixed(2)}ms`);
      console.log(`  Load skills: ${timings.loadSkills.toFixed(2)}ms`);
      console.log(`  Build messages: ${timings.buildMessages.toFixed(2)}ms`);
      console.log(`  Get tools: ${timings.getTools.toFixed(2)}ms`);
      console.log(
        `  Total setup: ${(performance.now() - perfStart).toFixed(2)}ms`,
      );

      // Stream from AI SDK directly with abort signal and tools
      t = performance.now();

      // Effective output token cap — prefer per-model config, fall back to 16k
      const effectiveMaxTokens = config.maxTokens ?? 16000;
      console.log(`[AgentService] Setting maxTokens: ${effectiveMaxTokens}`);

      let cumulativeSteps = 0;
      let cumulativePromptTokens = 0; // Track actual token usage for adaptive truncation

      const streamTextOptions: any = {
        model,
        messages,
        tools: tools as unknown as ToolSet,
        maxTokens: effectiveMaxTokens,
        // Allow up to maxSteps tool roundtrips before stopping.
        // 100 steps provides safety against infinite loops while allowing
        // complex multi-step agentic workflows.
        stopWhen: (stopOptions: any) =>
          stopOptions.steps.length >= (options?.maxSteps ?? 100),
        // ⚡ NO TIMEOUT - Allow agents to work as long as needed
        // Protection mechanisms:
        // 1. Step limit prevents infinite loops
        // 2. Context pressure monitoring (onStepFinish) aborts if prompt
        //    tokens exceed CONTEXT_ABORT_THRESHOLD
        // 3. User can abort via UI (abortController)
        abortSignal: abortController.signal,
        ...(providerOptions.openai || providerOptions.google || providerOptions.ollama
          ? { providerOptions }
          : {}),
        // Truncate tool results mid-stream to prevent context overflow
        // Strategy: Adaptive truncation based on ACTUAL token usage from previous steps
        prepareStep: async (stepOptions: {
          messages: any[];
          stepNumber: number;
          steps: Array<{
            usage?: { promptTokens?: number; completionTokens?: number };
          }>;
        }) => {
          // Use cumulative tokens tracked from onStepFinish
          // (stepOptions.steps doesn't have usage data until after the step completes)
          const totalPromptTokens = cumulativePromptTokens;

          console.log(
            `[prepareStep] Step ${stepOptions.stepNumber}: ${Math.round(totalPromptTokens / 1000)}K tokens used, ` +
              `${stepOptions.messages.length} messages in context`,
          );

          // Determine context pressure level
          // NOTE: Most models have 128K-200K context windows
          // - GPT-5.2: ~128K tokens
          // - Claude Sonnet/Opus: ~200K tokens
          // - Gemini: ~1M tokens
          // We use conservative thresholds to leave room for output + safety margin
          const CONTEXT_PRESSURE_THRESHOLDS = {
            low: 30000, // <30K tokens: generous limits
            medium: 60000, // 30-60K: moderate limits
            high: 90000, // 60-90K: aggressive limits
            critical: 120000, // >120K: abort (handled by onStepFinish)
          };

          let pressureLevel: "low" | "medium" | "high";
          if (totalPromptTokens < CONTEXT_PRESSURE_THRESHOLDS.low) {
            pressureLevel = "low";
          } else if (totalPromptTokens < CONTEXT_PRESSURE_THRESHOLDS.medium) {
            pressureLevel = "medium";
          } else {
            pressureLevel = "high";
          }

          console.log(`[prepareStep]   Pressure: ${pressureLevel}`);

          // Find all tool messages and their indices (to determine recency)
          const toolMessageIndices: number[] = [];
          stepOptions.messages.forEach((msg, idx) => {
            if (msg.role === "tool") {
              toolMessageIndices.push(idx);
            }
          });

          const totalToolMessages = toolMessageIndices.length;
          console.log(
            `[prepareStep]   Tool messages found: ${totalToolMessages}`,
          );

          // If no tool messages yet, don't modify anything
          if (totalToolMessages === 0) {
            return {};
          }

          // Adaptive truncation limits based on context pressure (1 token ≈ 4 chars)
          const getTruncationLimit = (
            toolMessagePosition: number,
          ): number | null => {
            const positionFromEnd = totalToolMessages - toolMessagePosition - 1;

            // Always keep last result unlimited
            if (positionFromEnd < 1) return null;

            // Adapt limits based on context pressure
            if (pressureLevel === "low") {
              // Low pressure: generous limits (we have room)
              if (positionFromEnd < 3) return 12000; // Next 2: 3000 tokens
              if (positionFromEnd < 6) return 6000; // Next 3: 1500 tokens
              if (positionFromEnd < 11) return 3000; // Next 5: 750 tokens
              return 1500; // Old: 375 tokens
            } else if (pressureLevel === "medium") {
              // Medium pressure: moderate limits
              if (positionFromEnd < 3) return 8000; // Next 2: 2000 tokens
              if (positionFromEnd < 6) return 4000; // Next 3: 1000 tokens
              if (positionFromEnd < 11) return 2000; // Next 5: 500 tokens
              return 1000; // Old: 250 tokens
            } else {
              // High pressure: aggressive limits (context nearly full)
              if (positionFromEnd < 3) return 4000; // Next 2: 1000 tokens
              if (positionFromEnd < 6) return 2000; // Next 3: 500 tokens
              if (positionFromEnd < 11) return 1000; // Next 5: 250 tokens
              return 500; // Old: 125 tokens
            }
          };

          // Helper function to truncate tool result (works for both strings and objects)
          const truncateToolResult = (
            result: unknown,
            maxLength: number | null,
            toolMessagePosition: number,
          ): unknown => {
            // Handle undefined/null results
            if (result === undefined || result === null) {
              return result;
            }

            // Convert result to string for size check
            const resultStr =
              typeof result === "string" ? result : JSON.stringify(result);

            // EMERGENCY: Catch absurdly large results (>50K tokens) regardless of recency
            // 50K tokens ≈ 200KB chars - max for any single tool result
            const EMERGENCY_LIMIT = 200000; // ~50K tokens
            if (resultStr.length > EMERGENCY_LIMIT) {
              const truncated = resultStr.substring(0, EMERGENCY_LIMIT);
              const omitted = resultStr.length - EMERGENCY_LIMIT;
              console.warn(
                `[prepareStep] ⚠️ EMERGENCY truncation: tool result was ${Math.round(resultStr.length / 1024)}KB, ` +
                  `truncated to ${Math.round(EMERGENCY_LIMIT / 1024)}KB`,
              );
              return (
                truncated +
                `\n\n[⚠️ EMERGENCY TRUNCATION: Result was ${Math.round(resultStr.length / 1024)}KB (${Math.round(resultStr.length / 4000)}K tokens), ` +
                `truncated ${omitted} chars. This is too large for context. ` +
                `Use more specific search patterns or incremental reading.]`
              );
            }

            // Keep unlimited for most recent (unless emergency truncation applied above)
            if (maxLength === null) {
              return result;
            }

            if (resultStr.length > maxLength) {
              const truncated = resultStr.substring(0, maxLength);
              const omitted = resultStr.length - maxLength;
              const positionFromEnd =
                totalToolMessages - toolMessagePosition - 1;
              const estimatedTokens = Math.ceil(maxLength / 4);
              return (
                truncated +
                `\n\n[... ${omitted} chars truncated (tool #${positionFromEnd + 1} from end, ` +
                `limit: ~${estimatedTokens} tokens, context: ${Math.round(totalPromptTokens / 1000)}K/${pressureLevel})]`
              );
            }

            return result;
          };

          // Process messages to truncate tool results based on recency + context pressure
          const truncatedMessages = stepOptions.messages.map((msg, msgIdx) => {
            if (msg.role === "tool" && Array.isArray(msg.content)) {
              const toolMessagePosition = toolMessageIndices.indexOf(msgIdx);
              const maxLength = getTruncationLimit(toolMessagePosition);

              return {
                ...msg,
                content: msg.content.map((part: any) => {
                  if (part.type === "tool-result") {
                    // Truncate result (works for both strings and objects)
                    const truncatedResult = truncateToolResult(
                      part.result,
                      maxLength,
                      toolMessagePosition,
                    );

                    return {
                      ...part,
                      result: truncatedResult,
                    };
                  }
                  return part;
                }),
              };
            }
            return msg;
          });

          return { messages: truncatedMessages };
        },
        onStepFinish: async (step: StepResult<any>) => {
          cumulativeSteps++;

          // Debug: log the actual step structure to see what we're getting
          if (!step.usage || step.usage.inputTokens === undefined) {
            console.log(
              `[AgentService] 📈 Step ${cumulativeSteps} - NO USAGE DATA`,
              "Available fields:",
              Object.keys(step),
            );
            return;
          }

          const { inputTokens, outputTokens } = step.usage;

          // Update token tracking for next prepareStep
          // NOTE: inputTokens is already the TOTAL input to the model (not incremental)
          // so we replace, not add
          cumulativePromptTokens = inputTokens;

          console.log(
            `[AgentService] 📈 Step ${cumulativeSteps} - input: ${inputTokens} tokens, output: ${outputTokens} tokens (current context: ${cumulativePromptTokens})`,
          );

          if (inputTokens > CONTEXT_ABORT_THRESHOLD) {
            console.warn(
              `[AgentService] ⚠️ Context pressure at step ${cumulativeSteps}: ` +
                `${inputTokens} input tokens > ${CONTEXT_ABORT_THRESHOLD} threshold. ` +
                `Aborting stream and triggering compression.`,
            );
            contextPressureAborted = true;
            abortController.abort();

            // Note: We'll handle compression after the stream finishes
            // to avoid blocking the stream processing
          }
        },
      };

      // Choose streaming method based on provider and auth
      // OAuth → pi-ai (ChatGPT/Claude subscription). API key only → AI SDK/Mastra
      let fullStream: AsyncIterable<unknown>;
      
      // Check if model is actually supported by pi-ai before using OAuth route
      const { isOpenAICodexModel } = await import("../utils/modelNormalizer.js");
      const modelSupportsPiAi = config.provider === "openai" || config.provider === "openai-codex"
        ? isOpenAICodexModel(config.model)
        : true; // Anthropic models always support pi-ai
      
      const usePiAiOpenAI =
        (config.provider === "openai" || config.provider === "openai-codex") &&
        config.authType === "oauth" &&
        modelSupportsPiAi; // Only use pi-ai if model is supported
      const usePiAiAnthropic =
        config.provider === "anthropic" && config.authType === "oauth";
      const usePiAi = usePiAiOpenAI || usePiAiAnthropic;

      console.log(
        `[AgentService] Routing decision: provider=${config.provider} authType=${config.authType} ` +
          `modelSupportsPiAi=${modelSupportsPiAi} usePiAiOpenAI=${usePiAiOpenAI} usePiAiAnthropic=${usePiAiAnthropic} usePiAi=${usePiAi}`,
      );

      if (usePiAi) {
        // Use pi-ai for OpenAI (ChatGPT OAuth) and Anthropic (Claude OAuth)
        const useCodex = usePiAiOpenAI;
        console.log(
          `[AgentService] 🔧 Using pi-ai ${useCodex ? "OpenAI Codex" : "Anthropic"} provider`,
        );
        const { getModel, streamSimple } = await import("@mariozechner/pi-ai");
        const { buildPiContext } = await import("./providers/piAiHelpers.js");
        const { createPiCodexStreamWithToolLoop } =
          await import("./providers/PiCodexStreamWithToolLoop.js");

        const piProvider = useCodex ? "openai-codex" : "anthropic";
        // For openai provider with OAuth, map model to pi-ai format (gpt-5.2-low -> gpt-5.2)
        const piModelId =
          useCodex && config.provider === "openai"
            ? (
                await import("../utils/modelNormalizer.js")
              ).normalizeOpenAIModelId(config.model)
            : config.model;
        const piApiId = useCodex
          ? "openai-codex-responses"
          : "anthropic-messages";
        const envKey = useCodex ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
        
        // Use apiKey from config (which includes OAuth tokens)
        const token = config.apiKey || process.env[envKey];
        const errorHint = useCodex
          ? "Please connect your ChatGPT subscription."
          : "Please connect your Claude Pro/Max subscription or add an API key.";

        console.log(
          `[AgentService] Pi-ai token check: provider=${piProvider} ` +
          `hasConfigApiKey=${!!config.apiKey} hasEnvKey=${!!process.env[envKey]} ` +
          `tokenLength=${token?.length || 0}`
        );

        if (!token) {
          throw new Error(
            `${piProvider === "anthropic" ? "Anthropic" : "OpenAI"} token not found. ${errorHint}`,
          );
        }
        
        // Set token in environment for pi-ai (it reads from process.env)
        process.env[envKey] = token;
        console.log(`[AgentService] Set ${envKey} in process.env (length: ${token.length})`);

        const piModel = (getModel as (p: string, m: string) => unknown)(
          piProvider,
          piModelId,
        );
        
        // If model not found in pi-ai registry, create it manually
        // Both ChatGPT and Claude backends support models not yet in pi-ai registry
        let finalModel = piModel;
        if (!piModel) {
          if (useCodex) {
            console.log(
              `[AgentService] Model ${piModelId} not in pi-ai registry, creating manually for ChatGPT backend`,
            );
            
            // Create model object matching pi-ai's Model interface
            // Based on GPT-5.2 structure but with GPT-5.4 pricing
            finalModel = {
              id: piModelId,
              name: piModelId === "gpt-5.4-pro" ? "GPT-5.4 Pro" : "GPT-5.4 Thinking",
              api: piApiId,
              provider: piProvider,
              baseUrl: "https://chatgpt.com/backend-api",
              reasoning: true,
              input: ["text", "image"],
              cost: {
                input: piModelId === "gpt-5.4-pro" ? 30.0 : 2.5,
                output: piModelId === "gpt-5.4-pro" ? 180.0 : 15.0,
                cacheRead: piModelId === "gpt-5.4-pro" ? 3.0 : 0.25,
                cacheWrite: 0,
              },
              contextWindow: 1000000, // 1M tokens
              maxTokens: 128000,
            };
          } else {
            // Create manual model for Anthropic
            console.log(
              `[AgentService] Model ${piModelId} not in pi-ai registry, creating manually for Anthropic backend`,
            );
            
            // Map model ID to display name and pricing
            const modelInfo = piModelId.includes("opus") ? {
              name: "Claude Opus 4.6",
              inputCost: 5.0,
              outputCost: 25.0,
              contextWindow: 200000,
            } : piModelId.includes("sonnet") ? {
              name: "Claude Sonnet 4.6", 
              inputCost: 3.0,
              outputCost: 15.0,
              contextWindow: 200000,
            } : {
              name: "Claude Haiku 4.5",
              inputCost: 1.0,
              outputCost: 5.0,
              contextWindow: 200000,
            };
            
            finalModel = {
              id: piModelId,
              name: modelInfo.name,
              api: piApiId, // CRITICAL: "anthropic-messages" routes to /v1/messages
              provider: piProvider,
              baseUrl: "https://api.anthropic.com",
              reasoning: piModelId.includes("opus") || piModelId.includes("sonnet"),
              input: ["text", "image"],
              cost: {
                input: modelInfo.inputCost,
                output: modelInfo.outputCost,
                cacheRead: modelInfo.inputCost * 0.1, // 10% of input cost
                cacheWrite: modelInfo.inputCost * 1.25, // 25% markup for write
              },
              contextWindow: modelInfo.contextWindow,
              maxTokens: 8192,
            };
          }
        }
        
        console.log(
          `[AgentService] Using pi-ai model: ${finalModel ? (finalModel as any).id : 'null'} ` +
          `api=${finalModel ? (finalModel as any).api : 'null'} ` +
          `baseUrl=${finalModel ? (finalModel as any).baseUrl : 'null'}`
        );
        const piContext = buildPiContext({
          messages: messages as any[],
          tools: tools as any,
          apiId: piApiId,
          providerId: piProvider,
          modelId: piModelId,
        });

        // 🔍 LOG EXACT CONTEXT SENT TO PI-AI
        console.log(`\n${'='.repeat(80)}`);
        console.log(`📤 [PI-AI] EXACT CONTEXT BEING SENT TO LLM`);
        console.log(`${'='.repeat(80)}`);
        console.log(`Model: ${piModelId}`);
        console.log(`Provider: ${piProvider}`);
        console.log(`Total messages: ${piContext.messages?.length || 0}`);
        console.log(`\nFIRST 5 MESSAGES (should be oldest):`);
        console.log(`${'─'.repeat(80)}`);
        if (piContext.messages && Array.isArray(piContext.messages)) {
          piContext.messages.slice(0, 5).forEach((msg: any, i: number) => {
            const contentPreview = typeof msg.content === 'string' 
              ? msg.content.substring(0, 80)
              : JSON.stringify(msg.content).substring(0, 80);
            const timestamp = msg.timestamp || 'no-timestamp';
            console.log(`[${i}] ${msg.role} [ts:${timestamp}]: ${contentPreview}...`);
          });
        }
        console.log(`\nLAST 10 MESSAGES (should be newest):`);
        console.log(`${'─'.repeat(80)}`);
        if (piContext.messages && Array.isArray(piContext.messages)) {
          const startIdx = Math.max(0, piContext.messages.length - 10);
          piContext.messages.slice(startIdx).forEach((msg: any, i: number) => {
            const actualIdx = startIdx + i;
            const contentPreview = typeof msg.content === 'string' 
              ? msg.content.substring(0, 80)
              : JSON.stringify(msg.content).substring(0, 80);
            const timestamp = msg.timestamp || 'no-timestamp';
            console.log(`[${actualIdx}] ${msg.role} [ts:${timestamp}]: ${contentPreview}...`);
          });
        }
        console.log(`\nTools available: ${Object.keys(tools).length}`);
        console.log(`${'='.repeat(80)}\n`);

        const reasoningLevel = (config.reasoning?.effort ?? "medium") as
          | "minimal"
          | "low"
          | "medium"
          | "high"
          | "xhigh";

        // IMPORTANT: OpenAI API has a 64-char limit on prompt_cache_key.
        // pi-ai uses sessionId as the cache key, so we need to hash long chatIds (e.g. agent jobs)
        // Job chatIds like "job:uuid:uuid-timestamp-a1" can be 94+ chars
        let sessionId = chatId;
        if (chatId.length > 64) {
          // Use first 32 chars + hash of remainder to stay under 64 chars
          const crypto = await import("crypto");
          const hash = crypto
            .createHash("sha256")
            .update(chatId)
            .digest("hex")
            .substring(0, 31);
          sessionId = `${chatId.substring(0, 32)}-${hash}`;
          console.log(
            `[AgentService] Shortened sessionId from ${chatId.length} to ${sessionId.length} chars for pi-ai`,
          );
        }

        const streamOpts = {
          apiKey: token,
          sessionId,
          signal: abortController.signal,
          reasoning: reasoningLevel,
        };
        const apiKeys = getApiKeysForSanitization();
        const maxSteps = options?.maxSteps ?? 100;

        // Context pressure callback for pi-ai path (triggers summarization)
        const onContextPressure = async () => {
          console.log(`🔄 Pi-ai context pressure detected for chat ${chatId}`);
          contextPressureAborted = true;
          abortController.abort();
        };

        fullStream = createPiCodexStreamWithToolLoop(
          streamSimple as any,
          finalModel,
          piContext,
          streamOpts,
          tools as Record<
            string,
            { execute?: (args: unknown) => Promise<unknown> }
          >,
          apiKeys,
          maxSteps,
          onContextPressure, // Pass callback to enable summarization
          piModelId, // Pass modelId for context threshold determination
        );
        timings.streamTextInit = performance.now() - t;
        console.log(
          `  pi-ai ${piProvider} init: ${timings.streamTextInit.toFixed(2)}ms`,
        );
      } else {
        // Use AI SDK for standard providers (OpenAI Platform, Anthropic, Google)
        
        // 🔍 LOG EXACT CONTEXT SENT TO AI SDK
        console.log(`\n${'='.repeat(80)}`);
        console.log(`📤 [AI SDK] EXACT CONTEXT BEING SENT TO LLM`);
        console.log(`${'='.repeat(80)}`);
        console.log(`Model: ${config.model}`);
        console.log(`Provider: ${config.provider}`);
        console.log(`Total messages: ${streamTextOptions.messages.length}`);
        console.log(`\nFULL MESSAGE CONTENT (not truncated):`);
        console.log(`${'='.repeat(80)}`);
        streamTextOptions.messages.forEach((msg: any, i: number) => {
          console.log(`\n[Message ${i}] Role: ${msg.role}`);
          if (msg.role === 'system') {
            console.log(`Content:\n${msg.content}`);
          } else if (msg.role === 'user') {
            const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
            console.log(`Content:\n${contentStr}`);
          } else if (msg.role === 'assistant') {
            if (Array.isArray(msg.content)) {
              console.log(`Content (structured):\n${JSON.stringify(msg.content, null, 2)}`);
            } else {
              const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
              console.log(`Content:\n${contentStr}`);
            }
          } else if (msg.role === 'tool') {
            console.log(`Content (tool results):\n${JSON.stringify(msg.content, null, 2)}`);
          } else {
            console.log(`Content:\n${JSON.stringify(msg, null, 2)}`);
          }
          console.log(`${'─'.repeat(80)}`);
        });
        console.log(`\nTools available: ${Object.keys(streamTextOptions.tools || {}).length}`);
        console.log(`Max tokens: ${streamTextOptions.maxTokens}`);
        console.log(`Max steps: ${streamTextOptions.stopWhen ? 'custom' : 'default'}`);
        console.log(`${'='.repeat(80)}\n`);
        
        const result = await streamText(streamTextOptions);
        fullStream = result.fullStream;
        timings.streamTextInit = performance.now() - t;
        console.log(`  AI SDK init: ${timings.streamTextInit.toFixed(2)}ms`);
      }

      const apiKeys = getApiKeysForSanitization();
      t = performance.now();
      const streamIterator = orchestrateModelStream(
        fullStream,
        chatId,
        apiKeys,
      );

      let firstChunkReceived = false;
      while (true) {
        const next = await streamIterator.next();

        if (!firstChunkReceived && !next.done) {
          timings.timeToFirstChunk = performance.now() - t;
          console.log(
            `[AgentService] ⚡ First chunk in ${timings.timeToFirstChunk.toFixed(2)}ms (type: ${next.value.type})`,
          );
          console.log(
            `[AgentService] 🎯 Time from request start to first chunk: ${(performance.now() - perfStart).toFixed(2)}ms`,
          );
          firstChunkReceived = true;
        }

        if (next.done) {
          assistantText = next.value.assistantText;
          thinkingText = next.value.thinkingText;
          toolCalls = next.value.toolCalls;
          toolResults = next.value.toolResults;
          sequence = next.value.sequence; // Get V1-style sequence

          // Log sequence for debugging
          console.log(
            `[AgentService] Sequence built: ${sequence.length} items`,
          );
          sequence.forEach((item, i) => {
            console.log(
              `  ${i + 1}. ${item.type}: ${
                item.type === "text"
                  ? `"${(item.data as string).substring(0, 50)}..."`
                  : item.type === "tool"
                    ? (item.data as any).name
                    : "thinking"
              }`,
            );
          });

          // Log why the stream finished
          console.log(`[AgentService] 🏁 Stream finished`);
          console.log(`  Assistant text length: ${assistantText.length} chars`);
          console.log(`  Thinking text length: ${thinkingText.length} chars`);
          console.log(`  Tool calls: ${toolCalls.length}`);
          console.log(`  Tool results: ${toolResults.length}`);

          // If we aborted due to context pressure, handle compression BEFORE breaking
          if (contextPressureAborted) {
            // Yield compression start chunk
            yield {
              type: "compression-start",
              payload: {
                message:
                  "Context limit reached. Compressing conversation history...",
              },
              timestamp: new Date().toISOString(),
              chatId,
            } as StreamChunk & { chatId: string };

            // Perform compression
            console.log(`🔄 Starting compression for chat ${chatId}`);
            await this.triggerSummarization(chatId);

            // Yield compression complete chunk
            yield {
              type: "compression-complete",
              payload: { message: "Compression complete. Continuing..." },
              timestamp: new Date().toISOString(),
              chatId,
            } as StreamChunk & { chatId: string };

            console.log(`✓ Compression complete for chat ${chatId}`);

            // Save the partial message first
            const partialMsg: StoredMessage = createAssistantStoredMessage({
              chatId,
              model: config.model,
              assistantText,
              thinkingText,
              toolCalls,
              toolResults,
              sequence,
              usage: tokenUsage, // Pass token usage
            });
            await this.storageManager.saveMessage(chatId, partialMsg);
            console.log(`✓ Saved partial response before retry`);

            // Now automatically retry with compressed context
            // IMPORTANT: Don't add the user message again - it's already in history!
            // The agent will see:
            // 1. [Compressed summary]
            // 2. User: original request
            // 3. Assistant: partial work (saved above)
            // 4. [Continues from here]
            console.log(`🔄 Automatically retrying with compressed context...`);
            
            // Create a continuation message that acknowledges the partial work
            const continuationPrompt = "Continue from where you left off. You've already made progress on this task.";

            // Recursively call streamAgent with continuation prompt
            for await (const chunk of this.streamAgent(
              chatId,
              continuationPrompt,
              config,
              options,
            )) {
              yield chunk;
            }

            // Return after the retry completes (don't save message again)
            return;
          }

          break;
        }

        // Extract token usage from done or step-usage chunks
        if (next.value.type === "done" || next.value.type === "step-usage") {
          const payload = next.value.payload as any;
          if (payload?.usage) {
            tokenUsage = {
              promptTokens: payload.usage.promptTokens || 0,
              completionTokens: payload.usage.completionTokens || 0,
              totalTokens: payload.usage.totalTokens || 0,
            };
            console.log(
              `[AgentService] 💰 Token usage: ${tokenUsage.totalTokens} total ` +
                `(${tokenUsage.promptTokens} prompt + ${tokenUsage.completionTokens} completion)`,
            );
          }
        }

        yield next.value;
      }

      // 4. Save assistant message with thinking and tool calls
      const assistantMsg: StoredMessage = createAssistantStoredMessage({
        chatId,
        model: config.model,
        assistantText,
        thinkingText,
        toolCalls,
        toolResults,
        sequence, // Pass V1-style sequence
        usage: tokenUsage, // Pass token usage
      });
      await this.storageManager.saveMessage(chatId, assistantMsg);

      // 5. Export chat to ~/Papr/ folder
      const allMessages = await this.storageManager.loadMessages(chatId);
      const chatMeta = await this.storageManager.getChat(chatId);
      await this.chatExporter.exportChat(
        chatId,
        chatMeta?.title || null,
        allMessages,
      );

      // 6. Check if summarization is needed (50K tokens threshold)
      const stats = await this.storageManager.getChatStats(chatId);
      console.log(`[AgentService] 📊 Chat stats after stream: message_count=${stats.message_count}, token_count=${stats.token_count}, has_summary=${stats.has_summary}`);
      
      if (stats.token_count > 50000) {
        console.log(`[AgentService] 🔄 Token count (${stats.token_count}) > 50K threshold - triggering summarization`);
        // Trigger summarization in background (don't await)
        this.triggerSummarization(chatId).catch(console.error);
      } else {
        console.log(`[AgentService] ℹ️  Token count (${stats.token_count}) below 50K threshold - no summarization needed`);
      }
    } catch (error) {
      // Save partial assistant message with error indicator
      // This ensures user sees what happened when they reopen the chat
      const contextThresholdStr = CONTEXT_ABORT_THRESHOLD.toLocaleString();
      const errorMessage = contextPressureAborted
        ? `Context limit approaching (${contextThresholdStr} prompt tokens). Conversation summary generated — you can continue from where we left off.`
        : error instanceof Error
          ? error.message
          : "Unknown error";

      const errorMsg: StoredMessage = createErrorStoredMessage({
        chatId,
        model: config.model,
        assistantText,
        thinkingText,
        toolCalls,
        toolResults,
        errorMessage,
        usage: tokenUsage, // Pass token usage even on error
      });

      try {
        await this.storageManager.saveMessage(chatId, errorMsg);
        console.log(
          `[AgentService] Saved partial response with error for chat ${chatId}`,
        );
      } catch (saveError) {
        console.error(
          `[AgentService] Failed to save error message:`,
          saveError,
        );
      }

      // Re-throw to propagate to WebSocket handler
      throw error;
    } finally {
      // Clear streaming state
      this.sessionManager.setStreaming(chatId, false);
      this.sessionManager.setAbortController(chatId, null);
    }
  }

  /**
   * Stop streaming for a specific chat
   */
  async stopStreaming(chatId: string): Promise<void> {
    await this.sessionManager.abortSession(chatId);
  }

  /**
   * Trigger summarization for a chat (background operation).
   *
   * Strategy:
   * 1. Skip if a fresh summary (< 30 min old) already exists — prevents hammering
   *    the API every single turn once the threshold is crossed.
   * 2. Try the storage provider's built-in compress (Papr /compress for papr/hybrid modes).
   * 3. Try Papr /compress directly with a raw API key — covers the case where we're in
   *    local SQLite mode but a PAPR_API_KEY is still configured.
   * 4. Fall back to local LLM summarization (generateText with cheapest available model).
   */
  private async triggerSummarization(chatId: string): Promise<void> {
    try {
      console.log(`🔄 Summarization triggered for chat ${chatId}`);

      // --- Step 0: Dedup — skip if a fresh summary exists ---
      const existing = await this.storageManager.getSummary(chatId);
      if (existing?.last_fetched_at) {
        const ageMs = Date.now() - new Date(existing.last_fetched_at).getTime();
        if (ageMs < 30 * 60 * 1000) {
          console.log(
            `✓ Summary already fresh for ${chatId} (${Math.round(ageMs / 60000)}m old), skipping`,
          );
          return;
        }
      }

      // --- Step 1: Provider-native compress (works for papr + hybrid modes) ---
      const providerSummary =
        await this.storageManager.fetchAndCacheSummary(chatId);
      if (providerSummary) {
        console.log(
          `✓ Summary from storage provider for ${chatId}: topics=[${providerSummary.topics?.join(", ")}]`,
        );
        return;
      }

      // --- Step 2: Direct Papr /compress call (local mode + PAPR key available) ---
      const { getApiKeys } = await import("../utils/keyResolver.js");
      const keys = await getApiKeys(["PAPR_API_KEY"]);
      if (keys.PAPR_API_KEY) {
        try {
          const PaprModule = await import("@papr/memory");
          const PaprClient = PaprModule.default;
          const papr = new PaprClient({
            xAPIKey: keys.PAPR_API_KEY,
          });
          const response = await papr.messages.sessions.compress(chatId);
          if (response.summaries) {
            const s = response.summaries;
            const summary: import("./storage/IStorageProvider.js").StoredSummary =
              {
                short_term: s.short_term ?? "",
                medium_term: s.medium_term ?? "",
                long_term: s.long_term ?? "",
                topics: s.topics ?? [],
                last_updated: s.last_updated ?? new Date().toISOString(),
                fetched_from_papr: true,
                last_fetched_at: new Date().toISOString(),
              };
            await this.storageManager.saveSummary(chatId, summary);
            console.log(
              `✓ Summary from Papr /compress for ${chatId}: topics=[${summary.topics.join(", ")}]`,
            );
            return;
          }
        } catch (paprError) {
          console.warn(
            `[AgentService] Papr /compress failed, using local LLM fallback:`,
            paprError,
          );
        }
      }

      // --- Step 3: Local LLM summarization fallback ---
      await this.generateAndSaveLocalSummary(chatId);
    } catch (error) {
      console.error(
        `[AgentService] Summarization failed for ${chatId}:`,
        error,
      );
    }
  }

  /**
   * Generate a hierarchical conversation summary using a local LLM call.
   *
   * Produces three levels (matching Papr's /compress structure):
   *   - short_term:  last 15 messages compressed
   *   - medium_term: last ~100 messages compressed
   *   - long_term:   full session compressed (key decisions, files, current focus)
   *   - topics:      5–10 key topics discussed
   *
   * Uses the cheapest available model (gpt-5-mini → claude-haiku-4-5 → gemini-flash).
   * Input capped at 50K chars to stay within context limits.
   */
  private async generateAndSaveLocalSummary(chatId: string): Promise<void> {
    console.log(`📦 Generating local LLM summary for ${chatId}`);

    const messages = await this.storageManager.loadMessages(chatId);
    if (messages.length < 10) {
      console.log(
        `[AgentService] Too few messages (${messages.length}) for local summary`,
      );
      return;
    }

    // Build plain-text representation — strip tool call JSON, keep text only
    const conversationText = messages
      .map((m) => {
        const role = m.role === "user" ? "User" : "Assistant";
        return `${role}: ${m.content || "(no text)"}`;
      })
      .join("\n\n");

    // Cap input — 50K chars ≈ 12K tokens, enough for a quality summary
    const MAX_INPUT_CHARS = 50_000;
    const last15 = messages
      .slice(-15)
      .map(
        (m) =>
          `${m.role === "user" ? "User" : "Assistant"}: ${m.content || "(no text)"}`,
      )
      .join("\n\n");
    const last100 = messages
      .slice(-100)
      .map(
        (m) =>
          `${m.role === "user" ? "User" : "Assistant"}: ${m.content || "(no text)"}`,
      )
      .join("\n\n");
    const fullText =
      conversationText.length > MAX_INPUT_CHARS
        ? conversationText.substring(conversationText.length - MAX_INPUT_CHARS)
        : conversationText;

    // Select cheapest available model
    const { getApiKeys } = await import("../utils/keyResolver.js");
    const providerKeys = await getApiKeys([
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
    ]);

    let model: import("ai").LanguageModel | null = null;
    let selectedProvider = "";
    if (providerKeys.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = providerKeys.OPENAI_API_KEY;
      const { openai } = await import("@ai-sdk/openai");
      model = openai("gpt-4o-mini") as import("ai").LanguageModel;
      selectedProvider = "openai/gpt-4o-mini";
    } else if (providerKeys.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = providerKeys.ANTHROPIC_API_KEY;
      const { anthropic } = await import("@ai-sdk/anthropic");
      model = anthropic("claude-haiku-4-5") as import("ai").LanguageModel;
      selectedProvider = "anthropic/claude-haiku-4-5";
    } else if (providerKeys.GOOGLE_API_KEY) {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = providerKeys.GOOGLE_API_KEY;
      const { google } = await import("@ai-sdk/google");
      model = google("gemini-2-0-flash") as import("ai").LanguageModel;
      selectedProvider = "google/gemini-2-0-flash";
    }

    if (!model) {
      console.warn(
        `[AgentService] No API key available for local summarization`,
      );
      return;
    }

    console.log(`[AgentService] Summarizing with ${selectedProvider}`);

    const { generateText } = await import("ai");

    // Generate all three summary levels in a single structured call
    const systemPrompt = `You are a conversation summarizer. Produce a JSON object with exactly these four fields:

{
  "short_term": "1-2 paragraphs summarizing the last 15 messages. Focus on what just happened.",
  "medium_term": "3-5 paragraphs summarizing the last ~100 messages. Include key decisions and file changes.",
  "long_term": "Comprehensive summary of the full session. Cover: current focus, files accessed, key decisions, failed approaches, next steps, and important technical details.",
  "topics": ["array", "of", "5-10", "key", "topics"]
}

RULES:
- Always prefer RECENT context over older context.
- Be specific: include file paths, function names, error messages, API endpoints.
- Bias the long_term summary heavily towards what we are working on RIGHT NOW.
- Output ONLY the JSON object — no markdown, no explanation.`;

    const userPrompt = `Generate a summary for this conversation.

=== FULL SESSION (last 50K chars) ===
${fullText}

=== LAST 100 MESSAGES ===
${last100.substring(0, 20_000)}

=== LAST 15 MESSAGES ===
${last15.substring(0, 8_000)}`;

    let rawText = "";
    try {
      const result = await generateText({
        model,
        system: systemPrompt,
        prompt: userPrompt,
        maxOutputTokens: 2000,
      });
      rawText = result.text.trim();
    } catch (llmError) {
      console.error(`[AgentService] LLM summarization call failed:`, llmError);
      return;
    }

    // Parse — strip markdown fences if the model wrapped the JSON
    interface SummaryJson {
      short_term?: string;
      medium_term?: string;
      long_term?: string;
      topics?: unknown;
    }
    let parsed: SummaryJson | null = null;

    try {
      const cleaned = rawText
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
      parsed = JSON.parse(cleaned) as SummaryJson;
    } catch {
      console.error(
        `[AgentService] Failed to parse local summary JSON:`,
        rawText.substring(0, 200),
      );
      return;
    }

    if (!parsed || typeof parsed.long_term !== "string" || !parsed.long_term) {
      console.error(`[AgentService] Parsed summary missing long_term field`);
      return;
    }

    const topics = Array.isArray(parsed.topics)
      ? (parsed.topics as unknown[]).filter(
          (t): t is string => typeof t === "string",
        )
      : [];

    const summary: import("./storage/IStorageProvider.js").StoredSummary = {
      short_term:
        typeof parsed.short_term === "string" ? parsed.short_term : "",
      medium_term:
        typeof parsed.medium_term === "string" ? parsed.medium_term : "",
      long_term: parsed.long_term,
      topics,
      last_updated: new Date().toISOString(),
      fetched_from_papr: false,
      last_fetched_at: new Date().toISOString(),
    };

    await this.storageManager.saveSummary(chatId, summary);
    console.log(
      `✓ Local summary saved for ${chatId} (${summary.long_term.length} chars, topics=[${topics.join(", ")}])`,
    );
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

  /**
   * Get detailed context breakdown for inspection
   * Shows what will be sent to the LLM on next turn
   * 
   * CRITICAL: This MUST use the exact same logic as streamText() to ensure
   * the context inspector shows exactly what the LLM sees
   */
  async inspectContext(chatId: string, selectedModel: string) {
    // Get actual model from active session if it exists, otherwise use selectedModel
    let actualModel = selectedModel;
    const session = this.sessionManager.getSessionIfExists(chatId);
    if (session) {
      actualModel = session.config.model;
      console.log(`[AgentService] Context inspector: using session model ${actualModel} instead of UI model ${selectedModel}`);
    } else {
      console.log(`[AgentService] Context inspector: no active session, using UI model ${selectedModel}`);
    }

    // Load history - EXACTLY the same way as the actual agent run
    const historyRaw = await this.storageManager.loadMessagesForLLM(chatId);

    // Extract summary if present (injected by storage providers)
    // This MUST match the logic in streamText() to show exactly what LLM sees
    let conversationSummary: string | undefined;
    const history = historyRaw.filter((msg) => {
      if (typeof msg === "object" && msg !== null && "__summary" in msg) {
        conversationSummary = (msg as { __summary: string }).__summary;
        return false; // Remove __summary from history
      }
      return true; // Keep in history
    });

    // Load skills
    let enabledSkills: Array<{ id: string; name: string; description: string }> =
      [];
    try {
      const { getSkillService } = await import("./SkillService.js");
      const skillService = getSkillService();
      const skills = await skillService.listSkills();
      enabledSkills = skills
        .filter((s: any) => s.enabled)
        .map((s: any) => ({
          id: s.id,
          name: s.name,
          description: s.description,
        }));
    } catch {
      // Skills not initialized yet
    }

    // Build system prompt (same as actual agent run)
    const systemPrompt = await this.buildContextualSystemPrompt(
      chatId,
      history,
      enabledSkills,
    );

    // Get all available tools
    const allTools = this.toolRegistry.getTools();
    const toolSchemas = Object.entries(allTools).map(([id, tool]: [string, any]) => ({
      id,
      description: tool.description,
      // Simplified schema for display
      parameters: tool.inputSchema
        ? JSON.parse(JSON.stringify(tool.inputSchema))
        : null,
    }));

    // Load workspace context separately for display
    // NOTE: Workspace files are ALREADY in the system prompt
    // We load them separately here just to show users what's included
    let workspaceFiles: Array<{ name: string; content: string; size: number }> =
      [];
    try {
      const workspaceService = getWorkspaceService();
      const ctx = await workspaceService.loadWorkspaceContext();
      workspaceFiles = ctx.files.map((f) => ({
        name: f.name,
        content: f.content,
        size: f.content.length,
      }));
      // Add daily logs
      ctx.dailyLogs.forEach((log) => {
        workspaceFiles.push({
          name: log.name,
          content: log.content,
          size: log.content.length,
        });
      });
    } catch {
      // No workspace context
    }

    // Load active plans
    let activePlans: Array<{
      planId: string;
      title: string;
      steps: Array<{ id: string; description: string; status: string }>;
    }> = [];
    try {
      const { getPlanService } = await import("./PlanService.js");
      const planService = getPlanService();
      await planService.initialize();
      const plans = await planService.getActivePlansForChat(chatId);
      activePlans = plans.map((p) => ({
        planId: p.planId,
        title: p.title,
        steps: p.steps,
      }));
    } catch {
      // No plans
    }

    // Format messages for model (same as actual run)
    const messages = buildModelMessages(
      history,
      "[Next user message will appear here]",
      systemPrompt,
      conversationSummary,
    );

    // Count tokens (rough estimate: 1 token ≈ 4 chars)
    const estimateTokens = (text: string) => Math.ceil(text.length / 4);

    // Break down token counts
    const systemPromptTokens = estimateTokens(systemPrompt);
    
    // Conversation summary is injected as a USER message, not in system prompt
    const conversationSummaryTokens = conversationSummary
      ? estimateTokens(conversationSummary)
      : 0;

    let historyTokens = 0;
    const messageBreakdown: Array<{
      role: string;
      tokens: number;
      preview: string;
    }> = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Skip system prompt (shown in separate section)
      if (msg.role === "system") {
        continue;
      }

      // Skip conversation summary user message (shown in separate section)
      if (
        msg.role === "user" &&
        typeof msg.content === "string" &&
        msg.content.startsWith("[CONVERSATION CONTEXT - Earlier messages")
      ) {
        continue;
      }

      // Skip tool messages - they'll be merged with their associated assistant message
      if (msg.role === "tool") {
        continue;
      }

      // Handle user and assistant messages
      let content = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Structured content (assistant with tool-calls)
        const textParts = msg.content.filter((p: any) => p.type === "text");
        const toolCallParts = msg.content.filter(
          (p: any) => p.type === "tool-call",
        );

        if (textParts.length > 0) {
          content = textParts.map((p: any) => p.text).join(" ");
        }
        
        // If this assistant message has tool-calls, look for the next tool message
        if (toolCallParts.length > 0) {
          const toolNames = toolCallParts.map((p: any) => p.toolName).join(", ");
          content += `\n→ Called tools: ${toolNames}`;
          
          // Look ahead for the tool results message (should be next)
          if (i + 1 < messages.length && messages[i + 1].role === "tool") {
            const toolMsg = messages[i + 1];
            if (Array.isArray(toolMsg.content)) {
              const toolResultParts = toolMsg.content.filter(
                (p: any) => p.type === "tool-result",
              );
              if (toolResultParts.length > 0) {
                // Show more useful preview (500 chars per result - matches LLM history truncation)
                // This gives enough context to understand what happened without overwhelming the UI
                const resultSummaries = toolResultParts.map((p: any) => {
                  const resultStr =
                    typeof p.result === "string"
                      ? p.result
                      : JSON.stringify(p.result);
                  const PREVIEW_LENGTH = 500; // ~125 tokens, matches history truncation
                  const truncated = resultStr.substring(0, PREVIEW_LENGTH);
                  const suffix = resultStr.length > PREVIEW_LENGTH 
                    ? `... [+${resultStr.length - PREVIEW_LENGTH} chars]` 
                    : "";
                  return `${p.toolName}: ${truncated}${suffix}`;
                });
                content += `\n→ Tool results:\n${resultSummaries.join("\n")}`;
              }
            }
          }
        }
      }

      const tokens = estimateTokens(content);
      historyTokens += tokens;

      messageBreakdown.push({
        role: msg.role,
        tokens,
        preview: content.substring(0, 2000), // Allow longer preview for tool results
      });
    }

    const toolSchemaText = JSON.stringify(toolSchemas);
    const toolTokens = estimateTokens(toolSchemaText);

    // Workspace files are ALREADY counted in systemPromptTokens
    // We don't add them separately to total
    // Just showing them for user visibility

    const totalTokens =
      systemPromptTokens +
      conversationSummaryTokens +
      historyTokens +
      toolTokens;

    return {
      model: actualModel,
      totalTokens,
      breakdown: {
        systemPrompt: {
          tokens: systemPromptTokens,
          content: systemPrompt,
          note: "Includes workspace files (MEMORY.md, IDENTITY.md, daily logs, etc.)",
        },
        conversationSummary: conversationSummary
          ? {
              tokens: conversationSummaryTokens,
              content: conversationSummary,
              note: "Injected as a user message before recent history",
            }
          : null,
        messages: {
          tokens: historyTokens,
          count: messageBreakdown.length, // Count only what we actually show
          breakdown: messageBreakdown,
        },
        tools: {
          tokens: toolTokens,
          count: toolSchemas.length,
          schemas: toolSchemas,
        },
        workspaceFiles: {
          tokens: 0, // Already counted in system prompt
          count: workspaceFiles.length,
          files: workspaceFiles,
          note: "These files are embedded in the system prompt above (not counted separately)",
        },
        skills: {
          tokens: enabledSkills.reduce(
            (sum, s) => sum + estimateTokens(`${s.name}: ${s.description}`),
            0,
          ),
          count: enabledSkills.length,
          skills: enabledSkills,
          note: "Skill references are in system prompt (counted there)",
        },
        plans: {
          tokens: activePlans.reduce(
            (sum, p) =>
              sum +
              estimateTokens(
                `${p.title}: ${p.steps.map((s) => s.description).join(", ")}`,
              ),
            0,
          ),
          count: activePlans.length,
          plans: activePlans,
          note: "Plan references are in system prompt (counted there)",
        },
      },
    };
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
   * Check if two configs use the same provider (for API key reuse)
   */
  isSameProvider(
    config1: AgentConfigInternal,
    config2: Partial<AgentConfigInternal>,
  ): boolean {
    return config1.provider === config2.provider;
  }

  /**
   * Get title service
   */
  getTitleService(): TitleGenerationService | null {
    return this.titleService;
  }

  /**
   * Update OpenAI API key (for title generation)
   * Note: Title generation now handles OAuth/API key routing internally,
   * but keep this method for backwards compatibility
   */
  setOpenAIApiKey(_apiKey: string): void {
    if (!this.titleService) {
      this.titleService = new TitleGenerationService();
    }
    // No need to pass API key - service handles auth internally
  }

  /**
   * Shutdown service - cleanup all sessions
   */
  async shutdown(): Promise<void> {
    console.log("[AgentService] Shutting down");
    await this.sessionManager.clearAllSessions();
  }

  async runIsolatedJobSession(input: {
    jobId: string;
    runId: string;
    prompt: string;
    provider?: Provider;
    model?: string;
    allowedToolIds?: string[];
    maxTurns?: number;
    appendLog?: (line: string) => Promise<void>;
    /** When set (sub-agent job), broadcast thinking/tool activity to MiniChatCard */
    delegationId?: string;
  }): Promise<{ chatId: string; text: string }> {
    if (!this.initialized) {
      throw new Error("AgentService not initialized");
    }

    await this.ensureKeysLoaded();

    // Resolve default provider and model based on user's available authentication
    let provider = input.provider;
    let model = input.model;
    
    if (!provider || !model) {
      const { getDefaultProviderAndModel } = await import("../utils/defaultProvider.js");
      const defaults = await getDefaultProviderAndModel();
      provider = provider ?? defaults.provider;
      model = model ?? defaults.model;
      console.log(`[AgentService] Using default provider/model: ${provider}/${model}`);
    }

    const defaultModelByProvider: Record<Provider, string> = {
      openai: "gpt-5.2",
      "openai-codex": "gpt-5.3-codex",
      anthropic: "claude-sonnet-4-6",
      google: "gemini-2.5-flash",
      ollama: "qwen3.5:latest",
    };
    model = model ?? defaultModelByProvider[provider];

    // Use getProviderAuth for openai/anthropic (handles OAuth + API key) — same as WebSocket handler
    let apiKey: string | undefined;
    let authType: "oauth" | "apiKey" | undefined;
    const { getProviderAuth, getApiKeys } =
      await import("../utils/keyResolver.js");

    // Check if the specified provider is available
    let authCheckFailed = false;
    let originalProvider = provider;

    if (
      provider === "openai" ||
      provider === "openai-codex" ||
      provider === "anthropic"
    ) {
      const authProvider = provider === "openai-codex" ? "openai" : provider;
      const auth = await getProviderAuth(authProvider);
      if (!auth) {
        authCheckFailed = true;
        console.warn(
          `[AgentService] No authentication found for specified provider (${provider}). Falling back to default provider...`,
        );
      } else {
        apiKey = auth.type === "oauth" ? auth.token : auth.key;
        authType = auth.type;
        console.log(
          `[AgentService] runIsolatedJobSession: provider=${provider} authProvider=${authProvider} ` +
            `authType=${authType} tokenLength=${apiKey.length}`,
        );
      }
    } else {
      const keyName =
        provider === "google" ? "GOOGLE_API_KEY" : "OPENAI_API_KEY";
      const keys = await getApiKeys([keyName]);
      apiKey = keys[keyName];
      if (!apiKey) {
        authCheckFailed = true;
        console.warn(
          `[AgentService] Missing API key for specified provider (${provider}): ${keyName}. Falling back to default provider...`,
        );
      }
    }

    // If auth check failed, fall back to default provider
    if (authCheckFailed) {
      // Try smart fallback based on original model capabilities
      const { getBestFallbackModel } = await import("../utils/smartFallback.js");
      const { getAvailableProviders } = await import("../utils/defaultProvider.js");
      
      const available = await getAvailableProviders();
      const fallback = await getBestFallbackModel(
        originalProvider,
        input.model || "unknown",
        available,
      );

      if (fallback) {
        provider = fallback.provider;
        model = fallback.model;
        console.log(
          `[AgentService] Smart fallback: ${originalProvider}/${input.model || "default"} → ${provider}/${model} (capability-matched)`,
        );
      } else {
        // No smart fallback available, use basic default
        const { getDefaultProviderAndModel } = await import("../utils/defaultProvider.js");
        const defaults = await getDefaultProviderAndModel();
        provider = defaults.provider;
        model = defaults.model;
        console.log(
          `[AgentService] Falling back from ${originalProvider} to ${provider}/${model}`,
        );
      }

      // Re-check auth for fallback provider
      if (provider === "openai" || provider === "anthropic") {
        const auth = await getProviderAuth(provider);
        if (!auth) {
          throw new Error(
            `No authentication found for fallback provider (${provider}). Please configure at least one provider.`,
          );
        }
        apiKey = auth.type === "oauth" ? auth.token : auth.key;
        authType = auth.type;
      } else if (provider === "google") {
        const keys = await getApiKeys(["GOOGLE_API_KEY"]);
        apiKey = keys.GOOGLE_API_KEY;
        if (!apiKey) {
          throw new Error(`Missing API key for fallback provider: GOOGLE_API_KEY`);
        }
      } else if (provider === "ollama") {
        // Ollama doesn't need auth
        apiKey = ""; // Empty string for Ollama
      } else {
        // Unexpected provider without auth setup
        throw new Error(
          `No authentication configuration found for fallback provider: ${provider}`,
        );
      }
    }

    // Ensure apiKey is assigned before proceeding
    if (apiKey === undefined) {
      throw new Error(
        `Failed to obtain API key for provider: ${provider}. Please configure authentication.`,
      );
    }

    const chatId = `job:${input.jobId}:${input.runId}`;
    const config: AgentConfigInternal = {
      provider,
      model,
      apiKey,
      authType,
      systemPrompt: `${this.systemPrompt}\n\n# Isolated Job Run\n- Session: ${chatId}\n- Keep output concise and actionable.`,
    };

    let text = "";
    let retryWithApiKey = false;
    let thinkingBuffer = ""; // Accumulate thinking tokens for job logs

    try {
      for await (const chunk of this.streamAgent(chatId, input.prompt, config, {
        allowedToolIds: input.allowedToolIds,
        maxSteps: input.maxTurns,
      })) {
        if (chunk.type === "error") {
          const errMsg =
            (chunk.payload as { error?: string })?.error ?? "Model API error";

          // Check if this is an OAuth rate limit error
          if (
            authType === "oauth" &&
            (errMsg.includes("usage limit") ||
              errMsg.includes("rate limit") ||
              errMsg.includes("Try again in"))
          ) {
            console.log(
              `[AgentService] OAuth rate limit hit for ${provider}. Retrying with API key...`,
            );
            retryWithApiKey = true;
            break; // Exit the stream loop to retry
          }

          throw new Error(
            `Agent job model error (${provider}/${model}): ${errMsg}`,
          );
        }

        // Log structured activity to job logs (thinking, tool calls, results)
        if (input.appendLog) {
          if (chunk.type === "reasoning-delta") {
            const payload = chunk.payload as ReasoningDeltaPayload;
            if (typeof payload.text === "string") {
              thinkingBuffer += payload.text;
            }
          } else if (chunk.type === "tool-call") {
            // Flush thinking buffer before logging tool call
            if (thinkingBuffer.trim()) {
              await input.appendLog(`💭 Thinking: ${thinkingBuffer.trim()}`);
              thinkingBuffer = "";
            }
            const payload = chunk.payload as ToolCallPayload;
            const argsStr = payload.args
              ? JSON.stringify(payload.args).slice(0, 200)
              : "";
            await input.appendLog(
              `🔧 Tool: ${payload.toolName}${argsStr ? `(${argsStr}${argsStr.length >= 200 ? "..." : ""})` : "()"}`,
            );
          } else if (chunk.type === "tool-result") {
            const payload = chunk.payload as ToolResultPayload;
            const resultStr =
              typeof payload.result === "string"
                ? payload.result.slice(0, 300)
                : JSON.stringify(payload.result).slice(0, 300);
            await input.appendLog(
              `✅ Result: ${resultStr}${resultStr.length >= 300 ? "..." : ""}`,
            );
          } else if (chunk.type === "tool-error") {
            const payload = chunk.payload as ErrorPayload;
            await input.appendLog(
              `❌ Error: ${typeof payload.error === "string" ? payload.error : JSON.stringify(payload.error)}`,
            );
          } else if (chunk.type === "text-delta") {
            // Flush thinking buffer when text starts (thinking is done)
            if (thinkingBuffer.trim()) {
              await input.appendLog(`💭 Thinking: ${thinkingBuffer.trim()}`);
              thinkingBuffer = "";
            }
          }
        }

        // Broadcast sub-agent activity to MiniChatCard (thinking, tool calls, results)
        if (input.delegationId) {
          const { broadcast } = await import("../websocket/index.js");
          broadcast({
            type: "subagent-chat:activity",
            data: {
              delegationId: input.delegationId,
              chunk: {
                type: chunk.type,
                payload: chunk.payload,
                timestamp: chunk.timestamp,
              },
            },
          });
        }

        if (chunk.type !== "text-delta") {
          continue;
        }
        const payload = chunk.payload as TextDeltaPayload;
        if (typeof payload.text === "string") {
          text += payload.text;
        }
      }

      // Flush any remaining thinking buffer at end of stream
      if (input.appendLog && thinkingBuffer.trim()) {
        await input.appendLog(`💭 Thinking: ${thinkingBuffer.trim()}`);
        thinkingBuffer = "";
      }
    } catch (err) {
      // If error wasn't a rate limit, rethrow
      if (!retryWithApiKey) throw err;
    }

    // Retry with API key if OAuth rate limit was hit
    if (retryWithApiKey && authType === "oauth") {
      // Try to get API key
      const authProvider = provider === "openai-codex" ? "openai" : provider;
      const keyName =
        authProvider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
      const keys = await getApiKeys([keyName]);

      if (!keys[keyName]) {
        throw new Error(
          `OAuth rate limit reached and no API key available for ${provider}. ` +
            `Add an API key in Settings or wait for rate limit to reset.`,
        );
      }

      console.log(
        `[AgentService] Retrying with API key for ${provider} (OAuth rate limited)`,
      );

      // Retry with API key
      const apiKeyConfig: AgentConfigInternal = {
        ...config,
        apiKey: keys[keyName],
        authType: "apiKey",
      };

      // Create new chatId for retry to avoid session cache
      const retryChatId = `${chatId}-retry`;
      thinkingBuffer = ""; // Reset thinking buffer for retry

      for await (const chunk of this.streamAgent(
        retryChatId,
        input.prompt,
        apiKeyConfig,
        {
          allowedToolIds: input.allowedToolIds,
          maxSteps: input.maxTurns,
        },
      )) {
        if (chunk.type === "error") {
          const errMsg =
            (chunk.payload as { error?: string })?.error ?? "Model API error";
          throw new Error(
            `Agent job model error (${provider}/${model}) after API key fallback: ${errMsg}`,
          );
        }

        // Log structured activity to job logs (same as main path)
        if (input.appendLog) {
          if (chunk.type === "reasoning-delta") {
            const payload = chunk.payload as ReasoningDeltaPayload;
            if (typeof payload.text === "string") {
              thinkingBuffer += payload.text;
            }
          } else if (chunk.type === "tool-call") {
            if (thinkingBuffer.trim()) {
              await input.appendLog(`💭 Thinking: ${thinkingBuffer.trim()}`);
              thinkingBuffer = "";
            }
            const payload = chunk.payload as ToolCallPayload;
            const argsStr = payload.args
              ? JSON.stringify(payload.args).slice(0, 200)
              : "";
            await input.appendLog(
              `🔧 Tool: ${payload.toolName}${argsStr ? `(${argsStr}${argsStr.length >= 200 ? "..." : ""})` : "()"}`,
            );
          } else if (chunk.type === "tool-result") {
            const payload = chunk.payload as ToolResultPayload;
            const resultStr =
              typeof payload.result === "string"
                ? payload.result.slice(0, 300)
                : JSON.stringify(payload.result).slice(0, 300);
            await input.appendLog(
              `✅ Result: ${resultStr}${resultStr.length >= 300 ? "..." : ""}`,
            );
          } else if (chunk.type === "tool-error") {
            const payload = chunk.payload as ErrorPayload;
            await input.appendLog(
              `❌ Error: ${typeof payload.error === "string" ? payload.error : JSON.stringify(payload.error)}`,
            );
          } else if (chunk.type === "text-delta") {
            if (thinkingBuffer.trim()) {
              await input.appendLog(`💭 Thinking: ${thinkingBuffer.trim()}`);
              thinkingBuffer = "";
            }
          }
        }

        // Broadcast sub-agent activity to MiniChatCard (same as main path)
        if (input.delegationId) {
          const { broadcast } = await import("../websocket/index.js");
          broadcast({
            type: "subagent-chat:activity",
            data: {
              delegationId: input.delegationId,
              chunk: {
                type: chunk.type,
                payload: chunk.payload,
                timestamp: chunk.timestamp,
              },
            },
          });
        }

        if (chunk.type !== "text-delta") {
          continue;
        }
        const payload = chunk.payload as TextDeltaPayload;
        if (typeof payload.text === "string") {
          text += payload.text;
        }
      }

      // Flush any remaining thinking buffer at end of retry stream
      if (input.appendLog && thinkingBuffer.trim()) {
        await input.appendLog(`💭 Thinking: ${thinkingBuffer.trim()}`);
        thinkingBuffer = "";
      }
    }

    const trimmed = text.trim();
    if (trimmed.length === 0) {
      console.error(
        `[AgentService] runIsolatedJobSession produced no output. ` +
          `provider=${provider} model=${model} authType=${authType}. ` +
          `Check: OAuth connected? API key set? Gateway logs for API errors.`,
      );
    }
    return { chatId, text: trimmed };
  }

  /**
   * Run a structured output session using AI SDK's generateObject.
   * Uses model-level constrained decoding (not prompt-based) to guarantee
   * the response matches the provided JSON schema exactly.
   *
   * This replaces the old pattern of: streamText → JSON.parse → manual validation.
   */
  async runStructuredJobSession(input: {
    jobId: string;
    runId: string;
    prompt: string;
    outputSchema: Record<string, unknown>;
    schemaName?: string;
    schemaDescription?: string;
    provider?: Provider;
    model?: string;
  }): Promise<{ chatId: string; object: unknown }> {
    if (!this.initialized) {
      throw new Error("AgentService not initialized");
    }

    await this.ensureKeysLoaded();

    // Resolve default provider and model based on user's available authentication
    let provider = input.provider;
    let modelId = input.model;
    
    if (!provider || !modelId) {
      const { getDefaultProviderAndModel } = await import("../utils/defaultProvider.js");
      const defaults = await getDefaultProviderAndModel();
      provider = provider ?? defaults.provider;
      modelId = modelId ?? defaults.model;
      console.log(`[AgentService] Using default provider/model: ${provider}/${modelId}`);
    }

    const defaultModelByProvider: Record<Provider, string> = {
      openai: "gpt-5.2",
      "openai-codex": "gpt-5.3-codex",
      anthropic: "claude-sonnet-4-6",
      google: "gemini-2.5-flash",
      ollama: "qwen3.5:latest",
    };
    modelId = modelId ?? defaultModelByProvider[provider];

    const chatId = `job:${input.jobId}:${input.runId}`;

    // Use getProviderAuth for openai/anthropic (handles OAuth + API key)
    let apiKey: string | undefined;
    let authType: "oauth" | "apiKey" | undefined;
    const { getProviderAuth, getApiKeys } =
      await import("../utils/keyResolver.js");

    // Check if the specified provider is available
    let authCheckFailed = false;
    let originalProvider = provider;

    if (
      provider === "openai" ||
      provider === "openai-codex" ||
      provider === "anthropic"
    ) {
      const authProvider = provider === "openai-codex" ? "openai" : provider;
      const auth = await getProviderAuth(authProvider);
      if (!auth) {
        authCheckFailed = true;
        console.warn(
          `[AgentService] No authentication found for specified provider (${provider}). Falling back to default provider...`,
        );
      } else {
        apiKey = auth.type === "oauth" ? auth.token : auth.key;
        authType = auth.type;
      }
    } else {
      const keyName =
        provider === "google" ? "GOOGLE_API_KEY" : "OPENAI_API_KEY";
      const keys = await getApiKeys([keyName]);
      apiKey = keys[keyName];
      if (!apiKey) {
        authCheckFailed = true;
        console.warn(
          `[AgentService] Missing API key for specified provider (${provider}): ${keyName}. Falling back to default provider...`,
        );
      }
    }

    // If auth check failed, fall back to default provider
    if (authCheckFailed) {
      // Try smart fallback based on original model capabilities
      const { getBestFallbackModel } = await import("../utils/smartFallback.js");
      const { getAvailableProviders } = await import("../utils/defaultProvider.js");
      
      const available = await getAvailableProviders();
      const fallback = await getBestFallbackModel(
        originalProvider,
        input.model || "unknown",
        available,
      );

      if (fallback) {
        provider = fallback.provider;
        modelId = fallback.model;
        console.log(
          `[AgentService] Smart fallback: ${originalProvider}/${input.model || "default"} → ${provider}/${modelId} (capability-matched)`,
        );
      } else {
        // No smart fallback available, use basic default
        const { getDefaultProviderAndModel } = await import("../utils/defaultProvider.js");
        const defaults = await getDefaultProviderAndModel();
        provider = defaults.provider;
        modelId = defaults.model;
        console.log(
          `[AgentService] Falling back from ${originalProvider} to ${provider}/${modelId}`,
        );
      }

      // Re-check auth for fallback provider
      if (provider === "openai" || provider === "anthropic") {
        const auth = await getProviderAuth(provider);
        if (!auth) {
          throw new Error(
            `No authentication found for fallback provider (${provider}). Please configure at least one provider.`,
          );
        }
        apiKey = auth.type === "oauth" ? auth.token : auth.key;
        authType = auth.type;
      } else if (provider === "google") {
        const keys = await getApiKeys(["GOOGLE_API_KEY"]);
        apiKey = keys.GOOGLE_API_KEY;
        if (!apiKey) {
          throw new Error(`Missing API key for fallback provider: GOOGLE_API_KEY`);
        }
      } else if (provider === "ollama") {
        // Ollama doesn't need auth
        apiKey = ""; // Empty string for Ollama
      } else {
        // Unexpected provider without auth setup
        throw new Error(
          `No authentication configuration found for fallback provider: ${provider}`,
        );
      }
    }

    // Ensure apiKey is assigned before proceeding
    if (apiKey === undefined) {
      throw new Error(
        `Failed to obtain API key for provider: ${provider}. Please configure authentication.`,
      );
    }

    // When OAuth: AI SDK generateObject fails (Platform API needs different auth).
    // Use streamAgent (pi-ai path) with JSON prompt and parse result.
    const usePiAi =
      (provider === "openai" ||
        provider === "openai-codex" ||
        provider === "anthropic") &&
      authType === "oauth";

    if (usePiAi) {
      const schemaStr = JSON.stringify(input.outputSchema, null, 2);
      const jsonPrompt = `${input.prompt}\n\nRespond with ONLY valid JSON matching this schema (no markdown, no explanation):\n${schemaStr}`;
      const config: AgentConfigInternal = {
        provider,
        model: modelId,
        apiKey,
        authType,
        systemPrompt: `${this.systemPrompt}\n\n# Structured Output Job\n- Session: ${chatId}\n- Return ONLY valid JSON matching the requested schema. No markdown code blocks, no explanation.`,
      };

      let text = "";
      let retryWithApiKey = false;

      try {
        for await (const chunk of this.streamAgent(chatId, jsonPrompt, config, {
          maxSteps: 10,
        })) {
          if (chunk.type === "error") {
            const errMsg =
              (chunk.payload as { error?: string })?.error ?? "Model API error";

            // Check if this is an OAuth rate limit error
            if (
              errMsg.includes("usage limit") ||
              errMsg.includes("rate limit") ||
              errMsg.includes("Try again in")
            ) {
              console.log(
                `[AgentService] OAuth rate limit hit for structured job (${provider}). Retrying with API key...`,
              );
              retryWithApiKey = true;
              break;
            }

            throw new Error(
              `Structured job model error (${provider}/${modelId}): ${errMsg}`,
            );
          }
          if (chunk.type === "text-delta") {
            const payload = chunk.payload as { text?: string };
            if (typeof payload.text === "string") text += payload.text;
          }
        }
      } catch (err) {
        if (!retryWithApiKey) throw err;
      }

      // Retry with API key if OAuth rate limit was hit
      if (retryWithApiKey) {
        const authProvider = provider === "openai-codex" ? "openai" : provider;
        const keyName =
          authProvider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
        const keys = await getApiKeys([keyName]);

        if (!keys[keyName]) {
          throw new Error(
            `OAuth rate limit reached and no API key available for ${provider}. ` +
              `Add an API key in Settings or wait for rate limit to reset.`,
          );
        }

        console.log(
          `[AgentService] Retrying structured job with API key for ${provider} (OAuth rate limited)`,
        );

        // Fall through to API key path below (generateObject)
        apiKey = keys[keyName];
        authType = "apiKey";
      } else {
        // No retry needed, parse and return
        const parsed = this.parseJsonFromResponse(text);
        return { chatId, object: parsed };
      }
    }

    // API key path: use AI SDK generateObject (model-level schema enforcement)
    await this.setProviderAuth(provider, apiKey);
    const model = await this.createLanguageModel(provider, modelId);

    const result = await generateObject({
      model,
      schema: jsonSchema(input.outputSchema),
      schemaName: input.schemaName,
      schemaDescription: input.schemaDescription,
      prompt: input.prompt,
      system: `${this.systemPrompt}\n\n# Structured Output Job\n- Session: ${chatId}\n- Return data matching the requested schema exactly.`,
    });

    return { chatId, object: result.object };
  }

  /** Parse JSON from model response (handles markdown code blocks) */
  private parseJsonFromResponse(text: string): unknown {
    const trimmed = text.trim();
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : trimmed;
    try {
      return JSON.parse(jsonStr || "{}");
    } catch (e) {
      console.error("[AgentService] Failed to parse structured output:", e);
      throw new Error(
        `Structured output job returned invalid JSON. Raw response: ${text.slice(0, 200)}...`,
      );
    }
  }

  /**
   * Set provider API key or OAuth token in environment so AI SDK providers can pick it up.
   * Prioritizes OAuth tokens over API keys.
   */
  private async setProviderAuth(
    provider: Provider,
    apiKey?: string,
  ): Promise<void> {
    // Ollama runs locally, no authentication needed
    if (provider === "ollama") {
      console.log(`[AgentService] Ollama provider - no authentication needed`);
      return;
    }

    // First, try to use OAuth token (if available)
    const { getProviderAuth } = await import("../utils/keyResolver.js");

    if (
      provider === "openai" ||
      provider === "openai-codex" ||
      provider === "anthropic"
    ) {
      // Map openai-codex to openai for OAuth lookup (they share the same OAuth token)
      const authProvider = provider === "openai-codex" ? "openai" : provider;
      const auth = await getProviderAuth(authProvider);

      if (auth) {
        if (auth.type === "oauth") {
          // Set OAuth token as API key (AI SDK uses OPENAI_API_KEY/ANTHROPIC_API_KEY env vars)
          switch (provider) {
            case "openai":
            case "openai-codex":
              process.env.OPENAI_API_KEY = auth.token;
              console.log(
                `[AgentService] Using OpenAI OAuth token for ${provider}`,
              );
              break;
            case "anthropic":
              process.env.ANTHROPIC_API_KEY = auth.token;
              console.log(`[AgentService] Using Anthropic OAuth token`);
              break;
          }
          return;
        } else if (auth.type === "apiKey") {
          // Use API key
          switch (provider) {
            case "openai":
            case "openai-codex":
              process.env.OPENAI_API_KEY = auth.key;
              console.log(
                `[AgentService] Using OpenAI API key for ${provider}`,
              );
              break;
            case "anthropic":
              process.env.ANTHROPIC_API_KEY = auth.key;
              console.log(`[AgentService] Using Anthropic API key`);
              break;
          }
          return;
        }
      }
    }

    // Fall back to provided API key (for non-OAuth providers or when OAuth not available)
    if (apiKey) {
      switch (provider) {
        case "anthropic":
          process.env.ANTHROPIC_API_KEY = apiKey;
          break;
        case "openai":
        case "openai-codex":
          process.env.OPENAI_API_KEY = apiKey;
          break;
        case "google":
          process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
          break;
      }
    }
  }

  /**
   * Create an AI SDK LanguageModel instance for the given provider and model ID.
   * Centralises model creation logic shared by streamAgent and generateObject paths.
   */
  private async createLanguageModel(
    provider: Provider,
    modelId: string,
  ): Promise<LanguageModel> {
    switch (provider) {
      case "anthropic": {
        const { anthropic } = await import("@ai-sdk/anthropic");
        return anthropic(modelId) as LanguageModel;
      }
      case "openai": {
        const { openai } = await import("@ai-sdk/openai");
        const { normalizeOpenAIModelId } =
          await import("../utils/modelNormalizer.js");
        const normalizedModel = normalizeOpenAIModelId(modelId);
        if (normalizedModel.startsWith("gpt-5")) {
          return openai.responses(normalizedModel) as LanguageModel;
        }
        return openai(normalizedModel) as LanguageModel;
      }
      case "openai-codex": {
        // OpenAI Codex uses the same SDK but with OAuth token
        // The token is already set in OPENAI_API_KEY by setProviderAuth
        const { openai } = await import("@ai-sdk/openai");
        // Use responses API for Codex models (gpt-5.3-codex)
        return openai.responses(modelId) as LanguageModel;
      }
      case "google": {
        const { google } = await import("@ai-sdk/google");
        const { normalizeGoogleModelId } =
          await import("../utils/modelNormalizer.js");
        return google(normalizeGoogleModelId(modelId)) as LanguageModel;
      }
      case "ollama": {
        const { ollama } = await import("ollama-ai-provider-v2");
        return ollama(modelId) as LanguageModel;
      }
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  private async buildContextualSystemPrompt(
    chatId: string,
    history: unknown[],
    enabledSkills?: Array<{ id: string; name: string; description: string }>,
  ): Promise<string> {
    const includeExtendedAppPlaybook = this.hasAppAutomationContext(history);

    // Load active plans for this chat
    let activePlans:
      | Array<{
          planId: string;
          title: string;
          steps: Array<{ id: string; description: string; status: string }>;
          createdAt: string;
        }>
      | undefined;

    try {
      const { getPlanService } = await import("./PlanService.js");
      const planService = getPlanService();
      await planService.initialize();
      const plans = await planService.getActivePlansForChat(chatId);

      if (plans.length > 0) {
        activePlans = plans.map((plan) => ({
          planId: plan.planId,
          title: plan.title,
          steps: plan.steps,
          createdAt: plan.createdAt,
        }));
      }
    } catch (error) {
      console.warn("[AgentService] Failed to load active plans:", error);
      // Continue without plans context
    }

    // Load workspace context (persistent memory, identity, daily logs)
    let workspaceContext: WorkspaceContextData | undefined;
    try {
      const workspaceService = getWorkspaceService();
      const ctx = await workspaceService.loadWorkspaceContext();
      // Only inject if there's meaningful content
      if (
        ctx.files.length > 0 ||
        ctx.dailyLogs.length > 0 ||
        ctx.onboardingPending
      ) {
        workspaceContext = ctx;
      }
    } catch (error) {
      console.warn("[AgentService] Failed to load workspace context:", error);
      // Continue without workspace context
    }

    return buildSystemPrompt({
      userDataPath: this.userDataPath,
      workspacePath: process.cwd(),
      availableTools: allTools.map((tool) => tool.id),
      customKeys: [],
      includeExtendedAppPlaybook,
      activeSkills: enabledSkills,
      activePlans,
      workspaceContext,
    });
  }

  private hasAppAutomationContext(history: unknown[]): boolean {
    // Check if any previous messages used app/job automation tools
    for (const entry of history) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }

      const candidate = entry as {
        content?: unknown;
        role?: string;
        tool_calls?: unknown;
        toolCalls?: unknown;
      };

      const toolCalls = Array.isArray(candidate.toolCalls)
        ? candidate.toolCalls
        : Array.isArray(candidate.tool_calls)
          ? candidate.tool_calls
          : [];
      for (const call of toolCalls) {
        if (typeof call !== "object" || call === null) {
          continue;
        }
        const name = (call as { name?: unknown }).name;
        if (typeof name === "string" && this.appAutomationToolIds.has(name)) {
          return true;
        }
      }

      if (typeof candidate.content === "string") {
        if (!candidate.content.includes("[tool_activity]")) {
          continue;
        }
        for (const toolId of this.appAutomationToolIds) {
          if (candidate.content.includes(toolId)) {
            return true;
          }
        }
      }
    }

    // Also check user messages for app/automation keywords
    // This ensures extended playbook loads on FIRST message about apps
    for (const entry of history) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }

      const candidate = entry as { content?: unknown; role?: string };

      if (candidate.role === "user" && typeof candidate.content === "string") {
        const content = candidate.content.toLowerCase();
        const appKeywords = [
          "build app",
          "build a app",
          "build an app",
          "create app",
          "create a app",
          "create an app",
          "mini-app",
          "mini app",
          "dashboard",
          "tracker",
          "monitor",
          "automation",
          "automate",
        ];

        if (appKeywords.some((keyword) => content.includes(keyword))) {
          return true;
        }
      }
    }

    return false;
  }

  async getGlobalCostStats(): Promise<{
    today: number;
    thisWeek: number;
    thisMonth: number;
    total: number;
    totalMessages: number;
    topModels: Array<{ model: string; cost: number; count: number }>;
  }> {
    return this.storageManager.getGlobalCostStats();
  }

  async getChatCost(chatId: string): Promise<{
    total: number;
    byModel: Record<string, number>;
    messageCount: number;
    avgCostPerMessage: number;
  }> {
    return this.storageManager.getChatCost(chatId);
  }

  async getDailyCostTrends(
    days?: number,
  ): Promise<Array<{ date: string; cost: number; messages: number }>> {
    return this.storageManager.getDailyCostTrends(days);
  }

  async getModelDistribution(): Promise<
    Array<{ model: string; percentage: number; cost: number; messages: number }>
  > {
    return this.storageManager.getModelDistribution();
  }

  async getAgentStats(agentId: string): Promise<{
    totalMessages: number;
    totalTokens: number;
    totalCost: number;
    toolCallsCount: number;
    avgTokensPerMessage: number;
    avgCostPerMessage: number;
    mostUsedTools: Array<{ tool: string; count: number }>;
  }> {
    return this.storageManager.getAgentStats(agentId);
  }

  async getAgentOutputs(agentId?: string): Promise<{
    documents: Array<{ id: string; title: string; createdAt: string }>;
    apps: Array<{ id: string; title: string; createdAt: string }>;
    plans: Array<{ planId: string; title: string; createdAt: string }>;
  }> {
    return this.storageManager.getAgentOutputs(agentId);
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
  mode: "local" | "papr" | "hybrid";
  paprApiKey?: string;
  openaiApiKey?: string;
}): Promise<AgentService> {
  const service = getAgentService();
  await service.initialize(config);
  return service;
}

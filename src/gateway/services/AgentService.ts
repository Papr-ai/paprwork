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
    options?: {
      allowedToolIds?: string[];
      maxSteps?: number;
      /** Internal: set true when this is an auto-recovery retry of an empty completion. Prevents infinite loops. */
      _isSilentRetry?: boolean;
      /** Internal: skip re-saving the user message (it's already saved from the original turn). */
      _skipSaveUserMessage?: boolean;
    },
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
    // Model-aware thresholds: GPT-5.5 has 1M, GPT-5.4-mini has 272K, Claude Opus 4.7 has 1M, older Claude 200K
    const getContextAbortThreshold = (): number => {
      const model = config.model?.toLowerCase() ?? "";
      
      // GPT-5.5 (1M context)
      if (model.startsWith("gpt-5.5")) {
        return 750000; // 1M - 250K buffer
      }
      
      // GPT-5.4-mini (272K context) - legacy 5.4 variants map to 5.5 now
      if (model.startsWith("gpt-5.4") || model.startsWith("gpt-5.3") || model.startsWith("gpt-5.2")) {
        return 750000; // Forward compatibility: treat as 5.5 tier
      }
      
      // Claude Opus 4.7 (1M context)
      if (model === "claude-opus-4-7") {
        return 750000; // 1M - 250K buffer
      }
      
      // Older Claude models (200K context)
      return 120000; // Claude 200K - 80K buffer (conservative)
    };
    const CONTEXT_ABORT_THRESHOLD = getContextAbortThreshold();
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
      if (!options?._skipSaveUserMessage) {
        await this.storageManager.saveMessage(chatId, userMsg);
      }
      timings.saveUserMessage = performance.now() - t;

      // 2. Load message history for LLM context
      t = performance.now();
      const historyRaw = await this.storageManager.loadMessagesForLLM(chatId);

      console.log(`\n${'='.repeat(100)}`);
      console.log(`🔵 STAGE 2.5: MESSAGES RECEIVED FROM STORAGE (Before LLM formatting)`);
      console.log(`${'='.repeat(100)}`);
      console.log(`[STAGE 2.5] Received ${historyRaw.length} items from storage`);
      
      // Check for summary
      const hasSummary = historyRaw.some(item => typeof item === "object" && item !== null && "__summary" in item);
      console.log(`[STAGE 2.5] Contains __summary object: ${hasSummary}`);
      
      // Log role distribution
      const roleCount = historyRaw.reduce((acc: any, item: any) => {
        if ('__summary' in item) {
          acc['__summary'] = (acc['__summary'] || 0) + 1;
        } else {
          acc[item.role] = (acc[item.role] || 0) + 1;
        }
        return acc;
      }, {});
      console.log(`[STAGE 2.5] Item distribution:`, roleCount);
      
      // Log first few items
      console.log(`[STAGE 2.5] First 5 items from storage:`);
      historyRaw.slice(0, 5).forEach((item: any, i: number) => {
        if ('__summary' in item) {
          console.log(`  [${i}] __summary (${item.__summary.length} chars)`);
        } else {
          const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
          const timestamp = item.timestamp || item.createdAt || 'no-timestamp';
          console.log(`  [${i}] ${item.role.padEnd(10)} | ${timestamp.substring(11, 19)} | ${content.substring(0, 50)}...`);
        }
      });

      // Extract summary if present (injected by storage providers)
      let conversationSummary: string | undefined;
      
      const history = historyRaw.filter((msg) => {
        if (typeof msg === "object" && msg !== null && "__summary" in msg) {
          conversationSummary = (msg as { __summary: string }).__summary;
          console.log(`[STAGE 2.5] ✅ Extracted summary (${conversationSummary.length} chars)`);
          return false; // Remove from history
        }
        return true; // Keep in history
      });

      console.log(`[STAGE 2.5] After extracting summary: ${history.length} messages`);
      
      // Log role distribution after summary extraction
      const historyRoleCount = history.reduce((acc: any, m: any) => {
        acc[m.role] = (acc[m.role] || 0) + 1;
        return acc;
      }, {});
      console.log(`[STAGE 2.5] Role distribution (no summary):`, historyRoleCount);
      
      // Log last 5 messages that will go to LLM
      console.log(`[STAGE 2.5] Last 5 messages going to LLM:`);
      history.slice(-5).forEach((msg: any, i: number) => {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const timestamp = msg.timestamp || msg.createdAt || 'no-timestamp';
        const actualIdx = history.length - 5 + i;
        console.log(`  [${actualIdx}] ${msg.role.padEnd(10)} | ${timestamp.substring(11, 19)} | ${content.substring(0, 50)}...`);
      });
      console.log(`${'='.repeat(100)}\n`);

      timings.loadHistory = performance.now() - t;

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

      // For Ollama models (Qwen, Gemma, etc.) — thinking + adaptive context
      if (config.provider === "ollama") {
        // Adaptive context sizing based on available RAM
        // Smaller context = much faster inference on constrained hardware
        // Web research: 32K causes VRAM overflow; 8-16K gives 40+ tok/s vs 17-25 tok/s
        let totalRamGb = 16; // Safe default
        try {
          const os = await import("node:os");
          totalRamGb = Math.round(os.default.totalmem() / 1024 ** 3);
        } catch {
          // Ignore import errors
        }

        providerOptions.ollama = {
          think: true,
          options: {
            // Context size: 8K for <16GB, 16K for 16-31GB, 32K for 32GB+
            num_ctx: totalRamGb < 16 ? 8192 : totalRamGb < 32 ? 16384 : 32768,
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

      // Build native web search tools configuration
      const nativeSearchTools = await this.buildNativeSearchTools(config.provider);

      const streamTextOptions: any = {
        model,
        messages,
        tools: { 
          ...(tools as unknown as ToolSet),
          ...nativeSearchTools, // Merge native search tools
        },
        maxTokens: effectiveMaxTokens,
        // Allow up to maxSteps tool roundtrips before stopping.
        // Hard limit at maxSteps (default 100), but we force stop at 95 to give
        // the model a chance to respond gracefully before hitting the limit.
        // Warnings start at 90 steps via prepareStep.
        stopWhen: (stopOptions: any) => {
          const stepCount = stopOptions.steps.length;
          const maxSteps = options?.maxSteps ?? 100;
          const FORCE_STOP = 95;
          
          if (stepCount >= FORCE_STOP) {
            console.warn(
              `[AgentService] 🛑 Force stopping at step ${stepCount} (threshold: ${FORCE_STOP}/${maxSteps})`
            );
            return true;
          }
          
          return stepCount >= maxSteps;
        },
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
        // Compact stale tool results before each model call.
        // Fresh batch (most recent) stays full; older batches get truncated.
        // Also handles step-limit warnings.
        prepareStep: async (stepOptions: {
          messages: any[];
          stepNumber: number;
          steps: Array<{
            usage?: { promptTokens?: number; completionTokens?: number };
          }>;
        }) => {
          const totalPromptTokens = cumulativePromptTokens;
          console.log(
            `[prepareStep] Step ${stepOptions.stepNumber}: ${Math.round(totalPromptTokens / 1000)}K tokens, ` +
              `${stepOptions.messages.length} messages`,
          );

          // Check if approaching step limit and warn the model
          const maxSteps = options?.maxSteps ?? 100;
          const STEP_WARNING_THRESHOLD = 90;
          const stepNumber = stepOptions.stepNumber || 0;

          if (stepNumber >= STEP_WARNING_THRESHOLD) {
            console.warn(
              `[prepareStep] ⚠️ Step ${stepNumber}/${maxSteps}: Approaching step limit.`,
            );
            const warningMessage = {
              role: "user",
              content: `[SYSTEM NOTE: You've made ${stepNumber} tool calls out of ${maxSteps} maximum. Please complete your current task and provide a final response soon. Avoid unnecessary tool calls.]`,
            };
            const msgs = [...stepOptions.messages, warningMessage];
            // Import and compact on the cloned array
            const { compactStaleToolResults } = await import("./agent/compactToolResults.js");
            compactStaleToolResults(msgs);
            return { messages: msgs };
          }

          // Clone messages and compact stale tool results
          const msgs = [...stepOptions.messages];
          const { compactStaleToolResults } = await import("./agent/compactToolResults.js");
          compactStaleToolResults(msgs);
          return { messages: msgs };
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
        // For openai provider with OAuth, map model to pi-ai format (gpt-5.4-low -> gpt-5.4)
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
            // Manual registry entry when pi-ai has not listed the id yet
            const isMini = piModelId === "gpt-5.4-mini";
            const is55 = piModelId.startsWith("gpt-5.5");
            const is55Pro = piModelId === "gpt-5.5-pro";
            
            const inputCost = is55Pro ? 30.0 : is55 ? 5.0 : isMini ? 0.75 : 2.5;
            const outputCost = is55Pro ? 180.0 : is55 ? 30.0 : isMini ? 4.5 : 15.0;
            const displayName = is55Pro ? "GPT-5.5 Pro" : is55 ? "GPT-5.5" : isMini ? "GPT-5.4 mini" : "GPT-5.4";
            
            finalModel = {
              id: piModelId,
              name: displayName,
              api: piApiId,
              provider: piProvider,
              baseUrl: "https://chatgpt.com/backend-api",
              reasoning: true,
              input: ["text", "image"],
              cost: {
                input: inputCost,
                output: outputCost,
                cacheRead: 0.25,
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
        
        // Build native web search tools for pi-ai providers
        const nativeSearchTools = this.buildNativeSearchToolsForPiAi(piProvider);
        
        const piContext = buildPiContext({
          messages: messages as any[],
          tools: tools as any,
          apiId: piApiId,
          providerId: piProvider,
          modelId: piModelId,
          nativeTools: nativeSearchTools,
        });

        // 🔍 LOG EXACT CONTEXT SENT TO PI-AI
        console.log(`\n${'='.repeat(100)}`);
        console.log(`🟡 STAGE 3: SENDING CONTEXT TO LLM (PI-AI)`);
        console.log(`${'='.repeat(100)}`);
        console.log(`[STAGE 3] Model: ${piModelId}`);
        console.log(`[STAGE 3] Provider: ${piProvider}`);
        console.log(`[STAGE 3] Total messages: ${piContext.messages?.length || 0}`);
        console.log(`[STAGE 3] System prompt length: ${piContext.systemPrompt?.length || 0} chars`);
        console.log(`[STAGE 3] Tools available: ${Object.keys(tools).length}`);
        
        // Log role distribution
        if (piContext.messages && Array.isArray(piContext.messages)) {
          const roleCount = piContext.messages.reduce((acc: any, m: any) => {
            acc[m.role] = (acc[m.role] || 0) + 1;
            return acc;
          }, {});
          console.log(`[STAGE 3] Role distribution in context:`, roleCount);
        }
        
        console.log(`\n[STAGE 3] FIRST 5 MESSAGES (should be oldest):`);
        console.log(`${'─'.repeat(100)}`);
        if (piContext.messages && Array.isArray(piContext.messages)) {
          piContext.messages.slice(0, 5).forEach((msg: any, i: number) => {
            const contentPreview = typeof msg.content === 'string' 
              ? msg.content.substring(0, 80)
              : Array.isArray(msg.content)
                ? `Array[${msg.content.length}]: ${JSON.stringify(msg.content[0]).substring(0, 60)}...`
                : JSON.stringify(msg.content).substring(0, 80);
            const timestamp = msg.timestamp || 'no-timestamp';
            console.log(`  [${i}] ${msg.role.padEnd(12)} | ts:${timestamp} | ${contentPreview}`);
          });
        }
        console.log(`\n[STAGE 3] LAST 10 MESSAGES (should be newest):`);
        console.log(`${'─'.repeat(100)}`);
        if (piContext.messages && Array.isArray(piContext.messages)) {
          const startIdx = Math.max(0, piContext.messages.length - 10);
          piContext.messages.slice(startIdx).forEach((msg: any, i: number) => {
            const actualIdx = startIdx + i;
            const contentPreview = typeof msg.content === 'string' 
              ? msg.content.substring(0, 80)
              : Array.isArray(msg.content)
                ? `Array[${msg.content.length}]: ${JSON.stringify(msg.content[0]).substring(0, 60)}...`
                : JSON.stringify(msg.content).substring(0, 80);
            const timestamp = msg.timestamp || 'no-timestamp';
            console.log(`  [${actualIdx}] ${msg.role.padEnd(12)} | ts:${timestamp} | ${contentPreview}`);
          });
        }
        console.log(`${'='.repeat(100)}\n`);

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

      // 4. Empty-completion silent self-heal
      // If the model returned literally nothing (no text, no thinking, no tool
      // calls), and this isn't an aborted/cancelled run, transparently retry
      // ONCE before persisting. The most common cause is malformed history
      // (orphaned tool_use blocks from a prior interrupted stream); since the
      // historyFormatter now injects synthetic tool_results for orphans on
      // every load, the second attempt will see a healed history and respond
      // normally. This recovery is invisible to the user — no error chunk,
      // no UI banner, no saved-empty message.
      const isEmpty =
        assistantText.length === 0 &&
        thinkingText.length === 0 &&
        toolCalls.length === 0 &&
        !abortController.signal.aborted;

      if (isEmpty && !options?._isSilentRetry) {
        console.warn(
          `[AgentService] Empty completion detected (model returned 0 tokens of content). ` +
          `Silently retrying once to self-heal — likely caused by a stale orphaned tool_use ` +
          `in history that gets fixed on reload. chatId=${chatId} model=${config.model}`,
        );

        // Don't save the empty assistant message. Don't yield 'done'. Just
        // re-invoke ourselves with the same userMessage but flagged as a
        // silent retry so we don't loop, and skip re-saving the user msg.
        for await (const chunk of this.streamAgent(
          chatId,
          userMessage,
          config,
          {
            ...options,
            _isSilentRetry: true,
            _skipSaveUserMessage: true,
          },
        )) {
          yield chunk;
        }

        // Reset streaming state and return — the recursive call handled everything.
        this.sessionManager.setStreaming(chatId, false);
        return;
      }

      if (isEmpty && options?._isSilentRetry) {
        // Second attempt also empty — give up silently. Don't save an empty
        // message (would clutter the chat). Just log and return without yielding
        // "done" (parent will handle that). The next user message will
        // naturally retry the conversation with healed history.
        console.warn(
          `[AgentService] Silent retry also returned empty completion. ` +
          `Skipping save to keep chat clean. chatId=${chatId}`,
        );
        // DON'T yield "done" here - if this is a nested call (compression retry),
        // the parent would pass it to UI and create an empty message. Just return.
        this.sessionManager.setStreaming(chatId, false);
        return;
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

      // 4.5. Yield done chunk to signal stream completion to frontend
      // This ensures isSending is cleared even if last item was a tool call
      yield {
        type: "done",
        chatId,
        payload: {},
        timestamp: new Date().toISOString(),
      } as StreamChunk & { chatId: string };

      // 5. Export chat to ~/Papr/ folder
      const allMessages = await this.storageManager.loadMessages(chatId);
      const chatMeta = await this.storageManager.getChat(chatId);
      await this.chatExporter.exportChat(
        chatId,
        chatMeta?.title || null,
        allMessages,
      );

      // 6. Check if summarization is needed
      // Use actual context size (from AI SDK or tokenUsage) not just message tokens
      const stats = await this.storageManager.getChatStats(chatId);
      
      // For AI SDK path, use cumulativePromptTokens (tracked via onStepFinish)
      // For pi-ai path, use tokenUsage.promptTokens (extracted from done chunk)
      const actualContextTokens = cumulativePromptTokens || tokenUsage?.promptTokens || 0;
      const messageTokens = stats.token_count;
      
      console.log(`[AgentService] 📊 Chat stats after stream:`);
      console.log(`  Messages in DB: ${stats.message_count}, has_summary: ${stats.has_summary}`);
      console.log(`  Message tokens (DB): ${messageTokens}`);
      console.log(`  Actual context tokens: ${actualContextTokens}`);
      console.log(`  Context overhead: ${actualContextTokens - messageTokens} tokens (system prompts, tools, attachments, etc.)`);
      
      // Trigger summarization when actual context exceeds 60K tokens
      // This accounts for the full context including system prompts, tool definitions,
      // attached files, git status, etc. - not just message tokens.
      const SUMMARIZATION_THRESHOLD = 60000;
      
      if (actualContextTokens > SUMMARIZATION_THRESHOLD) {
        console.log(`[AgentService] 🔄 Context size (${actualContextTokens}) > ${SUMMARIZATION_THRESHOLD} threshold - triggering summarization`);
        // Trigger summarization in background (don't await)
        this.triggerSummarization(chatId).catch(console.error);
      } else {
        console.log(`[AgentService] ℹ️  Context size (${actualContextTokens}) below ${SUMMARIZATION_THRESHOLD} threshold - no summarization needed`);
      }
    } catch (error) {
      // If this was a context pressure abort, handle gracefully: compress + retry
      // This matches the pi-ai path behavior (line ~1183) so both routes get
      // automatic compression instead of failing.
      if (contextPressureAborted) {
        console.log(
          `[AgentService] ⚡ Context pressure abort caught — compressing and retrying (AI SDK path)`,
        );

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
        if (assistantText || toolCalls.length > 0) {
          const partialMsg: StoredMessage = createAssistantStoredMessage({
            chatId,
            model: config.model,
            assistantText,
            thinkingText,
            toolCalls,
            toolResults,
            sequence,
            usage: tokenUsage,
          });
          await this.storageManager.saveMessage(chatId, partialMsg);
          console.log(`✓ Saved partial response before retry`);
        }

        // Automatically retry with compressed context
        console.log(`🔄 Automatically retrying with compressed context...`);
        const continuationPrompt =
          "Continue from where you left off. You've already made progress on this task.";

        for await (const chunk of this.streamAgent(
          chatId,
          continuationPrompt,
          config,
          options,
        )) {
          yield chunk;
        }

        // Return after the retry completes (don't save message again or throw)
        return;
      }

      // Non-context-pressure errors: save error message and re-throw
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      const errorMsg: StoredMessage = createErrorStoredMessage({
        chatId,
        model: config.model,
        assistantText,
        thinkingText,
        toolCalls,
        toolResults,
        errorMessage,
        sequence,
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
      openai: "gpt-5.5",
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

          // Context limit errors are handled by streamAgent's compression logic.
          // Don't throw — let the generator resume so onContextPressure() fires
          // and streamAgent can compress + retry automatically.
          if (
            errMsg.includes("Context limit") ||
            errMsg.includes("context_length_exceeded")
          ) {
            console.log(
              `[AgentService] Context limit hit in job (${provider}/${model}). ` +
                `Letting streamAgent handle compression...`,
            );
            if (input.appendLog) {
              await input.appendLog(
                `⚠️ Context limit approaching — compressing conversation and continuing...`,
              );
            }
            continue;
          }

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

        // Log compression progress to job logs
        if (chunk.type === "compression-start" && input.appendLog) {
          await input.appendLog(`🔄 Compressing conversation history...`);
          continue;
        }
        if (chunk.type === "compression-complete" && input.appendLog) {
          await input.appendLog(`✅ Compression complete. Continuing with fresh context.`);
          continue;
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
      openai: "gpt-5.5",
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

            // Context limit errors are handled by streamAgent's compression logic
            if (
              errMsg.includes("Context limit") ||
              errMsg.includes("context_length_exceeded")
            ) {
              console.log(
                `[AgentService] Context limit hit in structured job (${provider}/${modelId}). ` +
                  `Letting streamAgent handle compression...`,
              );
              continue;
            }

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
          if (chunk.type === "compression-start" || chunk.type === "compression-complete") {
            continue;
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
    options?: { usePaprProxy?: boolean; paprApiKey?: string },
  ): Promise<LanguageModel> {
    // Route through Papr proxy if configured
    if (options?.usePaprProxy && options?.paprApiKey) {
      const { createProxyModel } = await import("../utils/paprProxyProvider.js");
      console.log(`[AgentService] Using Papr AI proxy for ${provider}/${modelId}`);
      return createProxyModel(provider, modelId, options.paprApiKey);
    }

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

  /**
   * Build native web search tools for supported providers (AI SDK format)
   * 
   * Providers with native search:
   * - Google: google.tools.googleSearch({})
   * - OpenAI: openai.tools.webSearch({ maxUses: 10 })
   * - Anthropic: anthropic.tools.webSearch_20260209({ maxUses: 10 })
   */
  private async buildNativeSearchTools(provider: Provider): Promise<Record<string, any>> {
    const tools: Record<string, any> = {};

    switch (provider) {
      case "google":
        // Gemini: Google Search tool
        try {
          const { google } = await import("@ai-sdk/google");
          if (google.tools?.googleSearch) {
            const googleSearchTool = google.tools.googleSearch({});
            // ⚠️ CRITICAL FIX: Override tool ID to remove dot (Gemini requires ^[a-zA-Z0-9_-]+$)
            // Original ID: "google.google_search" → Fixed ID: "google_search"
            tools.google_search = {
              ...googleSearchTool,
              id: "google_search", // Remove dot from ID
            };
            console.log("[AgentService] ✅ Enabled Google Search for Gemini (fixed tool ID: google_search)");
          } else {
            console.warn("[AgentService] ⚠️  Google Search not available in this SDK version");
          }
        } catch (error) {
          console.warn("[AgentService] ⚠️  Failed to load Google Search tool:", (error as Error).message);
        }
        break;

      case "openai":
        // OpenAI: web_search tool via AI SDK helper
        try {
          const { openai } = await import("@ai-sdk/openai");
          if (openai.tools?.webSearch) {
            const webSearchTool = openai.tools.webSearch({
              externalWebAccess: true, // Enable live web access
              searchContextSize: 'high', // Use high context for search results
            });
            // Check if tool has ID property and sanitize it if needed
            // OpenAI tools may or may not expose 'id', use key name as fallback
            const hasId = webSearchTool && typeof (webSearchTool as any).id === 'string';
            const toolId = hasId && (webSearchTool as any).id.includes('.')
              ? (webSearchTool as any).id.replace(/\./g, '_')
              : 'web_search';
            
            // Override ID if it exists and has dots
            if (hasId && (webSearchTool as any).id.includes('.')) {
              tools.web_search = {
                ...webSearchTool,
                id: toolId,
              };
              console.log("[AgentService] ✅ Enabled OpenAI web search (sanitized tool ID: " + toolId + ")");
            } else {
              tools.web_search = webSearchTool;
              console.log("[AgentService] ✅ Enabled OpenAI web search");
            }
          } else {
            console.warn("[AgentService] ⚠️  OpenAI web search not available in this SDK version");
          }
        } catch (error) {
          console.warn("[AgentService] ⚠️  Failed to load OpenAI web search tool:", (error as Error).message);
        }
        break;

      case "anthropic":
        // Anthropic: web_search disabled for now due to compatibility issues
        console.log("[AgentService] ℹ️  Anthropic: Web search disabled (use browser tools instead)");
        break;

      case "ollama":
        // Ollama: No native search (local models)
        console.log("[AgentService] ℹ️  Ollama: No native search (use browser tools instead)");
        break;

      default:
        console.log(`[AgentService] ℹ️  Provider ${provider}: No native search support`);
    }

    return tools;
  }

  /**
   * Build native web search tools for pi-ai providers (OAuth routes)
   * 
   * Same as buildNativeSearchTools but returns pi-ai compatible format
   */
  private buildNativeSearchToolsForPiAi(provider: string): Array<{ type: string; name?: string; max_uses?: number }> {
    const tools: Array<{ type: string; name?: string; max_uses?: number }> = [];

    switch (provider) {
      case "anthropic":
        // Anthropic: web_search disabled for now due to compatibility issues
        console.log("[AgentService] ℹ️  Anthropic OAuth: Web search disabled (use browser tools instead)");
        break;

      case "openai-codex":
        // OpenAI Codex: web_search tool
        // Note: May require specific ChatGPT backend support
        tools.push({
          type: "web_search",
          name: "web_search",
          max_uses: 10,
        });
        console.log("[AgentService] ⚠️  Added OpenAI Codex web_search via pi-ai (experimental)");
        break;

      default:
        console.log(`[AgentService] ℹ️  Provider ${provider}: No native search via pi-ai`);
    }

    return tools;
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

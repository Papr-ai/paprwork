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
import { streamText, generateObject, jsonSchema } from 'ai';
import type { LanguageModel, ToolSet, StepResult } from "ai";
import { ToolRegistry } from "../../core/agents/ToolRegistry.js";
import {
  allTools,
  getApiKeysForSanitization,
} from "../../core/tools/index.js";
import { buildSystemPrompt } from "../../core/agents/SystemPrompt.js";
import type { StreamChunk, TextDeltaPayload } from "../../core/types/index.js";
import type { AgentConfigInternal, Provider } from "../../core/types/agents.js";
import { StorageManager } from './StorageManager.js';
import { ChatSessionManager } from './ChatSessionManager.js';
import { TitleGenerationService } from './TitleGenerationService.js';
import { getSkillService, type SkillRecord } from './SkillService.js';
import { ChatExporter } from './storage/ChatExporter.js';
import type { StoredMessage } from './storage/IStorageProvider.js';
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
  private storageMode: 'local' | 'papr' | 'hybrid' = 'local';

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
      const registryTool = tool as unknown as Parameters<
        ToolRegistry["register"]
      >[0];
      this.toolRegistry.register(registryTool);
    }

    // Build compact default prompt.
    // Extended app playbook is injected contextually per request.
    this.systemPrompt = buildSystemPrompt({
      userDataPath: this.userDataPath,
      workspacePath: process.cwd(),
      availableTools: allTools.map(t => t.id),
      customKeys: [], // Will be updated when keys are loaded
      includeExtendedAppPlaybook: false,
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
      
      // Upgrade storage to hybrid mode if PAPR key is available
      // This always runs on first message - gateway starts in local mode,
      // then upgrades to hybrid once we can confirm the PAPR key exists
      if (keys.PAPR_API_KEY) {
        console.log('[AgentService] PAPR key available - upgrading to hybrid mode');
        await this.storageManager.initialize({
          mode: 'hybrid',
          userDataPath: this.userDataPath,
          paprApiKey: keys.PAPR_API_KEY,
        });
        this.storageMode = 'hybrid';
      } else {
        console.log('[AgentService] No PAPR key found - staying in local mode');
      }

      // Initialize title service if OpenAI key is available
      if (keys.OPENAI_API_KEY && !this.titleService) {
        this.titleService = new TitleGenerationService(keys.OPENAI_API_KEY);
        console.log('[AgentService] Title generation enabled');
      }

      // Only mark keys as fully loaded once we're in hybrid mode (or confirmed no PAPR key)
      this.keysLoaded = true;
      console.log(`[AgentService] Keys loaded. Storage mode: ${this.storageMode}`);
    } catch (error) {
      console.warn('[AgentService] Failed to load keys:', error);
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
      
      const fallback = generateFallbackTitle(firstMessage);
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
    options?: { allowedToolIds?: string[]; maxSteps?: number },
  ): AsyncGenerator<StreamChunk & { chatId: string }> {
    if (!this.initialized) {
      throw new Error('AgentService not initialized');
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
    let sequence: Array<{ type: 'text' | 'tool' | 'thinking'; data: any }> = [];

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
        role: 'user',
        content: userMessage,
        timestamp: new Date().toISOString(),
        sync_status: 'local',
      };
      await this.storageManager.saveMessage(chatId, userMsg);
      timings.saveUserMessage = performance.now() - t;

      // 2. Load message history for LLM context
      t = performance.now();
      const historyRaw = await this.storageManager.loadMessagesForLLM(chatId);
      
      // Extract summary if present (injected by storage providers)
      let conversationSummary: string | undefined;
      const history = historyRaw.filter((msg) => {
        if (typeof msg === 'object' && msg !== null && '__summary' in msg) {
          conversationSummary = (msg as { __summary: string }).__summary;
          return false; // Remove from history
        }
        return true; // Keep in history
      });
      
      timings.loadHistory = performance.now() - t;
      
      const historyCount = history.length;
      const historySize = JSON.stringify(history).length;
      const estimatedHistoryTokens = Math.ceil(historySize / 4);

      // 3. Gather enabled skills for system prompt context
      t = performance.now();
      let enabledSkills: Array<{ id: string; name: string; description: string }> | undefined;
      try {
        const skillService = getSkillService();
        const allSkills = await skillService.listSkills();
        const active = allSkills.filter((s: SkillRecord) => s.enabled);
        if (active.length > 0) {
          enabledSkills = active.map((s: SkillRecord) => ({
            id: s.id,
            name: s.name,
            description: s.description,
          }));
        }
      } catch {
        // Skills not initialized yet — proceed without them
      }
      timings.loadSkills = performance.now() - t;

      // 4. Build system prompt and messages
      t = performance.now();
      const systemPrompt =
        config.systemPrompt ||
        await this.buildContextualSystemPrompt(chatId, history, enabledSkills);
      const messages = buildModelMessages(history, userMessage, systemPrompt, conversationSummary);
      timings.buildMessages = performance.now() - t;
      
      // DEBUG: Log message structure to debug empty content blocks
      console.log(`[AgentService] 🔍 Built ${messages.length} messages for model:`);
      messages.forEach((msg, i) => {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          const textParts = msg.content.filter((p: any) => p.type === 'text');
          const toolCallParts = msg.content.filter((p: any) => p.type === 'tool-call');
          console.log(`  ${i}. assistant: ${textParts.length} text parts, ${toolCallParts.length} tool-call parts`);
          textParts.forEach((p: any, j: number) => {
            console.log(`    text[${j}]: "${p.text.substring(0, 50)}${p.text.length > 50 ? '...' : ''}"`);
          });
        } else if (msg.role === 'tool') {
          console.log(`  ${i}. tool: ${Array.isArray(msg.content) ? msg.content.length : 0} results`);
        } else {
          const contentPreview = typeof msg.content === 'string' 
            ? msg.content.substring(0, 50) 
            : JSON.stringify(msg.content).substring(0, 50);
          console.log(`  ${i}. ${msg.role}: "${contentPreview}${contentPreview.length >= 50 ? '...' : ''}"`);
        }
      });

      // Set tool execution context (so tools can access chatId)
      const { setToolContext } = await import("../../core/tools/context.js");
      setToolContext(chatId);

      // Get model from session
      const sessionWithModel = session.agent as unknown as { model: LanguageModel };
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
      } = {};
      
      // For OpenAI GPT-5.x models with reasoning effort and summary
      if (config.provider === 'openai' && config.reasoning?.effort) {
        providerOptions.openai = {
          reasoningEffort: config.reasoning.effort, // 'low' | 'medium' | 'high' | 'xhigh'
          reasoningSummary: 'detailed', // Enable detailed reasoning summaries for streaming
        };
      }
      
      // For Google Gemini models with thinking capabilities
      if (config.provider === 'google' && config.thinkingBudget !== undefined && config.thinkingBudget > 0) {
        providerOptions.google = {
          thinkingConfig: {
            includeThoughts: true, // Enable thought summaries in stream
            thinkingBudget: config.thinkingBudget, // Token budget for thinking
          },
        };
      }

      // Get registered tools for the model
      t = performance.now();
      const tools = this.toolRegistry.getToolsForMastra(options?.allowedToolIds);
      timings.getTools = performance.now() - t;
      
      // Log context size breakdown
      const messagesJson = JSON.stringify(messages);
      const toolsJson = JSON.stringify(tools);
      const estimatedMessageTokens = Math.ceil(messagesJson.length / 4);
      const toolTokens = Math.ceil(toolsJson.length / 4);
      const totalEstimatedTokens = estimatedMessageTokens + toolTokens;
      
      console.log(`[AgentService] 📊 Context Analysis for ${chatId}:`);
      console.log(`  History: ${historyCount} messages, ~${estimatedHistoryTokens} tokens`);
      console.log(`  Messages (with system): ${messages.length} messages, ~${estimatedMessageTokens} tokens`);
      console.log(`  Tools: ${Object.keys(tools).length} tools, ~${toolTokens} tokens`);
      console.log(`  Total context: ~${totalEstimatedTokens} tokens`);
      console.log(`  Config: maxTokens=${config.maxTokens || 'NOT SET'}, maxSteps=${options?.maxSteps || 100}`);
      console.log(`[AgentService] ⏱️ Setup Timing:`);
      console.log(`  Ensure keys: ${timings.ensureKeys.toFixed(2)}ms`);
      console.log(`  Get session: ${timings.getSession.toFixed(2)}ms`);
      console.log(`  Save user msg: ${timings.saveUserMessage.toFixed(2)}ms`);
      console.log(`  Load history: ${timings.loadHistory.toFixed(2)}ms`);
      console.log(`  Load skills: ${timings.loadSkills.toFixed(2)}ms`);
      console.log(`  Build messages: ${timings.buildMessages.toFixed(2)}ms`);
      console.log(`  Get tools: ${timings.getTools.toFixed(2)}ms`);
      console.log(`  Total setup: ${(performance.now() - perfStart).toFixed(2)}ms`);
      
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
        ...(providerOptions.openai || providerOptions.google ? { providerOptions } : {}),
        // Truncate tool results mid-stream to prevent context overflow
        // Strategy: Adaptive truncation based on ACTUAL token usage from previous steps
        prepareStep: async (stepOptions: {
          messages: any[];
          stepNumber: number;
          steps: Array<{ usage?: { promptTokens?: number; completionTokens?: number } }>;
        }) => {
          // Use cumulative tokens tracked from onStepFinish
          // (stepOptions.steps doesn't have usage data until after the step completes)
          const totalPromptTokens = cumulativePromptTokens;
          
          console.log(
            `[prepareStep] Step ${stepOptions.stepNumber}: ${Math.round(totalPromptTokens / 1000)}K tokens used, ` +
            `${stepOptions.messages.length} messages in context`
          );
          
          // Determine context pressure level
          // NOTE: Most models have 128K-200K context windows
          // - GPT-5.2: ~128K tokens
          // - Claude Sonnet/Opus: ~200K tokens
          // - Gemini: ~1M tokens
          // We use conservative thresholds to leave room for output + safety margin
          const CONTEXT_PRESSURE_THRESHOLDS = {
            low: 30000,      // <30K tokens: generous limits
            medium: 60000,   // 30-60K: moderate limits
            high: 90000,     // 60-90K: aggressive limits
            critical: 120000 // >120K: abort (handled by onStepFinish)
          };
          
          let pressureLevel: 'low' | 'medium' | 'high';
          if (totalPromptTokens < CONTEXT_PRESSURE_THRESHOLDS.low) {
            pressureLevel = 'low';
          } else if (totalPromptTokens < CONTEXT_PRESSURE_THRESHOLDS.medium) {
            pressureLevel = 'medium';
          } else {
            pressureLevel = 'high';
          }
          
          console.log(`[prepareStep]   Pressure: ${pressureLevel}`);
          
          // Find all tool messages and their indices (to determine recency)
          const toolMessageIndices: number[] = [];
          stepOptions.messages.forEach((msg, idx) => {
            if (msg.role === 'tool') {
              toolMessageIndices.push(idx);
            }
          });
          
          const totalToolMessages = toolMessageIndices.length;
          console.log(`[prepareStep]   Tool messages found: ${totalToolMessages}`);
          
          // If no tool messages yet, don't modify anything
          if (totalToolMessages === 0) {
            return {};
          }
          
          // Adaptive truncation limits based on context pressure (1 token ≈ 4 chars)
          const getTruncationLimit = (toolMessagePosition: number): number | null => {
            const positionFromEnd = totalToolMessages - toolMessagePosition - 1;
            
            // Always keep last result unlimited
            if (positionFromEnd < 1) return null;
            
            // Adapt limits based on context pressure
            if (pressureLevel === 'low') {
              // Low pressure: generous limits (we have room)
              if (positionFromEnd < 3) return 12000;  // Next 2: 3000 tokens
              if (positionFromEnd < 6) return 6000;   // Next 3: 1500 tokens
              if (positionFromEnd < 11) return 3000;  // Next 5: 750 tokens
              return 1500;                            // Old: 375 tokens
            } else if (pressureLevel === 'medium') {
              // Medium pressure: moderate limits
              if (positionFromEnd < 3) return 8000;   // Next 2: 2000 tokens
              if (positionFromEnd < 6) return 4000;   // Next 3: 1000 tokens
              if (positionFromEnd < 11) return 2000;  // Next 5: 500 tokens
              return 1000;                            // Old: 250 tokens
            } else {
              // High pressure: aggressive limits (context nearly full)
              if (positionFromEnd < 3) return 4000;   // Next 2: 1000 tokens
              if (positionFromEnd < 6) return 2000;   // Next 3: 500 tokens
              if (positionFromEnd < 11) return 1000;  // Next 5: 250 tokens
              return 500;                             // Old: 125 tokens
            }
          };
          
          // Process messages to truncate tool results based on recency + context pressure
          const truncatedMessages = stepOptions.messages.map((msg, msgIdx) => {
            if (msg.role === 'tool' && Array.isArray(msg.content)) {
              const toolMessagePosition = toolMessageIndices.indexOf(msgIdx);
              const maxLength = getTruncationLimit(toolMessagePosition);
              
              return {
                ...msg,
                content: msg.content.map((part: any) => {
                  if (part.type === 'tool-result' && typeof part.result === 'string') {
                    const resultStr = part.result;
                    
                    // EMERGENCY: Catch absurdly large results (>50K tokens) regardless of recency
                    // 50K tokens ≈ 200KB chars - max for any single tool result
                    const EMERGENCY_LIMIT = 200000; // ~50K tokens
                    if (resultStr.length > EMERGENCY_LIMIT) {
                      const truncated = resultStr.substring(0, EMERGENCY_LIMIT);
                      const omitted = resultStr.length - EMERGENCY_LIMIT;
                      console.warn(
                        `[prepareStep] ⚠️ EMERGENCY truncation: tool result was ${Math.round(resultStr.length / 1024)}KB, ` +
                        `truncated to ${Math.round(EMERGENCY_LIMIT / 1024)}KB`
                      );
                      return {
                        ...part,
                        result: truncated +
                          `\n\n[⚠️ EMERGENCY TRUNCATION: Result was ${Math.round(resultStr.length / 1024)}KB (${Math.round(resultStr.length / 4000)}K tokens), ` +
                          `truncated ${omitted} chars. This is too large for context. ` +
                          `Use more specific search patterns or incremental reading.]`
                      };
                    }
                    
                    // Keep unlimited for most recent (unless emergency truncation applied above)
                    if (maxLength === null) {
                      return part;
                    }
                    
                    if (resultStr.length > maxLength) {
                      const truncated = resultStr.substring(0, maxLength);
                      const omitted = resultStr.length - maxLength;
                      const positionFromEnd = totalToolMessages - toolMessagePosition - 1;
                      const estimatedTokens = Math.ceil(maxLength / 4);
                      return {
                        ...part,
                        result: truncated +
                          `\n\n[... ${omitted} chars truncated (tool #${positionFromEnd + 1} from end, ` +
                          `limit: ~${estimatedTokens} tokens, context: ${Math.round(totalPromptTokens / 1000)}K/${pressureLevel})]`
                      };
                    }
                  }
                  return part;
                })
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
              'Available fields:', Object.keys(step)
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
      
      const result = await streamText(streamTextOptions);
      timings.streamTextInit = performance.now() - t;
      console.log(`  AI SDK init: ${timings.streamTextInit.toFixed(2)}ms`);

      const apiKeys = getApiKeysForSanitization();
      t = performance.now();
      const streamIterator = orchestrateModelStream(
        result.fullStream,
        chatId,
        apiKeys,
      );
      
      let firstChunkReceived = false;
      while (true) {
        const next = await streamIterator.next();
        
        if (!firstChunkReceived && !next.done) {
          timings.timeToFirstChunk = performance.now() - t;
          console.log(`[AgentService] ⚡ First chunk in ${timings.timeToFirstChunk.toFixed(2)}ms (type: ${next.value.type})`);
          console.log(`[AgentService] 🎯 Time from request start to first chunk: ${(performance.now() - perfStart).toFixed(2)}ms`);
          firstChunkReceived = true;
        }
        
        if (next.done) {
          assistantText = next.value.assistantText;
          thinkingText = next.value.thinkingText;
          toolCalls = next.value.toolCalls;
          toolResults = next.value.toolResults;
          sequence = next.value.sequence; // Get V1-style sequence
          
          // Log sequence for debugging
          console.log(`[AgentService] Sequence built: ${sequence.length} items`);
          sequence.forEach((item, i) => {
            console.log(`  ${i + 1}. ${item.type}: ${
              item.type === 'text' 
                ? `"${(item.data as string).substring(0, 50)}..."` 
                : item.type === 'tool'
                ? (item.data as any).name
                : 'thinking'
            }`);
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
              payload: { message: "Context limit reached. Compressing conversation history..." },
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
            });
            await this.storageManager.saveMessage(chatId, partialMsg);
            console.log(`✓ Saved partial response before retry`);
            
            // Now automatically retry with compressed context
            // The compressed summary will be loaded in the system prompt
            console.log(`🔄 Automatically retrying with compressed context...`);
            
            // Recursively call streamAgent to continue with compressed history
            // This will load the compressed summary and continue from where we left off
            for await (const chunk of this.streamAgent(chatId, userMessage, config, options)) {
              yield chunk;
            }
            
            // Return after the retry completes (don't save message again)
            return;
          }
          
          break;
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
      });
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
      const contextThresholdStr = CONTEXT_ABORT_THRESHOLD.toLocaleString();
      const errorMessage = contextPressureAborted
        ? `Context limit approaching (${contextThresholdStr} prompt tokens). Conversation summary generated — you can continue from where we left off.`
        : error instanceof Error ? error.message : 'Unknown error';
      
      const errorMsg: StoredMessage = createErrorStoredMessage({
        chatId,
        model: config.model,
        assistantText,
        thinkingText,
        toolCalls,
        toolResults,
        errorMessage,
      });
      
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
          console.log(`✓ Summary already fresh for ${chatId} (${Math.round(ageMs / 60000)}m old), skipping`);
          return;
        }
      }

      // --- Step 1: Provider-native compress (works for papr + hybrid modes) ---
      const providerSummary = await this.storageManager.fetchAndCacheSummary(chatId);
      if (providerSummary) {
        console.log(`✓ Summary from storage provider for ${chatId}: topics=[${providerSummary.topics?.join(', ')}]`);
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
            const summary: import('./storage/IStorageProvider.js').StoredSummary = {
              short_term: s.short_term ?? '',
              medium_term: s.medium_term ?? '',
              long_term: s.long_term ?? '',
              topics: s.topics ?? [],
              last_updated: s.last_updated ?? new Date().toISOString(),
              fetched_from_papr: true,
              last_fetched_at: new Date().toISOString(),
            };
            await this.storageManager.saveSummary(chatId, summary);
            console.log(`✓ Summary from Papr /compress for ${chatId}: topics=[${summary.topics.join(', ')}]`);
            return;
          }
        } catch (paprError) {
          console.warn(`[AgentService] Papr /compress failed, using local LLM fallback:`, paprError);
        }
      }

      // --- Step 3: Local LLM summarization fallback ---
      await this.generateAndSaveLocalSummary(chatId);

    } catch (error) {
      console.error(`[AgentService] Summarization failed for ${chatId}:`, error);
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
      console.log(`[AgentService] Too few messages (${messages.length}) for local summary`);
      return;
    }

    // Build plain-text representation — strip tool call JSON, keep text only
    const conversationText = messages
      .map((m) => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        return `${role}: ${m.content || '(no text)'}`;
      })
      .join('\n\n');

    // Cap input — 50K chars ≈ 12K tokens, enough for a quality summary
    const MAX_INPUT_CHARS = 50_000;
    const last15 = messages.slice(-15).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content || '(no text)'}`).join('\n\n');
    const last100 = messages.slice(-100).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content || '(no text)'}`).join('\n\n');
    const fullText = conversationText.length > MAX_INPUT_CHARS
      ? conversationText.substring(conversationText.length - MAX_INPUT_CHARS)
      : conversationText;

    // Select cheapest available model
    const { getApiKeys } = await import("../utils/keyResolver.js");
    const providerKeys = await getApiKeys(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']);

    let model: import('ai').LanguageModel | null = null;
    let selectedProvider = '';
    if (providerKeys.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = providerKeys.OPENAI_API_KEY;
      const { openai } = await import("@ai-sdk/openai");
      model = openai('gpt-4o-mini') as import('ai').LanguageModel;
      selectedProvider = 'openai/gpt-4o-mini';
    } else if (providerKeys.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = providerKeys.ANTHROPIC_API_KEY;
      const { anthropic } = await import("@ai-sdk/anthropic");
      model = anthropic('claude-haiku-4-5') as import('ai').LanguageModel;
      selectedProvider = 'anthropic/claude-haiku-4-5';
    } else if (providerKeys.GOOGLE_API_KEY) {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = providerKeys.GOOGLE_API_KEY;
      const { google } = await import("@ai-sdk/google");
      model = google('gemini-2-0-flash') as import('ai').LanguageModel;
      selectedProvider = 'google/gemini-2-0-flash';
    }

    if (!model) {
      console.warn(`[AgentService] No API key available for local summarization`);
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

    let rawText = '';
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
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();
      parsed = JSON.parse(cleaned) as SummaryJson;
    } catch {
      console.error(`[AgentService] Failed to parse local summary JSON:`, rawText.substring(0, 200));
      return;
    }

    if (!parsed || typeof parsed.long_term !== 'string' || !parsed.long_term) {
      console.error(`[AgentService] Parsed summary missing long_term field`);
      return;
    }

    const topics = Array.isArray(parsed.topics)
      ? (parsed.topics as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];

    const summary: import('./storage/IStorageProvider.js').StoredSummary = {
      short_term: typeof parsed.short_term === 'string' ? parsed.short_term : '',
      medium_term: typeof parsed.medium_term === 'string' ? parsed.medium_term : '',
      long_term: parsed.long_term,
      topics,
      last_updated: new Date().toISOString(),
      fetched_from_papr: false,
      last_fetched_at: new Date().toISOString(),
    };

    await this.storageManager.saveSummary(chatId, summary);
    console.log(`✓ Local summary saved for ${chatId} (${summary.long_term.length} chars, topics=[${topics.join(', ')}])`);
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
   * Check if two configs use the same provider (for API key reuse)
   */
  isSameProvider(config1: AgentConfigInternal, config2: Partial<AgentConfigInternal>): boolean {
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

  async runIsolatedJobSession(input: {
    jobId: string;
    runId: string;
    prompt: string;
    provider?: Provider;
    model?: string;
    allowedToolIds?: string[];
    maxTurns?: number;
  }): Promise<{ chatId: string; text: string }> {
    if (!this.initialized) {
      throw new Error("AgentService not initialized");
    }

    await this.ensureKeysLoaded();

    const provider = input.provider ?? "openai";
    const defaultModelByProvider: Record<Provider, string> = {
      openai: "gpt-5-mini",
      anthropic: "claude-sonnet-4-5",
      google: "gemini-2-5-flash",
    };
    const model = input.model ?? defaultModelByProvider[provider];
    const keyNameByProvider: Record<Provider, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      google: "GOOGLE_API_KEY",
    };
    const keyName = keyNameByProvider[provider];
    const { getApiKeys } = await import("../utils/keyResolver.js");
    const keys = await getApiKeys([keyName]);
    const apiKey = keys[keyName];
    if (!apiKey) {
      throw new Error(`Missing API key for job agent run: ${keyName}`);
    }

    const chatId = `job:${input.jobId}:${input.runId}`;
    const config: AgentConfigInternal = {
      provider,
      model,
      apiKey,
      systemPrompt: `${this.systemPrompt}\n\n# Isolated Job Run\n- Session: ${chatId}\n- Keep output concise and actionable.`,
    };

    let text = "";
    for await (const chunk of this.streamAgent(chatId, input.prompt, config, {
      allowedToolIds: input.allowedToolIds,
      maxSteps: input.maxTurns,
    })) {
      if (chunk.type !== "text-delta") {
        continue;
      }
      const payload = chunk.payload as TextDeltaPayload;
      if (typeof payload.text === "string") {
        text += payload.text;
      }
    }

    return { chatId, text: text.trim() };
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

    const provider = input.provider ?? "openai";
    const defaultModelByProvider: Record<Provider, string> = {
      openai: "gpt-5-mini",
      anthropic: "claude-sonnet-4-5",
      google: "gemini-2-5-flash",
    };
    const modelId = input.model ?? defaultModelByProvider[provider];

    // Resolve API key
    const keyNameByProvider: Record<Provider, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      google: "GOOGLE_API_KEY",
    };
    const keyName = keyNameByProvider[provider];
    const { getApiKeys } = await import("../utils/keyResolver.js");
    const keys = await getApiKeys([keyName]);
    const apiKey = keys[keyName];
    if (!apiKey) {
      throw new Error(`Missing API key for structured job run: ${keyName}`);
    }

    // Set API key in environment for AI SDK provider
    this.setProviderApiKey(provider, apiKey);

    // Create the AI SDK model instance
    const model = await this.createLanguageModel(provider, modelId);

    const chatId = `job:${input.jobId}:${input.runId}`;

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

  /**
   * Set provider API key or OAuth token in environment so AI SDK providers can pick it up.
   * Prioritizes OAuth tokens over API keys.
   */
  private async setProviderAuth(provider: Provider, apiKey?: string): Promise<void> {
    // First, try to use OAuth token (if available)
    const { getProviderAuth } = await import("../utils/keyResolver.js");

    if (provider === "openai" || provider === "anthropic") {
      const auth = await getProviderAuth(provider);
      
      if (auth) {
        if (auth.type === "oauth") {
          // Set OAuth token as API key (AI SDK uses OPENAI_API_KEY/ANTHROPIC_API_KEY env vars)
          switch (provider) {
            case "openai":
              process.env.OPENAI_API_KEY = auth.token;
              console.log(`[AgentService] Using OpenAI OAuth token`);
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
              process.env.OPENAI_API_KEY = auth.key;
              console.log(`[AgentService] Using OpenAI API key`);
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
          process.env.OPENAI_API_KEY = apiKey;
          break;
        case "google":
          process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
          break;
      }
    }
  }

  /**
   * Set provider API key in environment so AI SDK providers can pick it up.
   * Legacy method - now redirects to setProviderAuth
   */
  private setProviderApiKey(provider: Provider, apiKey: string): void {
    // Call async method without await (for backward compatibility)
    this.setProviderAuth(provider, apiKey);
  }

  /**
   * Create an AI SDK LanguageModel instance for the given provider and model ID.
   * Centralises model creation logic shared by streamAgent and generateObject paths.
   */
  private async createLanguageModel(provider: Provider, modelId: string): Promise<LanguageModel> {
    switch (provider) {
      case "anthropic": {
        const { anthropic } = await import("@ai-sdk/anthropic");
        return anthropic(modelId) as LanguageModel;
      }
      case "openai": {
        const { openai } = await import("@ai-sdk/openai");
        let normalizedModel = modelId;
        if (modelId.startsWith("gpt-5-2-")) {
          normalizedModel = "gpt-5-2";
        }
        if (normalizedModel.startsWith("gpt-5")) {
          return openai.responses(normalizedModel) as LanguageModel;
        }
        return openai(normalizedModel) as LanguageModel;
      }
      case "google": {
        const { google } = await import("@ai-sdk/google");
        return google(modelId) as LanguageModel;
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
    const includeExtendedAppPlaybook =
      this.hasAppAutomationContext(history);

    // Load active plans for this chat
    let activePlans: Array<{
      planId: string;
      title: string;
      steps: Array<{ id: string; description: string; status: string }>;
      createdAt: string;
    }> | undefined;

    try {
      const { getPlanService } = await import("./PlanService.js");
      const planService = getPlanService();
      await planService.initialize();
      const plans = await planService.getActivePlansForChat(chatId);
      
      if (plans.length > 0) {
        activePlans = plans.map(plan => ({
          planId: plan.planId,
          title: plan.title,
          steps: plan.steps,
          createdAt: plan.createdAt,
        }));
      }
    } catch (error) {
      console.warn('[AgentService] Failed to load active plans:', error);
      // Continue without plans context
    }

    // Load workspace context (persistent memory, identity, daily logs)
    let workspaceContext: WorkspaceContextData | undefined;
    try {
      const workspaceService = getWorkspaceService();
      const ctx = await workspaceService.loadWorkspaceContext();
      // Only inject if there's meaningful content
      if (ctx.files.length > 0 || ctx.dailyLogs.length > 0 || ctx.onboardingPending) {
        workspaceContext = ctx;
      }
    } catch (error) {
      console.warn('[AgentService] Failed to load workspace context:', error);
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
        
        if (appKeywords.some(keyword => content.includes(keyword))) {
          return true;
        }
      }
    }

    return false;
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

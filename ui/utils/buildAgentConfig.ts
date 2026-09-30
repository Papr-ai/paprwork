/**
 * One place that turns "model + the user's choices" into the config a turn runs on.
 *
 * `ChatContainer` built this object inline at three separate call sites (send,
 * auto-continue, stream recovery). Three copies of a shape that decides what a
 * request costs is how a control ends up applying on send but not on retry, so
 * the shape lives here now and the call sites pass their differences in.
 *
 * Precedence is: the chat's explicit choice, then the model's own default, then
 * nothing — a field the user never touched is left off the request entirely so
 * the provider applies its own default rather than one we invented.
 */

import type { AIModel } from "../constants/models";
import {
  DEFAULT_CONTEXT_LIMIT,
  contextOptionsForModel,
  effortLevelsForModel,
  modelSupportsEffort,
  modelSupportsFast,
  modelSupportsThinkingToggle,
  type EffortLevel,
} from "../constants/modelControls";
import type { ChatModelSettings } from "./chatModelSettings";
import { AUTO_MODEL_ID } from "../constants/modelPicker";
import type { AuthStatus } from "../hooks/useAuthStatus";

export interface ResolvedModelSettings {
  thinking: boolean;
  effort?: EffortLevel;
  contextLimit: number;
  fast: boolean;
}

export interface BuildAgentConfigInput {
  model: AIModel;
  settings: ChatModelSettings;
  systemPrompt: string;
  /** Fast mode is API-key only; pi-ai has no `speed` parameter. */
  authType?: "oauth" | "apiKey";
  /** Needed when model is Auto: picks the provider ladder to route within. */
  authStatus?: AuthStatus;
  /** Auto only: the next default the user can reach, if Jev cannot decide. */
  autoFallbackModelId?: string;
}

export interface BuiltAgentConfig {
  provider: AIModel["provider"];
  model: string;
  systemPrompt: string;
  reasoning?: { effort: EffortLevel };
  thinkingBudget?: number;
  maxTokens?: number;
  contextLimit: number;
  /** Only ever `false`, and only when the user turned reasoning off. */
  thinking?: false;
  speed?: "fast";
  /** Auto only: next default model to run if the router cannot decide. */
  autoFallbackModelId?: string;
}

/**
 * Effective settings for a model, after dropping anything it cannot honour.
 *
 * A stored value is kept only while it remains valid: switching a chat from a
 * 1M-window model to a 131K one must not keep sending a 1M budget, and a `max`
 * effort saved under GLM must not survive a move to a provider that tops out
 * at `high`.
 */
export function resolveModelSettings(
  model: AIModel,
  settings: ChatModelSettings,
): ResolvedModelSettings {
  const allowedEfforts = effortLevelsForModel(model);
  const requestedEffort = settings.effort;
  const modelDefaultEffort = model.reasoning?.effort;

  let effort: EffortLevel | undefined;
  if (modelSupportsEffort(model)) {
    effort =
      requestedEffort && allowedEfforts.includes(requestedEffort)
        ? requestedEffort
        : modelDefaultEffort;
  }

  const contextOptions = contextOptionsForModel(model);
  const requestedContext = settings.contextLimit;
  const contextLimit =
    requestedContext && contextOptions.includes(requestedContext)
      ? requestedContext
      : // Default to the narrowest offered choice. Every token inside the
        // budget is re-sent on each step of a turn, so starting wide is what
        // quietly runs up a bill.
        Math.min(...contextOptions, DEFAULT_CONTEXT_LIMIT);

  return {
    thinking: modelSupportsThinkingToggle(model)
      ? (settings.thinking ?? true)
      : true,
    effort,
    contextLimit,
    fast: settings.fast === true,
  };
}

/**
 * Provider Auto should route within. Best reachable in ladder order; the
 * catalog entry says Anthropic but a Google-only user must not be sent there.
 */
export function resolveAutoProvider(
  status: AuthStatus | undefined,
): AIModel["provider"] {
  if (!status) return "anthropic";
  if (status.anthropic.oauth || status.anthropic.apiKey) return "anthropic";
  if (status.openai.oauth || status.openai.apiKey) return "openai";
  if (status.google.apiKey) return "google";
  return "anthropic"; // Papr Cloud proxy carries Anthropic models
}

export function buildAgentConfig(
  input: BuildAgentConfigInput,
): BuiltAgentConfig {
  const { model, settings, systemPrompt, authType } = input;
  const resolved = resolveModelSettings(model, settings);

  const config: BuiltAgentConfig = {
    provider:
      model.id === AUTO_MODEL_ID
        ? resolveAutoProvider(input.authStatus)
        : model.provider,
    model: model.id,
    systemPrompt,
    maxTokens: model.maxTokens,
    contextLimit: resolved.contextLimit,
  };

  if (resolved.effort) {
    config.reasoning = { effort: resolved.effort };
  }

  if (model.id === AUTO_MODEL_ID && input.autoFallbackModelId) {
    config.autoFallbackModelId = input.autoFallbackModelId;
  }

  // `thinkingBudget: 0` cannot mean "off": Opus 5 and Fable 5.1 ship a default
  // budget of 0 and still think adaptively. So the off state is its own flag,
  // and it is sent only when the user actually set it.
  if (resolved.thinking) {
    config.thinkingBudget = model.defaultThinkingBudget;
  } else {
    config.thinking = false;
    config.thinkingBudget = 0;
  }

  if (resolved.fast && modelSupportsFast(model, authType)) {
    config.speed = "fast";
  }

  return config;
}

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
import { AUTO_MODEL_ID } from "../constants/modelPicker";
import {
  DEFAULT_CONTEXT_LIMIT,
  contextOptionsForModel,
  effortLevelsForModel,
  modelSupportsEffort,
  modelSupportsFast,
  modelSupportsThinkingToggle,
  type EffortLevel,
} from "../constants/modelControls";
import type { AuthStatus } from "../hooks/useAuthStatus";
import type { ChatModelSettings } from "./chatModelSettings";
import { getModelById } from "../constants/models";
import { resolveAutoModelPlan } from "./autoModelPlan";

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
  /** Auto only: models pinned in the picker. Auto routes only within these. */
  enabledModelIds?: Iterable<string>;
  /** Auto only: whether the user's auth can reach a model. */
  isModelAvailable?: (model: AIModel) => boolean;
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
  /** Auto only: enabled + reachable models the router may pick from. */
  autoAllowedModels?: string[];
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
    if (requestedEffort && allowedEfforts.includes(requestedEffort)) {
      effort = requestedEffort;
    } else if (
      modelDefaultEffort &&
      allowedEfforts.includes(modelDefaultEffort)
    ) {
      effort = modelDefaultEffort;
    } else {
      // Adaptive Claude models ship without a packaged default effort id; the
      // gateway runs them at medium when unset — match that so Effort is visible.
      effort = allowedEfforts.includes("medium") ? "medium" : allowedEfforts[0];
    }
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
 * Kept for callers that only have auth; buildAgentConfig uses the full plan,
 * which also accounts for the models the user has enabled.
 */
export function resolveAutoProvider(
  status: AuthStatus | undefined,
): AIModel["provider"] {
  return resolveAutoModelPlan({ status }).provider;
}

export function buildAgentConfig(
  input: BuildAgentConfigInput,
): BuiltAgentConfig {
  const { model, settings, systemPrompt, authType } = input;
  const resolved = resolveModelSettings(model, settings);

  const isAuto = model.id === AUTO_MODEL_ID;
  const autoPlan = isAuto
    ? resolveAutoModelPlan({
        status: input.authStatus,
        enabledModelIds: input.enabledModelIds,
        isModelAvailable: input.isModelAvailable,
        getModel: getModelById,
      })
    : undefined;

  const config: BuiltAgentConfig = {
    provider: autoPlan ? autoPlan.provider : model.provider,
    model: model.id,
    systemPrompt,
    maxTokens: model.maxTokens,
    contextLimit: resolved.contextLimit,
  };

  if (resolved.effort) {
    config.reasoning = { effort: resolved.effort };
  }

  if (autoPlan?.allowedModels?.length) {
    config.autoAllowedModels = autoPlan.allowedModels;
  }

  // The fallback must live on the provider Auto resolved credentials for —
  // a Claude fallback on an OpenAI-auth turn is exactly the failure to avoid.
  if (isAuto && input.autoFallbackModelId) {
    const fallback = getModelById(input.autoFallbackModelId);
    const sameProvider =
      fallback &&
      (fallback.provider === config.provider ||
        (config.provider === "openai" && fallback.provider === "openai-codex"));
    if (sameProvider) config.autoFallbackModelId = input.autoFallbackModelId;
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

import type { AIModel } from "../constants/models";
import { isPaprProxyOnlyModel } from "../../src/core/constants/paprCloudFeatures";
import { checkPaprCloudFeature } from "../stores/paprCloudFeatureStore";

/** One-line copy when the selected model cannot run with current auth. */
export function getUnavailableModelMessage(model: AIModel): string {
  if (isPaprProxyOnlyModel(model.provider)) {
    const access = checkPaprCloudFeature("papr_ai_proxy");
    if (access?.lockReason === "subscription_required") {
      return "Papr Cloud subscription required.";
    }
    if (access?.lockReason === "memory_paused") {
      return "Papr Cloud paused — fix plan in Settings.";
    }
    return "Sign in to Papr to use this model.";
  }

  if (model.provider === "anthropic") {
    return "This model needs Claude OAuth or an API key.";
  }
  if (model.id === "gpt-5.3-codex") {
    return "This model needs an OpenAI API key.";
  }
  if (model.provider === "openai-codex" || model.provider === "openai") {
    return "This model needs ChatGPT OAuth or an OpenAI API key.";
  }
  if (model.provider === "google") {
    const access = checkPaprCloudFeature("papr_ai_proxy");
    if (access?.lockReason === "subscription_required") {
      return "Papr Cloud subscription required (or add a Google API key).";
    }
    if (access?.lockReason === "memory_paused") {
      return "Papr Cloud paused — fix plan in Settings.";
    }
    return "Add a Google API key or fix Papr Cloud billing in Settings.";
  }
  if (model.provider === "ollama") {
    return "This local model is not installed yet.";
  }
  return "This model is not available with your current setup.";
}

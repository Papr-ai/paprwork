/**
 * Turns a provider failure into something a person can act on.
 *
 * The strings we get from Anthropic, OpenAI and the gateway are written for
 * whoever is reading a log: they name a status code, quote a policy, and list
 * every possible remedy in one paragraph. Shown verbatim in the chat they were
 * a wall of red that buried the one sentence that mattered.
 *
 * So this module splits every failure into three fixed slots — a glanceable
 * headline, one sentence of what to do, and the provider's own words kept
 * intact behind a disclosure. Nothing is classified here that was not already
 * classified upstream; the same substrings useAgent matches on are matched
 * again, only to decide how the same message should *read*.
 */

import { isProviderAuthRejection } from "./providerAuthRejection";
import type { Provider } from "../../src/core/types/agents";

export type ProviderNoticeTone = "warning" | "error";

/**
 * One action per notice, never two. A spent allowance and a refused key are
 * fixed in different places, and offering both choices at once is how the old
 * banner made every failure look equally ambiguous.
 */
export type ProviderNoticeAction = "resume" | "settings" | "none";

export interface ProviderNotice {
  /** Stable id so the chip can tell "same failure" from "new failure". */
  kind: string;
  /** Amber for anything time or traffic related, red for account problems. */
  tone: ProviderNoticeTone;
  /** Two to four words, read at a glance without opening anything. */
  headline: string;
  /** One sentence. What happened, then what to do about it. */
  guidance: string;
  action: ProviderNoticeAction;
  /** The provider's verbatim text, preserved for the details disclosure. */
  detail: string;
}

/** What users call these companies, rather than what our config calls them. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  "openai-codex": "ChatGPT",
  google: "Gemini",
  ollama: "Ollama",
};

function providerLabel(provider?: Provider | string | null): string {
  if (!provider) return "The AI provider";
  return PROVIDER_LABELS[provider] ?? "The AI provider";
}

/**
 * Providers state when an allowance comes back, and that is the only fact a
 * user needs to plan around a limit, so it is lifted into the sentence instead
 * of being left inside the paragraph nobody reads.
 */
function resetHint(raw: string): string | null {
  // The preposition is captured rather than skipped: "resets in 4 hours" and
  // "resets at 3:00 PM" are both normal provider phrasings, and dropping the
  // word leaves our own sentence ungrammatical.
  const match = raw.match(/resets?\s+(at|on|in)?\s*([^.;\n)]{3,40})/i);
  if (!match) return null;
  const value = match[2].trim().replace(/[,\s]+$/, "");
  if (!value) return null;
  const preposition = (match[1] ?? "at").toLowerCase();
  return `${preposition} ${value}`;
}

export interface DescribeProviderNoticeInput {
  /** Message as composed upstream (gateway rewrite or raw provider body). */
  message: string;
  /** True when the turn never started and a retry is meaningful. */
  canResume?: boolean;
  provider?: Provider | string | null;
  /** Display name of the selected model, e.g. "Claude Sonnet 4.6". */
  modelName?: string;
}

export function describeProviderNotice(
  input: DescribeProviderNoticeInput,
): ProviderNotice {
  const raw = (input.message || "").trim();
  const who = providerLabel(input.provider);
  const detail = raw;
  const resume: ProviderNoticeAction = input.canResume ? "resume" : "none";

  // A spent allowance first: it shares status codes with rate limiting and
  // with auth failure, and is the one case where waiting or re-keying cannot
  // help, so it must never fall through to either of those sentences.
  if (
    /spend limit|usage limit|quota|plan limit|retrying won't help/i.test(raw)
  ) {
    const reset = resetHint(raw);
    return {
      kind: "usage-limit",
      tone: "warning",
      headline: "Usage limit reached",
      guidance: reset
        ? `You've used your ${who} allowance. It resets ${reset} — until then, switch to another model to keep working.`
        : `You've used your ${who} allowance for now. Switch to another model to keep working, or wait for the limit to reset.`,
      action: "settings",
      detail,
    };
  }

  if (/credit balance|billing|payment required|\(402\)/i.test(raw)) {
    return {
      kind: "credits",
      tone: "error",
      headline: "Out of credits",
      guidance: `Your ${who} account has no credits left. Add credits to that account, or switch to another model.`,
      action: "settings",
      detail,
    };
  }

  if (isProviderAuthRejection(raw)) {
    return {
      kind: "auth",
      tone: "error",
      headline: "Sign-in was refused",
      guidance: `${who} rejected your key or login. Reconnect the account in Settings → AI Models.`,
      action: "settings",
      detail,
    };
  }

  if (/rate limit|rate_limit|rate limited|\(429\)|too many requests/i.test(raw)) {
    return {
      kind: "rate-limit",
      tone: "warning",
      headline: "Too many requests",
      guidance: input.canResume
        ? `${who} is limiting how fast requests come in. Wait a few seconds, then resume.`
        : `${who} is limiting how fast requests come in. Wait a few seconds and send again, or switch models.`,
      action: resume,
      detail,
    };
  }

  if (
    /overloaded|temporarily overloaded|internal server error|api_error|server error|\(5\d\d\)/i.test(
      raw,
    )
  ) {
    return {
      kind: "provider-busy",
      tone: "warning",
      headline: `${who} is busy`,
      guidance: `Their servers are overloaded — nothing is wrong with your setup or connection. Try again in a moment, or switch models.`,
      action: resume,
      detail,
    };
  }

  if (/no output generated|empty response/i.test(raw)) {
    return {
      kind: "empty-response",
      tone: "warning",
      headline: "No reply came back",
      guidance: `${who} returned an empty response. Try again, or pick a different model in the composer.`,
      action: resume,
      detail,
    };
  }

  if (
    /context length|too long|maximum context|prompt is too large|token limit/i.test(
      raw,
    )
  ) {
    return {
      kind: "context-length",
      tone: "warning",
      headline: "Conversation too long",
      guidance:
        "This chat no longer fits in the model's context. Start a new chat to carry on, or switch to a model with a larger window.",
      action: "none",
      detail,
    };
  }

  if (/stream|connection|disconnect|aborted|timed out|timeout/i.test(raw)) {
    return {
      kind: "interrupted",
      tone: "warning",
      headline: "Reply was interrupted",
      guidance: input.canResume
        ? "The connection dropped part-way through. Resume to pick up where it stopped."
        : "The connection dropped part-way through. Send your message again to retry.",
      action: resume,
      detail,
    };
  }

  return {
    kind: "unknown",
    tone: "error",
    headline: "Something went wrong",
    guidance: input.modelName
      ? `${input.modelName} couldn't finish this turn. Try again, or switch models. Open details for the provider's message.`
      : "That turn couldn't be finished. Try again, or open details for the provider's message.",
    action: resume,
    detail,
  };
}

/**
 * Connection recovery with no provider text of its own. Kept separate so the
 * generic "Resume" case does not have to be guessed from an empty string.
 */
export function connectionRecoveryNotice(): ProviderNotice {
  return {
    kind: "reconnected",
    tone: "warning",
    headline: "Reply may be incomplete",
    guidance:
      "The connection came back after dropping mid-reply. Resume to finish the response.",
    action: "resume",
    detail: "",
  };
}

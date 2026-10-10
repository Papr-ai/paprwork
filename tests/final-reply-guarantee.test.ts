import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the network call is faked: each test hands the real wrap-up runner and
// the real stream orchestrator the exact stream shape a provider produced.
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: vi.fn() };
});

import { streamText } from "ai";
import {
  buildNoReplyFallback,
  classifyNoReply,
  needsFinalReplyFallback,
  runWrapUpWithRetry,
  shortErrorForUser,
  summarizeToolNames,
  textFirstProviderOptions,
  withTextFirstStreamTextOptions,
  WRAP_UP_TEXT_FIRST_RETRY,
  type NoReplyReason,
  type WrapUpOutcome,
} from "../src/gateway/services/agent/finalReplyGuarantee.js";
import {
  runAiSdkWrapUpContinuation,
  runPiAiWrapUpContinuation,
} from "../src/gateway/services/agent/wrapUpContinuation.js";

type Part = Record<string, unknown>;

async function* fromList<T>(list: T[]): AsyncGenerator<T> {
  for (const item of list) yield item;
}

function fakeStream(list: Part[]): ReturnType<typeof streamText> {
  return { fullStream: fromList(list) } as unknown as ReturnType<typeof streamText>;
}

async function drain<Y, R>(
  gen: AsyncGenerator<Y, R, undefined>,
): Promise<{ chunks: Y[]; result: R }> {
  const chunks: Y[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) return { chunks, result: next.value };
    chunks.push(next.value);
  }
}

const TEXT_REPLY: Part[] = [
  { type: "text-delta", id: "t", text: "Here is what I found: the job finished cleanly." },
  { type: "finish-step", finishReason: "stop" },
  { type: "finish", finishReason: "stop" },
];

/** How each provider ends a step with reasoning on and no visible text. */
const NO_TEXT: Record<string, Part[]> = {
  anthropicThinkingOnly: [
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", text: "Let me weigh what to report about the GPUs..." },
    { type: "reasoning-end", id: "r" },
    { type: "finish-step", finishReason: "length" },
    { type: "finish", finishReason: "length" },
  ],
  openaiEmptyStop: [
    { type: "finish-step", finishReason: "stop" },
    { type: "finish", finishReason: "stop" },
  ],
  geminiEmptyParts: [
    { type: "reasoning-delta", id: "g", text: "**Summarizing the results**" },
    { type: "text-delta", id: "g2", text: "" },
    { type: "finish", finishReason: "stop" },
  ],
  ollamaThinkLength: [
    { type: "reasoning-delta", id: "o", text: "Okay, the user wants" },
    { type: "finish", finishReason: "length" },
  ],
};

const TOOL_ONLY_TURN = [
  { type: "text", data: "Checking the box first." },
  { type: "tool", data: { name: "bash", status: "success" } },
];

describe("needsFinalReplyFallback", () => {
  const base = {
    sequence: TOOL_ONLY_TURN,
    assistantText: "Checking the box first.",
    toolCallCount: 1,
    aborted: false,
    isWrapUpContinuation: false,
    providerStreamFailed: false,
  };

  it("fires when tools ran and no text followed them (preamble only)", () => {
    expect(needsFinalReplyFallback(base)).toBe(true);
  });

  it("fires when the model only reasoned — no tools, no text", () => {
    expect(
      needsFinalReplyFallback({ ...base, sequence: [], assistantText: "", toolCallCount: 0 }),
    ).toBe(true);
  });

  it("fires when tool calls exist but the sequence lost them and there is no text", () => {
    expect(needsFinalReplyFallback({ ...base, sequence: [], assistantText: "" })).toBe(true);
  });

  it("stays out of a turn that answered after its tools", () => {
    expect(
      needsFinalReplyFallback({
        ...base,
        sequence: [...TOOL_ONLY_TURN, { type: "text", data: "All done — summary below." }],
      }),
    ).toBe(false);
  });

  it("stays out of a plain text answer", () => {
    expect(
      needsFinalReplyFallback({
        ...base,
        sequence: [{ type: "text", data: "Yes." }],
        assistantText: "Yes.",
        toolCallCount: 0,
      }),
    ).toBe(false);
  });

  it.each([
    ["the user pressed Stop", { aborted: true }],
    ["the transport failed (auto-continue owns it)", { providerStreamFailed: true }],
    ["it is an internal wrap-up continuation", { isWrapUpContinuation: true }],
  ])("stays out when %s", (_label, override) => {
    expect(needsFinalReplyFallback({ ...base, ...override })).toBe(false);
  });

  it("stays out when tools were interrupted (the Interrupted state owns it)", () => {
    expect(
      needsFinalReplyFallback({
        ...base,
        sequence: [{ type: "tool", data: { name: "bash", status: "interrupted" } }],
      }),
    ).toBe(false);
  });
});

describe("classifyNoReply", () => {
  const empty: WrapUpOutcome = { kind: "empty", attempts: 2 };
  it("a pending follow-up wins over everything else", () => {
    expect(
      classifyNoReply({ yieldedToUser: true, wrapUp: empty, toolCallCount: 3, thinkingText: "x" }),
    ).toBe("yielded_to_user");
  });
  it("reports the wrap-up's error, then its emptiness", () => {
    expect(
      classifyNoReply({
        yieldedToUser: false,
        wrapUp: { kind: "error", attempts: 2, message: "boom" },
        toolCallCount: 1,
        thinkingText: "",
      }),
    ).toBe("wrap_up_error");
    expect(
      classifyNoReply({ yieldedToUser: false, wrapUp: empty, toolCallCount: 1, thinkingText: "" }),
    ).toBe("wrap_up_empty");
  });
  it("separates a truly empty response from a reasoning-only one", () => {
    const none: WrapUpOutcome = { kind: "not_attempted" };
    expect(
      classifyNoReply({ yieldedToUser: false, wrapUp: none, toolCallCount: 0, thinkingText: "" }),
    ).toBe("empty_response");
    expect(
      classifyNoReply({ yieldedToUser: false, wrapUp: none, toolCallCount: 0, thinkingText: "hmm" }),
    ).toBe("no_text");
  });
});

describe("buildNoReplyFallback", () => {
  const reasons: NoReplyReason[] = [
    "yielded_to_user",
    "wrap_up_error",
    "wrap_up_empty",
    "empty_response",
    "no_text",
  ];

  it.each(reasons)("is never empty (%s)", (reason) => {
    const note = buildNoReplyFallback({ reason, toolNames: ["bash"], errorMessage: "x" });
    expect(note.trim().length).toBeGreaterThan(20);
  });

  it("says what ran and how to continue", () => {
    const note = buildNoReplyFallback({
      reason: "wrap_up_empty",
      toolNames: ["bash", "bash", "get_full_tool_result"],
      pendingPlanSteps: 2,
    });
    expect(note).toContain("Ran 3 tool calls (bash ×2, get_full_tool_result)");
    expect(note).toContain("2 plan steps are still open");
    expect(note).toContain('Say "continue"');
  });

  it("carries the wrap-up error, with credentials redacted", () => {
    const note = buildNoReplyFallback({
      reason: "wrap_up_error",
      toolNames: ["bash"],
      errorMessage: "401 invalid x-api-key sk-ant-api03-abcdefghijklmnop\nstack…",
    });
    expect(note).toContain("writing the reply failed (401 invalid x-api-key [redacted])");
    expect(note).not.toContain("sk-ant");
  });

  it("keeps the pause note short", () => {
    expect(buildNoReplyFallback({ reason: "yielded_to_user", toolNames: ["bash"] })).toBe(
      "_Paused after this step to read your new message._",
    );
  });
});

describe("shortErrorForUser / summarizeToolNames", () => {
  it("redacts Google keys and long tokens, bounds length", () => {
    const out = shortErrorForUser(`bad key AIzaSyA1234567890abcdefghijklmn ${"z".repeat(300)}`);
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("AIza");
    expect(out.length).toBeLessThanOrEqual(160);
  });
  it("lists at most four tool names", () => {
    expect(summarizeToolNames(["a", "b", "c", "d", "e", "f"])).toBe("a, b, c, d, 2 more");
  });
});

describe("textFirstProviderOptions", () => {
  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      for (const inner of Object.values(value)) deepFreeze(inner);
      Object.freeze(value);
    }
    return value;
  };

  it("Opus 5.5 / Fable keep adaptive thinking (they reject disable) at low effort", () => {
    for (const model of ["claude-opus-5-5", "claude-fable-5-1"]) {
      const input = deepFreeze({
        anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "max" },
      });
      expect(textFirstProviderOptions(model, input)?.anthropic).toEqual({
        thinking: { type: "adaptive", display: "summarized" },
        effort: "low",
      });
    }
  });

  it("Sonnet 5.5 goes to low effort too — `disabled` never reaches the API and it reasons by default", () => {
    const input = deepFreeze({
      anthropic: { thinking: { type: "disabled" }, speed: "fast" },
    });
    expect(textFirstProviderOptions("claude-sonnet-5-5", input)?.anthropic).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      effort: "low",
      speed: "fast",
    });
  });

  it("budget-thinking models (Sonnet 4.6, Haiku 4.5) drop thinking — they only reason when asked", () => {
    const input = deepFreeze({ anthropic: { thinking: { type: "enabled", budgetTokens: 8000 } } });
    expect(textFirstProviderOptions("claude-sonnet-4-6", input)?.anthropic).toEqual({});
  });

  it("raises a tight output budget to the text-first floor, never lowers a large one", () => {
    expect(withTextFirstStreamTextOptions({ maxOutputTokens: 256 }, "m").maxOutputTokens).toBe(4096);
    expect(withTextFirstStreamTextOptions({ maxOutputTokens: 32000 }, "m").maxOutputTokens).toBe(32000);
    expect(withTextFirstStreamTextOptions({ temperature: 0 }, "m")).toEqual({ temperature: 0 });
  });

  it("OpenAI drops to low effort, Gemini caps and hides thoughts, Ollama stops thinking", () => {
    const input = deepFreeze({
      openai: { reasoningEffort: "xhigh", reasoningSummary: "detailed" },
      google: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16384 } },
      ollama: { think: true, options: { num_ctx: 16384 } },
    });
    const out = textFirstProviderOptions("any", input);
    expect(out?.openai).toEqual({ reasoningEffort: "low", reasoningSummary: "detailed" });
    expect(out?.google).toEqual({ thinkingConfig: { includeThoughts: false, thinkingBudget: 1024 } });
    expect(out?.ollama).toEqual({ think: false, options: { num_ctx: 16384 } });
  });

  it("leaves requests without reasoning options alone", () => {
    expect(textFirstProviderOptions("gpt-4o", undefined)).toBeUndefined();
    const offGemini = { google: { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } } };
    expect(textFirstProviderOptions("gemini-2.5-flash", offGemini)).toEqual(offGemini);
    const options = { model: "m", temperature: 0.2 };
    expect(withTextFirstStreamTextOptions(options, "m")).toBe(options);
  });
});

describe("wrap-up retry on the real runner — each provider's no-text shape", () => {
  beforeEach(() => {
    vi.mocked(streamText).mockReset();
  });

  const cases = [
    {
      name: "Anthropic Opus 5.5: adaptive thinking spends the step reasoning",
      shape: "anthropicThinkingOnly",
      provider: "anthropic",
      model: "claude-opus-5-5",
      providerOptions: { anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" } },
      retry: { anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" } },
    },
    {
      name: "Anthropic Sonnet 5.5: same shape, retried at low effort",
      shape: "anthropicThinkingOnly",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      providerOptions: { anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "max" } },
      retry: { anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" } },
    },
    {
      name: "OpenAI GPT-5.x: empty completion with finish=stop",
      shape: "openaiEmptyStop",
      provider: "openai",
      model: "gpt-5.5",
      providerOptions: { openai: { reasoningEffort: "high", reasoningSummary: "detailed" } },
      retry: { openai: { reasoningEffort: "low", reasoningSummary: "detailed" } },
    },
    {
      name: "Gemini: thoughts, then empty text parts",
      shape: "geminiEmptyParts",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      providerOptions: { google: { thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 } } },
      retry: { google: { thinkingConfig: { includeThoughts: false, thinkingBudget: 1024 } } },
    },
    {
      name: "Ollama Qwen: think runs into the length limit",
      shape: "ollamaThinkLength",
      provider: "ollama",
      model: "qwen3.5:latest",
      providerOptions: { ollama: { think: true, options: { num_ctx: 16384 } } },
      retry: { ollama: { think: false, options: { num_ctx: 16384 } } },
    },
  ];

  function runFor(c: (typeof cases)[number]) {
    const baseOptions = {
      model: {} as never,
      providerOptions: c.providerOptions,
      tools: { bash: {} },
    };
    return runWrapUpWithRetry({
      chatId: "chat-1",
      abortSignal: new AbortController().signal,
      attempt: (mode) =>
        runAiSdkWrapUpContinuation({
          aiSdkResult: { response: Promise.resolve({ messages: [] }) },
          streamTextOptions:
            mode === "text-first"
              ? withTextFirstStreamTextOptions(baseOptions, c.model)
              : baseOptions,
          chatId: "chat-1",
          apiKeys: [],
          provider: c.provider,
          abortSignal: new AbortController().signal,
          wrapUpMessage: mode === "text-first" ? WRAP_UP_TEXT_FIRST_RETRY : undefined,
        }),
    });
  }

  it.each(cases)("$name → recovered by the text-first retry", async (c) => {
    vi.mocked(streamText)
      .mockImplementationOnce(() => fakeStream(NO_TEXT[c.shape]!))
      .mockImplementationOnce(() => fakeStream(TEXT_REPLY));

    const { result } = await drain(runFor(c));

    expect(result.outcome).toEqual({ kind: "text", attempts: 2 });
    expect(result.state?.assistantText).toContain("the job finished cleanly");
    const calls = vi.mocked(streamText).mock.calls.map(([options]) => options as Record<string, unknown>);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.providerOptions).toEqual(c.providerOptions);
    expect(calls[1]!.providerOptions).toEqual(c.retry);
    expect(calls.every((options) => JSON.stringify(options.tools) === "{}")).toBe(true);
    const retryMessages = calls[1]!.messages as Array<{ role: string; content: unknown }>;
    expect(retryMessages.at(-1)).toEqual({ role: "user", content: WRAP_UP_TEXT_FIRST_RETRY });
  });

  it.each(cases)("$name twice → the turn still closes with a visible note", async (c) => {
    vi.mocked(streamText).mockImplementation(() => fakeStream(NO_TEXT[c.shape]!));

    const { result } = await drain(runFor(c));
    expect(result.outcome).toEqual({ kind: "empty", attempts: 2 });

    const turn = { sequence: TOOL_ONLY_TURN, assistantText: "Checking the box first." };
    expect(
      needsFinalReplyFallback({
        ...turn,
        toolCallCount: 1,
        aborted: false,
        isWrapUpContinuation: false,
        providerStreamFailed: false,
      }),
    ).toBe(true);
    const note = buildNoReplyFallback({
      reason: classifyNoReply({
        yieldedToUser: false,
        wrapUp: result.outcome,
        toolCallCount: 1,
        thinkingText: "…",
      }),
      toolNames: ["bash"],
    });
    expect(note).toContain("the model stopped after its tool calls without writing any text");
  });

  it("a provider error becomes the reason, not a red banner over the turn", async () => {
    vi.mocked(streamText).mockImplementation(() =>
      fakeStream([
        { type: "error", error: new Error("prompt is too long: 1048576 tokens > 1000000 maximum") },
        { type: "finish", finishReason: "error" },
      ]),
    );
    const { chunks, result } = await drain(runFor(cases[0]!));

    expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
    expect(result.outcome.kind).toBe("error");
    const message = result.outcome.kind === "error" ? result.outcome.message : "";
    expect(message).toContain("prompt is too long");
    const note = buildNoReplyFallback({ reason: "wrap_up_error", toolNames: ["bash"], errorMessage: message });
    expect(note).toContain("writing the reply failed (prompt is too long");
  });

  it("a thrown request error is caught and retried", async () => {
    vi.mocked(streamText)
      .mockImplementationOnce(() => {
        throw new Error("overloaded_error");
      })
      .mockImplementationOnce(() => fakeStream(TEXT_REPLY));
    const { result } = await drain(runFor(cases[2]!));
    expect(result.outcome).toEqual({ kind: "text", attempts: 2 });
  });

  it("does not retry a turn the user stopped", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const { result } = await drain(
      runWrapUpWithRetry({
        chatId: "chat-1",
        abortSignal: controller.signal,
        attempt: () => {
          attempts += 1;
          controller.abort();
          return (async function* () {
            return null;
          })();
        },
      }),
    );
    expect(attempts).toBe(1);
    expect(result.outcome).toEqual({ kind: "empty", attempts: 1 });
  });
});

describe("pi-ai route (OAuth: Claude subscription / ChatGPT Codex)", () => {
  it("retries text-first with one instruction and leaves the shared context untouched", async () => {
    const piContext = { messages: [{ role: "user", content: "how many GPUs?" }], tools: [{ name: "bash" }] };
    const seen: Array<{ context: { messages: Array<{ role: string; content: unknown }>; tools: unknown[] }; options: Record<string, unknown> }> = [];
    const thinkingOnly = [
      { type: "thinking_start" },
      { type: "thinking_delta", delta: "Considering H100 vs H200…" },
      { type: "thinking_end" },
      { type: "done", reason: "length" },
    ];
    const text = [{ type: "text_delta", delta: "One H100 is enough with grad-cache." }, { type: "done", reason: "stop" }];
    const streamSimple = (_model: unknown, context: unknown, options: unknown) => {
      seen.push({ context: context as never, options: options as never });
      return fromList(seen.length === 1 ? thinkingOnly : text);
    };

    const { result } = await drain(
      runWrapUpWithRetry({
        chatId: "chat-2",
        abortSignal: new AbortController().signal,
        attempt: (mode) =>
          runPiAiWrapUpContinuation({
            piContext,
            streamSimple,
            piModel: {},
            streamOpts: { reasoning: mode === "text-first" ? "low" : "high" },
            chatId: "chat-2",
            apiKeys: [],
            abortSignal: new AbortController().signal,
            wrapUpMessage: mode === "text-first" ? WRAP_UP_TEXT_FIRST_RETRY : undefined,
          }),
      }),
    );

    expect(result.outcome).toEqual({ kind: "text", attempts: 2 });
    expect(result.state?.assistantText).toContain("One H100 is enough");
    expect(piContext.messages).toHaveLength(1);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.context.messages).toHaveLength(2);
    expect(seen[1]!.context.messages[1]!.content).toBe(WRAP_UP_TEXT_FIRST_RETRY);
    expect(seen.every(({ context }) => context.tools.length === 0)).toBe(true);
    expect(seen[1]!.options.reasoning).toBe("low");
  });
});

describe("provider errors keep their text through sanitization", () => {
  it("an Error's message survives (redacted), instead of becoming {}", async () => {
    const { sanitizeToolOutput } = await import("../src/core/tools/security.js");
    const key = "sk-ant-api03-SECRETSECRETSECRET";
    const out = sanitizeToolOutput(new Error(`prompt is too long (key ${key})`), [key]) as Record<string, unknown>;
    expect(out.name).toBe("Error");
    expect(String(out.message)).toContain("prompt is too long");
    expect(JSON.stringify(out)).not.toContain(key);
  });
});

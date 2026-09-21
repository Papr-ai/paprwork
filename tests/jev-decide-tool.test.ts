import { describe, it, expect, vi, afterEach } from "vitest";
import { getToolById } from "../src/core/tools/index.js";
import { evaluateJev, normalizeQuestionType } from "../src/core/tools/jevClient.js";
import {
  assertJevInputWithinGuardrails,
  JEV_MAX_STATE_CHARS,
} from "../src/core/tools/jevGuardrails.js";
import { resolveJevAuth } from "../src/core/tools/jevAuth.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.PAPR_API_KEY;
});

describe("jev_decide registration", () => {
  it("is registered on allTools", () => {
    const tool = getToolById("jev_decide");
    expect(tool).toBeDefined();
    expect(tool?.id).toBe("jev_decide");
  });
});

describe("normalizeQuestionType", () => {
  it("maps boolean to noul", () => {
    expect(normalizeQuestionType("boolean")).toBe("noul");
  });

  it("rejects unknown types", () => {
    expect(() => normalizeQuestionType("text")).toThrow(/Unsupported/);
  });
});

describe("evaluateJev", () => {
  it("posts state and questions and returns answers", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            urgent: { type: "noul", noul: 0.91 },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await evaluateJev({
      apiKey: "test-key",
      state: "Need this today",
      questions: {
        urgent: { type: "noul", instructions: "Time-sensitive?" },
      },
      fetchImpl,
    });

    expect(result.answers.urgent).toMatchObject({ noul: 0.91 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("jev-latest");
    expect(body.questions.urgent.type).toBe("noul");
  });

  it("uses X-API-Key when authHeader is x-api-key", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ model: "jev-latest", answers: {} }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await evaluateJev({
      apiKey: "papr-key",
      authHeader: "x-api-key",
      state: "x",
      questions: { q: { type: "noul", instructions: "?" } },
      fetchImpl,
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("papr-key");
    expect(headers.Authorization).toBeUndefined();
  });

  it("rejects empty questions", async () => {
    await expect(
      evaluateJev({
        apiKey: "test-key",
        state: "x",
        questions: {},
      }),
    ).rejects.toThrow(/at least one/);
  });
});

describe("jev guardrails", () => {
  it("rejects oversized state", () => {
    expect(() =>
      assertJevInputWithinGuardrails({
        state: "x".repeat(JEV_MAX_STATE_CHARS + 1),
        questions: { q: { type: "noul", instructions: "?" } },
      }),
    ).toThrow(/max/);
  });
});

describe("resolveJevAuth", () => {
  it("prefers PAPR_API_KEY for proxy", async () => {
    process.env.PAPR_API_KEY = "sk-test";
    const auth = await resolveJevAuth();
    expect(auth?.mode).toBe("papr_proxy");
    expect(auth?.authHeader).toBe("x-api-key");
    expect(auth?.endpoint).toContain("/v1/typesafe/systemone");
  });

  it("falls back to TYPESAFE_API_KEY", async () => {
    process.env.TYPESAFE_API_KEY = "ts-test";
    const auth = await resolveJevAuth();
    expect(auth?.mode).toBe("typesafe_byok");
    expect(auth?.authHeader).toBe("bearer");
  });
});

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppAgentChatConfig } from "../../src/core/types/appAgentChat";
import { getGatewayHttpBase } from "../utils/gatewayHttpBase";

export interface EmbeddedChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface EmbeddedChatToolCall {
  toolCallId?: string;
  toolName: string;
  args?: Record<string, unknown>;
  status: "pending" | "success" | "error";
  result?: unknown;
}

export interface EmbeddedChatPlan {
  planId: string;
  title: string;
  steps: Array<{
    id: string;
    description: string;
    status: "pending" | "in_progress" | "completed" | "skipped";
  }>;
  deleted?: boolean;
}

export interface UseEmbeddedAppAgentChatOptions {
  appId: string;
  config: AppAgentChatConfig;
  initialMessage?: string;
  onAppRefresh?: () => void;
}

export function useEmbeddedAppAgentChat({
  appId,
  config,
  initialMessage,
  onAppRefresh,
}: UseEmbeddedAppAgentChatOptions) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<EmbeddedChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [sending, setSending] = useState(false);
  const [thinking, setThinking] = useState("");
  const [thinkingStreaming, setThinkingStreaming] = useState(false);
  const [toolCalls, setToolCalls] = useState<EmbeddedChatToolCall[]>([]);
  const [plans, setPlans] = useState<EmbeddedChatPlan[]>([]);
  const activeTurnIdRef = useRef<string | null>(null);
  const initialSentRef = useRef(false);
  const base = getGatewayHttpBase();

  const streamTurn = useCallback(
    async (session: string, message: string): Promise<void> => {
      setSending(true);
      setThinking("");
      setThinkingStreaming(false);
      setToolCalls([]);
      setPlans([]);
      setError(null);

      const userMsg: EmbeddedChatMessage = {
        id: `local-${Date.now()}`,
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      let assistantText = "";

      try {
        const postRes = await fetch(
          `${base}/api/app-agent/sessions/${session}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
          },
        );
        if (!postRes.ok) {
          const body = (await postRes.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `Send failed (${postRes.status})`);
        }
        const { turnId } = (await postRes.json()) as { turnId: string };
        activeTurnIdRef.current = turnId;

        await new Promise<void>((resolve, reject) => {
          const source = new EventSource(
            `${base}/api/app-agent/sessions/${session}/stream?turnId=${encodeURIComponent(turnId)}`,
          );

          source.addEventListener("app-agent:thinking-delta", (event) => {
            try {
              const data = JSON.parse((event as MessageEvent).data) as {
                text?: string;
              };
              if (typeof data.text === "string") {
                setThinkingStreaming(true);
                setThinking((prev) => prev + data.text);
              }
            } catch {
              /* ignore */
            }
          });

          source.addEventListener("app-agent:text-delta", (event) => {
            try {
              const data = JSON.parse((event as MessageEvent).data) as {
                text?: string;
              };
              if (typeof data.text === "string") {
                setThinkingStreaming(false);
                assistantText += data.text;
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (last?.role === "assistant" && last.id.startsWith("stream-")) {
                    return [
                      ...prev.slice(0, -1),
                      { ...last, content: assistantText },
                    ];
                  }
                  return [
                    ...prev,
                    {
                      id: `stream-${turnId}`,
                      role: "assistant" as const,
                      content: assistantText,
                      timestamp: new Date().toISOString(),
                    },
                  ];
                });
              }
            } catch {
              /* ignore */
            }
          });

          source.addEventListener("app-agent:tool-call", (event) => {
            try {
              const data = JSON.parse((event as MessageEvent).data) as {
                toolCallId?: string;
                toolName?: string;
                args?: Record<string, unknown>;
              };
              if (data.toolName) {
                setThinkingStreaming(false);
                setToolCalls((prev) => [
                  ...prev,
                  {
                    toolCallId: data.toolCallId,
                    toolName: data.toolName as string,
                    args: data.args,
                    status: "pending",
                  },
                ]);
              }
            } catch {
              /* ignore */
            }
          });

          const markTool = (
            toolCallId: string | undefined,
            toolName: string | undefined,
            status: "success" | "error",
            result?: unknown,
          ) => {
            if (!toolName) return;
            setToolCalls((prev) => {
              const idx = toolCallId
                ? prev.findIndex((t) => t.toolCallId === toolCallId)
                : prev.findIndex(
                    (t) => t.toolName === toolName && t.status === "pending",
                  );
              if (idx < 0) return prev;
              const next = [...prev];
              next[idx] = { ...next[idx], status, result };
              return next;
            });
            if (result !== undefined && toolName) {
              void import("../components/Chat/PlanCard.js").then(({ parsePlanFromToolResult }) => {
                const plan = parsePlanFromToolResult(
                  toolName,
                  typeof result === "string" ? result : JSON.stringify(result),
                );
                if (!plan) return;
                setPlans((prev) => {
                  const existing = prev.findIndex((p) => p.planId === plan.planId);
                  if (existing >= 0) {
                    const next = [...prev];
                    next[existing] = plan;
                    return next;
                  }
                  return [...prev, plan];
                });
              });
            }
          };

          source.addEventListener("app-agent:tool-result", (event) => {
            try {
              const data = JSON.parse((event as MessageEvent).data) as {
                toolCallId?: string;
                toolName?: string;
                result?: unknown;
              };
              markTool(data.toolCallId, data.toolName, "success", data.result);
            } catch {
              /* ignore */
            }
          });

          source.addEventListener("app-agent:tool-error", (event) => {
            try {
              const data = JSON.parse((event as MessageEvent).data) as {
                toolCallId?: string;
                toolName?: string;
              };
              markTool(data.toolCallId, data.toolName, "error");
            } catch {
              /* ignore */
            }
          });

          source.addEventListener("app-agent:turn-done", (event) => {
            try {
              const data = JSON.parse((event as MessageEvent).data) as {
                assistantText?: string;
                shouldRefreshApp?: boolean;
              };
              if (data.assistantText?.trim()) {
                assistantText = data.assistantText.trim();
              }
              if (data.shouldRefreshApp) {
                onAppRefresh?.();
              }
            } catch {
              /* ignore */
            }
            source.close();
            resolve();
          });

          source.addEventListener("app-agent:error", (event) => {
            try {
              const data = JSON.parse((event as MessageEvent).data) as {
                error?: string;
              };
              reject(new Error(data.error ?? "Assistant error"));
            } catch {
              reject(new Error("Assistant error"));
            }
            source.close();
          });

          source.onerror = () => {
            source.close();
            resolve();
          };
        });

        if (assistantText.trim()) {
          setMessages((prev) => {
            const withoutStream = prev.filter((m) => !m.id.startsWith("stream-"));
            const last = withoutStream[withoutStream.length - 1];
            if (
              last?.role === "assistant" &&
              last.content.trim() === assistantText.trim()
            ) {
              return withoutStream;
            }
            return [
              ...withoutStream,
              {
                id: `msg-${Date.now()}`,
                role: "assistant" as const,
                content: assistantText.trim(),
                timestamp: new Date().toISOString(),
              },
            ];
          });
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSending(false);
        setThinking("");
        setThinkingStreaming(false);
        setToolCalls([]);
        setPlans([]);
        activeTurnIdRef.current = null;
      }
    },
    [base, onAppRefresh],
  );

  const stopTurn = useCallback(async () => {
    if (!sessionId || !activeTurnIdRef.current) return;
    try {
      await fetch(
        `${base}/api/app-agent/sessions/${sessionId}/turns/${activeTurnIdRef.current}/cancel`,
        { method: "POST" },
      );
    } catch {
      /* ignore */
    }
  }, [base, sessionId]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setStarting(true);
      setError(null);
      try {
        const createRes = await fetch(`${base}/api/app-agent/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId }),
        });
        if (!createRes.ok) {
          const body = (await createRes.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `Session failed (${createRes.status})`);
        }
        const { sessionId: id } = (await createRes.json()) as {
          sessionId: string;
        };
        if (cancelled) return;

        setSessionId(id);

        const welcome = config.welcomeMessage?.trim();
        if (welcome) {
          setMessages([
            {
              id: "welcome",
              role: "assistant",
              content: welcome,
              timestamp: new Date().toISOString(),
            },
          ]);
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
        }
      } finally {
        if (!cancelled) {
          setStarting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [appId, base, config.welcomeMessage]);

  useEffect(() => {
    const trimmed = initialMessage?.trim();
    if (!sessionId || !trimmed || initialSentRef.current || starting) {
      return;
    }
    initialSentRef.current = true;
    void streamTurn(sessionId, trimmed);
  }, [initialMessage, sessionId, starting, streamTurn]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!sessionId) return;
      if (sending) {
        await stopTurn();
        return;
      }
      await streamTurn(sessionId, text.trim());
    },
    [sessionId, sending, streamTurn, stopTurn],
  );

  return {
    sessionId,
    messages,
    error,
    starting,
    sending,
    thinking,
    thinkingStreaming,
    toolCalls,
    plans,
    sendMessage,
    stopTurn,
  };
}

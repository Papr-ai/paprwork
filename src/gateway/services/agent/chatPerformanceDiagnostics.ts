import { DiagnosticOperation, diagnosticErrorType, withDiagnosticContext, type DiagnosticContext } from "../../../core/utils/performanceDiagnostics.js";
import type { StreamChunk } from "../../../core/types/streaming.js";

/** Measure chunks leaving the agent service, including provider-independent queue events. */
export async function* measureChatStream<T extends StreamChunk>(
  stream: AsyncIterable<T>, context: DiagnosticContext,
): AsyncGenerator<T> {
  const trace = new DiagnosticOperation("chat", "agent-turn", context);
  const turnContext = { ...context, turnId: trace.id };
  const source: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]();
      return {
        next: () => withDiagnosticContext(turnContext, () => iterator.next()),
        return: () => withDiagnosticContext(turnContext, () => iterator.return
          ? iterator.return() : Promise.resolve({ done: true as const, value: undefined })),
      };
    },
  };
  let done = false;
  let failed = false;
  let outcome: "completed" | "error" | "cancelled" = "cancelled";
  trace.setQueueMs(0);
  try {
    for await (const chunk of source) {
      if (chunk.type === "concurrency-queued") trace.queued();
      if (chunk.type === "concurrency-acquired") trace.admitted();
      if (["text-delta", "reasoning-delta", "tool-call", "tool-call-delta", "tool-result", "tool-error"].includes(chunk.type)) {
        trace.event(chunk.type === "text-delta");
      }
      if (chunk.type === "error") { failed = true; trace.error(); }
      if (chunk.type === "done") done = true;
      yield chunk;
    }
    outcome = failed ? "error" : done ? "completed" : "cancelled";
  } catch (error) {
    trace.error(error);
    outcome = diagnosticErrorType(error) === "aborted" ? "cancelled" : "error";
    throw error;
  } finally {
    trace.finish(outcome);
  }
}

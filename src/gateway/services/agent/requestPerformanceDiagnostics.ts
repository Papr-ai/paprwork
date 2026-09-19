import type { LanguageModel } from "ai";
import type { AnyTool } from "../../../core/agents/ToolRegistry.js";
import { isFailedToolResult } from "../../../core/utils/interruptedToolResult.js";
import { DiagnosticOperation, diagnosticErrorType, type DiagnosticContext } from "../../../core/utils/performanceDiagnostics.js";

/** Observes the provider response itself, before the SDK executes local tools. */
export function measureLanguageModel(model: LanguageModel, context: DiagnosticContext): LanguageModel {
  if (typeof model === "string") return model;
  return new Proxy(model, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== "doStream" || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const trace = new DiagnosticOperation("model", "provider-request", context);
        try {
          const result = await value.apply(target, args);
          const reader = result.stream.getReader();
          let failed = false;
          return { ...result, stream: new ReadableStream({
            async pull(controller) {
              try {
                const next = await reader.read();
                if (next.done) {
                  trace.finish(failed ? "error" : "completed");
                  reader.releaseLock(); controller.close(); return;
                }
                const type = next.value?.type;
                if (["text-delta", "reasoning-delta", "tool-call", "tool-input-delta"].includes(type)) trace.event(type === "text-delta");
                if (type === "error") { failed = true; trace.error(next.value.error); }
                controller.enqueue(next.value);
              } catch (error) {
                trace.error(error);
                trace.finish(diagnosticErrorType(error) === "aborted" ? "cancelled" : "error");
                reader.releaseLock(); controller.error(error);
              }
            },
            async cancel(reason) {
              trace.finish("cancelled");
              try { await reader.cancel(reason); } finally { reader.releaseLock(); }
            },
          }, { highWaterMark: 0 }) };
        } catch (error) {
          trace.error(error);
          trace.finish(diagnosticErrorType(error) === "aborted" ? "cancelled" : "error");
          throw error;
        }
      };
    },
  });
}

export function measureTools(tools: Record<string, AnyTool>, context: DiagnosticContext): Record<string, AnyTool> {
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    const execute = tool.execute;
    if (!execute) return [name, tool];
    return [name, { ...tool, execute: async (...args: Parameters<NonNullable<AnyTool["execute"]>>) => {
      const trace = new DiagnosticOperation("tool", name, context);
      try {
        const result = await execute.apply(tool, args);
        const failed = isFailedToolResult(result);
        if (failed) trace.error();
        trace.finish(failed ? "error" : "completed");
        return result;
      } catch (error) {
        trace.error(error);
        trace.finish(diagnosticErrorType(error) === "aborted" ? "cancelled" : "error");
        throw error;
      }
    } }];
  }));
}

import type { LanguageModel } from "ai";
import type { AnyTool } from "../../../core/agents/ToolRegistry.js";
import { isFailedToolResult } from "../../../core/utils/interruptedToolResult.js";
import { DiagnosticOperation, diagnosticErrorType, type DiagnosticContext } from "../../../core/utils/performanceDiagnostics.js";
import { deferredToolNameFromExecuteInput } from "./deferredToolAccess.js";
import {
  extractSeeImage,
  SEE_IMAGE_ATTACHED_NOTE,
  stripInlineImagesFromValue,
} from "./stripToolResultImages.js";
import { modelSupportsVision } from "./attachmentVision.js";

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
    return [name, { ...tool, toModelOutput: (tool as { toModelOutput?: unknown }).toModelOutput ?? modelOutputFor(context), execute: async (...args: Parameters<NonNullable<AnyTool["execute"]>>) => {
      const innerDeferred = name === "run_deferred_tool"
        ? deferredToolNameFromExecuteInput(args[0])
        : undefined;
      const traceLabel = innerDeferred ? `run_deferred_tool→${innerDeferred}` : name;
      const trace = new DiagnosticOperation("tool", traceLabel, context);
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

/**
 * Model-facing copy of a tool result with inline screenshots removed (see
 * stripToolResultImages.ts). Mirrors the SDK default: strings → text, else
 * json. When the tool opted in (webview_snapshot see: true) and the model can
 * read images, the screenshot rides along as a real media part.
 */
function modelOutputFor(context: DiagnosticContext) {
  const canSee =
    Boolean(context.provider && context.model) &&
    modelSupportsVision(context.provider!, context.model!);
  return ({ output }: { output: unknown }) => {
    const value = stripInlineImagesFromValue(output);
    const image = canSee ? extractSeeImage(output) : null;
    if (image) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return {
        type: "content" as const,
        value: [
          { type: "text" as const, text: `${text}\n${SEE_IMAGE_ATTACHED_NOTE}` },
          { type: "media" as const, data: image.data, mediaType: image.mimeType },
        ],
      };
    }
    if (typeof value === "string") return { type: "text" as const, value };
    return { type: "json" as const, value: (value ?? null) as never };
  };
}

/** Back-compat for tests: strip-only, no vision context. */
export const modelOutputWithoutImages = modelOutputFor({});

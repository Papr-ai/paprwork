import { getCurrentChatId } from "../../../core/tools/context.js";
import { getCustomKeysService } from "../CustomKeysService.js";
import { evaluateBashCapture } from "./evaluation.js";
import { getToolCaptureLedger } from "./ToolCaptureLedger.js";
import { syncToolCaptureToMemory } from "./ToolCaptureMemorySync.js";

export interface ScheduleBashCaptureInput {
  originalCommand: string;
  stdout: string;
  chatId?: string | null;
}

async function processBashCapture(input: ScheduleBashCaptureInput): Promise<void> {
  const chatId = input.chatId ?? getCurrentChatId();
  if (!chatId) {
    return;
  }

  const stdout = input.stdout.trim();
  if (!stdout) {
    return;
  }

  const service = getCustomKeysService();
  const listedKeys = await service.listKeys();
  const listedKeyNames = listedKeys.map((key) => key.name);

  const evaluation = evaluateBashCapture({
    originalCommand: input.originalCommand,
    stdout,
    listedKeyNames,
  });
  if (!evaluation) {
    return;
  }

  const row = getToolCaptureLedger().tryInsertCapture({
    dedupKey: evaluation.dedupKey,
    contentHash: evaluation.contentHash,
    chatId,
    toolName: "bash",
    keysUsed: evaluation.keysUsed,
    inferredLabel: evaluation.inferredLabel,
    contentDate: evaluation.contentDate,
    inferredSubject: evaluation.inferredSubject,
    body: stdout,
  });

  if (!row) {
    return;
  }

  console.log(
    `[ToolCapture] Queued capture ${row.id} (${evaluation.inferredLabel}, ${evaluation.contentDate}, keys: ${evaluation.keysUsed.join(", ")})`,
  );

  await syncToolCaptureToMemory(row);
}

/**
 * Fire-and-forget: evaluate bash output for registered API key usage,
 * persist to local ledger, then sync to Papr Memory asynchronously.
 */
export function scheduleBashCapture(input: ScheduleBashCaptureInput): void {
  void processBashCapture(input).catch((error) => {
    console.warn(
      "[ToolCapture] Background capture failed:",
      error instanceof Error ? error.message : String(error),
    );
  });
}

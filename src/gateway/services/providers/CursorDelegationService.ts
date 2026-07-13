/**
 * Cursor Composer via Papr cloud runtime.
 *
 * @cursor/sdk runs server-side only on the memory server. Paprwork streams SSE
 * from POST /v1/cloud/runtime/sessions/stream — CURSOR_API_KEY never touches the client.
 */

import { getCloudRuntimeService } from "./CloudRuntimeService.js";

export interface CursorDelegationStreamInput {
  chatId: string;
  prompt: string;
  modelId: string;
  paprApiKey: string;
  cwd?: string;
  repos?: Array<{ url: string; startingRef?: string }>;
  signal?: AbortSignal;
}

/** @deprecated Use CloudRuntimeService directly for new code. */
export class CursorDelegationService {
  private readonly runtime = getCloudRuntimeService();

  async *streamTurn(
    input: CursorDelegationStreamInput,
  ): AsyncGenerator<unknown> {
    yield* this.runtime.streamTurn({
      chatId: input.chatId,
      prompt: input.prompt,
      provider: "cursor",
      modelId: input.modelId,
      paprApiKey: input.paprApiKey,
      signal: input.signal,
    });
  }

  disposeChat(chatId: string): void {
    this.runtime.disposeChat(chatId);
  }
}

let sharedService: CursorDelegationService | undefined;

export function getCursorDelegationService(): CursorDelegationService {
  if (!sharedService) {
    sharedService = new CursorDelegationService();
  }
  return sharedService;
}

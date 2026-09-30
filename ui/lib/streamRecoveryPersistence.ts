import type { StreamRecoveryReason } from "../types/chat";

/**
 * Whether a recovery banner must outlive the stream's terminal `done` chunk.
 *
 * A provider refusal is terminal but not abnormal: the error chunk sets the
 * banner and the stream then closes cleanly, so `done` arrives milliseconds
 * later. `done` means "nothing further is coming", which is not the same as
 * "the problem is resolved" — and the banner is the only place the user is
 * told which credential was refused and what the provider actually said.
 *
 * A connection-reason banner is the opposite case: it is raised while the
 * stream is still expected to produce output, so a `done` that does arrive is
 * evidence the stream finished and the banner should go.
 */
export function recoveryBannerSurvivesStreamEnd(args: {
  needsStreamRecovery: boolean;
  reason: StreamRecoveryReason | undefined;
}): boolean {
  if (!args.needsStreamRecovery) return false;
  return args.reason === "rateLimit";
}

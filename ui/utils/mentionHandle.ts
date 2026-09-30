/**
 * Re-export @mention handle helpers from core (used by renderer + tests).
 */

export type { MentionCandidate } from "../../src/core/utils/mentionHandle.js";

export {
  buildUniqueMentionHandles,
  matchesMentionQuery,
  toMentionHandle,
} from "../../src/core/utils/mentionHandle.js";

/** Minimum sanitized stdout length to consider for memory capture. */
export const MIN_CAPTURE_CHARS = 1000;

/** Max chars sent to Papr Memory per capture (full body may be larger in ledger). */
export const MAX_MEMORY_BODY_CHARS = 40_000;

/** Keys that trigger capture but should not be written to memory (self-referential). */
export const CAPTURE_EXCLUDED_KEY_NAMES = new Set<string>(["PAPR_API_KEY"]);

export const CAPTURE_SOURCE = "tool_capture";
export const CAPTURE_CONTENT_TYPE = "custom_key_fetch";

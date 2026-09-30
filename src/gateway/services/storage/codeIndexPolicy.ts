/**
 * Policy: is RAW code content allowed into Papr Memory?
 *
 * Default: NO.
 *
 * WHY
 * ---
 * There are two independent code-indexing paths in this codebase. They are
 * easy to confuse and they behave completely differently:
 *
 *   1. CodeSummaryIndexPipeline -> CodeSummaryMemoryStore.upsertSummary()
 *      LLM-written summary of a file/project. A REAL upsert: it deletes
 *      previousMemoryId before adding, and stores the new id in the tracker.
 *      Small, curated, self-cleaning. This path is KEPT.
 *
 *   2. CodeIndexerService.indexCodeFile() / indexProject()
 *      The raw file body, up to 50KB, added verbatim with no delete of any
 *      prior row. This path is what this flag disables.
 *
 * Measured cost of path 2 in one namespace:
 *
 *     code_indexer duplicate rows              29,315
 *     share of all duplicate rows in namespace   ~63%
 *     agent searches that used code filters     16 / 1,224  = 1.3%
 *     of returned slots that were duplicates    ~30%
 *
 * So path 2 is the dominant polluter of a shared memory namespace, and the
 * agent almost never reads it. Worse, those rows compete against genuinely
 * useful user memories for the same max_memories budget on EVERY search --
 * not just code searches. That is the actual user-visible harm: raw code
 * crowding out relevant memories.
 *
 * Duplicates arise here for two reasons, both confirmed against real rows:
 *
 *   - No gate on the direct call sites. needsIndexing() guards the two QUEUE
 *     paths (SmartCodeIndexManager:169, :393) but full re-index and
 *     single-project index call indexCodeFile() directly.
 *   - Identical content in different files. Measured group 05a6d704 is
 *     render.ts AND drawer.ts with byte-identical generated scaffolding: one
 *     memoryId, six rows. No per-file gate can see that.
 *
 * WHY A FLAG RATHER THAN DELETING THE CODE
 * ----------------------------------------
 * The retrieval design (see "Memory Write & Retrieval Architecture") moves
 * code search local-first: ripgrep + a code graph, with summaries in memory
 * and raw content read from disk on demand. Until that lands, keeping the
 * indexer intact behind a default-off flag means one env var re-enables it
 * for measurement without a revert.
 *
 * Set PAPR_CODE_RAW_MEMORY_INDEX=1 to restore the old behaviour.
 */

/** Values accepted as "on". Anything else, including unset, is off. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * True only when raw code bodies may be written to Papr Memory.
 *
 * Read at call time, not module load, so tests and a running gateway can flip
 * it without a restart.
 */
export function isRawCodeMemoryIndexEnabled(): boolean {
  const raw = process.env.PAPR_CODE_RAW_MEMORY_INDEX;
  if (!raw) {
    return false;
  }
  return TRUTHY.has(raw.trim().toLowerCase());
}

/** Single log line per process, so a disabled indexer is visible but not noisy. */
let announced = false;

export function announceRawCodeIndexPolicyOnce(): void {
  if (announced) {
    return;
  }
  announced = true;

  if (isRawCodeMemoryIndexEnabled()) {
    console.warn(
      "[CodeIndex] RAW code memory indexing is ENABLED (PAPR_CODE_RAW_MEMORY_INDEX). " +
        "This writes full file bodies to Papr Memory and is the known source of duplicate rows.",
    );
  } else {
    console.log(
      "[CodeIndex] Raw code memory indexing is off (default). " +
        "LLM file/project summaries still sync via CodeSummaryIndexPipeline; " +
        "set PAPR_CODE_RAW_MEMORY_INDEX=1 to restore raw indexing.",
    );
  }
}

/** Test helper: forget that we logged, so the next call announces again. */
export function resetRawCodeIndexPolicyAnnounce(): void {
  announced = false;
}

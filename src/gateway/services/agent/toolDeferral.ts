/**
 * Which tool schemas ride in the request, and which are fetched on demand.
 *
 * All 152 registered schemas are sent on every request — 40,220 tokens, ~20% of
 * a 200K cap — while a typical turn calls about 7 of them. Anthropic measures
 * ~85% reduction from deferring the unused ones.
 *
 * What this does and does not save, because the two are easy to conflate. The
 * block sent shrinks unconditionally, 40,220 -> ~11,600. The history *budget*
 * is derived as `windowShare - tools - reserve`, so a narrower block widens the
 * allowance by the same amount and the request ceiling is unchanged. The saving
 * is therefore real for any turn whose history does not fill its budget — the
 * common case, and every fresh chat — and on a chat long enough to fill it the
 * trade is roughly cost-neutral and buys history instead. Whether to tighten
 * `DEFAULT_HISTORY_TOKEN_CAP` so long chats also save is a tuning question for
 * the `deferred_tool_tokens` telemetry to answer, not a guess to make here.
 *
 * The selection is fixed for the whole turn, and that is the load-bearing
 * constraint rather than an implementation convenience. The tool block sits in
 * the cached prefix, so changing it mid-turn re-writes the cache: measured on a
 * 34-step turn with a ~270K prefix, deferring 30K of schema saves $0.70 while a
 * single mid-turn tool-set change costs $1.55 in cache writes. One unlock
 * therefore erases more than the whole turn's saving, which is why a deferred
 * tool is reached through a dispatcher (`run_deferred_tool`) instead of being
 * added to the set when it turns out to be needed.
 *
 * Three sources feed the selection:
 *  1. {@link MEASURED_CORE_TOOL_IDS} — the tools that are actually called.
 *  2. Tools whose id or description matches the request, so a turn about jobs
 *     gets the job tools without paying a discovery round-trip.
 *  3. The discovery/dispatch pair, always present, so nothing is unreachable.
 */

/**
 * Tools ranked by measured call frequency, covering 98.6% of 64,025 recorded
 * calls in ~11,600 tokens — 71% less than the full block.
 *
 * Derived from this workspace's own `chats.db`, not from taste. Re-derive with
 * `npm run measure:tool-usage`. Two things the ranking makes obvious and worth
 * keeping in mind before editing it by hand: `bash` alone is 56.6% of all
 * calls, and frequency is not cost — `create_job` costs 2,145 tokens for 79
 * recorded calls and `push_cloud_sync` 862 for none, which is exactly the shape
 * deferral exists to exploit.
 *
 * 40 is the knee of the coverage curve: 30 tools give 95.9% for 8,390 tokens,
 * 40 give 98.6% for 11,600, and 50 buy only 99.4% for 16,322.
 */
export const MEASURED_CORE_TOOL_IDS: readonly string[] = [
  "bash",
  "read_app_file",
  "webview_execute",
  "read_file",
  "update_plan",
  "search_agent_memory",
  "run_job",
  "webview_launch_app",
  "edit_file",
  "browser_navigate",
  "write_file",
  "browser_test_script",
  "create_plan",
  "webview_snapshot",
  "webview_close",
  "read_skill",
  "list_app_files",
  "webview_get_console",
  "validate_app",
  "get_full_tool_result",
  "read_document",
  "list_jobs",
  "read_job_file",
  "list_documents",
  "list_apps",
  "browser_wait_for",
  "page_wait_for",
  "get_key",
  "search_files",
  "add_agent_memory",
  "browser_snapshot",
  "edit_app_file_lines",
  "list_job_files",
  "read_app_data_sources",
  "update_job",
  "query_memory_graph",
  "list_keys",
  "create_document",
  "read_job_logs",
  "create_app",
];

/** Discovery and dispatch. Never deferred, or deferred tools are unreachable. */
export const DEFERRAL_ESCAPE_TOOL_IDS: readonly string[] = [
  "find_tools",
  "run_deferred_tool",
];

/**
 * Minimum saving before deferral is worth its own machinery.
 *
 * Below this the dispatcher's own description, the discovery round-trips it
 * will occasionally cost, and the loss of a stable cross-turn tool block are
 * not paid for. Gating on the *saving* rather than on a tool count or a
 * fraction of the window is deliberate: the benefit scales with the size of the
 * unused block, which is what this measures, and not with how big the model's
 * window happens to be.
 */
export const MIN_DEFERRAL_SAVING_TOKENS = 10_000;

export interface DeferrableTool {
  id: string;
  /** Used for request matching; the schema itself is not needed here. */
  description: string;
  /** Wire cost of this tool's schema, from `estimateToolTokens`. */
  tokens: number;
}

export interface ToolDeferralSelection {
  /** Ids to send this turn. */
  activeToolIds: string[];
  /** Ids withheld, reachable via the dispatcher. */
  deferredToolIds: string[];
  /** Tokens not sent. 0 when deferral is off. */
  savedTokens: number;
  /** False when the block is too small to be worth deferring. */
  enabled: boolean;
}

const WORD_SPLIT = /[^a-z0-9]+/;
const MIN_KEYWORD_LENGTH = 4;

/**
 * Floor for matching a whole segment of a tool id.
 *
 * Three rather than four because the registry's most discriminating segments
 * are three characters — `app` names 26 tools, `job` 17, `key` 4 — and they are
 * the words a request naturally uses. At four the id arm was blind to exactly
 * the phrasing it exists to catch: "add a background job to the app so it
 * refreshes data" selected nothing, and "create a job that runs every morning"
 * matched only by accident on `create`, so `create_job` reached a turn by luck
 * of wording. Re-derive the segment list with
 * `tr '_' '\n' < ids | awk 'length($0)==3' | sort | uniq -c`.
 *
 * Lowered for id segments only. The description arm keeps {@link
 * MIN_KEYWORD_LENGTH}, where across 150-odd prose descriptions a three-letter
 * word really is noise.
 */
const MIN_ID_SEGMENT_LENGTH = 3;

/**
 * Words too common in tool descriptions to discriminate. Without this, "file"
 * or "create" in a request would match most of the registry and defer nothing.
 *
 * The three-character entries are there because {@link MIN_ID_SEGMENT_LENGTH}
 * admits that tier, and a token only costs anything if it matches an id
 * segment — so the complete risk is the twelve segments the registry actually
 * has. Six name a domain and are kept (`app`, `job`, `key`, `sub`, `pdf`,
 * `api`); the six below are generic verbs and prepositions that would select
 * their whole family for nothing, `get` alone reaching 22 tools.
 */
const STOPWORDS = new Set([
  // Generic three-character id segments — see MIN_ID_SEGMENT_LENGTH.
  "get",
  "run",
  "set",
  "add",
  "for",
  "and",
  "this",
  "that",
  "with",
  "from",
  "your",
  "will",
  "when",
  "what",
  "have",
  "here",
  "into",
  "make",
  "need",
  "please",
  "should",
  "would",
  "about",
  "tool",
  "tools",
  "return",
  "returns",
  "using",
  "used",
  "name",
  "value",
  "given",
  "optional",
  "required",
]);

function extractKeywords(text: string, minLength = MIN_KEYWORD_LENGTH): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(WORD_SPLIT)) {
    if (raw.length < minLength) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Whether a deferred tool looks relevant to the request.
 *
 * Matching on the id is the strong signal, and it reaches the three-character
 * tier so that a request naming "job" or "app" actually selects those tools.
 * The description is matched only on an exact keyword hit, for the same reason
 * the stopword list exists: descriptions are long and prose-y, so loose
 * matching selects everything and saves nothing.
 *
 * The lower tier reaches the id arm alone, and what confines it there is that
 * `descWords` is built at {@link MIN_KEYWORD_LENGTH} — a three-character
 * request token cannot match a set that holds no three-character words. So
 * lowering the description floor is the change that would let two short
 * coincidences select a tool the request never named.
 *
 * @param requestTokens Request words at {@link MIN_ID_SEGMENT_LENGTH} or longer.
 */
function matchesRequest(tool: DeferrableTool, requestTokens: Set<string>): boolean {
  const idWords = tool.id.toLowerCase().split(WORD_SPLIT);
  for (const w of idWords) {
    if (w.length >= MIN_ID_SEGMENT_LENGTH && requestTokens.has(w)) return true;
  }
  const descWords = extractKeywords(tool.description);
  let hits = 0;
  for (const w of requestTokens) {
    if (descWords.has(w)) hits += 1;
    // Two independent description hits stand in for an id match; one is noise.
    if (hits >= 2) return true;
  }
  return false;
}

/**
 * Pick the tool set for one turn.
 *
 * `requestText` should be the user's message for this turn only. Feeding whole
 * history in would make almost everything match, and the selection has to be
 * decidable before the first step so it can stay fixed for the turn.
 */
export function selectTurnToolIds(params: {
  tools: DeferrableTool[];
  requestText: string;
  /** Overrides the core list — sub-agent profiles already narrow the registry. */
  coreToolIds?: readonly string[];
  minSavingTokens?: number;
}): ToolDeferralSelection {
  const available = new Set(params.tools.map((t) => t.id));
  const core = params.coreToolIds ?? MEASURED_CORE_TOOL_IDS;
  const minSaving = params.minSavingTokens ?? MIN_DEFERRAL_SAVING_TOKENS;

  const keep = new Set<string>();
  for (const id of core) if (available.has(id)) keep.add(id);
  for (const id of DEFERRAL_ESCAPE_TOOL_IDS) {
    if (available.has(id)) keep.add(id);
  }

  const requestTokens = extractKeywords(params.requestText, MIN_ID_SEGMENT_LENGTH);
  for (const tool of params.tools) {
    if (keep.has(tool.id)) continue;
    if (matchesRequest(tool, requestTokens)) keep.add(tool.id);
  }

  const deferred = params.tools.filter((t) => !keep.has(t.id));
  const savedTokens = deferred.reduce((sum, t) => sum + t.tokens, 0);

  // Below the threshold, send everything: a partial set still costs a
  // dispatcher and the occasional discovery step, and buys nothing back.
  if (savedTokens < minSaving) {
    return {
      activeToolIds: params.tools.map((t) => t.id),
      deferredToolIds: [],
      savedTokens: 0,
      enabled: false,
    };
  }

  return {
    activeToolIds: params.tools.filter((t) => keep.has(t.id)).map((t) => t.id),
    deferredToolIds: deferred.map((t) => t.id),
    savedTokens,
    enabled: true,
  };
}

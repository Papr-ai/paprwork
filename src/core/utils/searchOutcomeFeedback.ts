/**
 * Search-outcome feedback — derive retrieval quality from what the agent
 * actually used, instead of asking the agent to self-report.
 *
 * WHY THIS EXISTS
 * ---------------
 * `MemoryRetrievalLog` already records, for every search, the full candidate
 * list with scores (`retrievedMemories` + `retrievedMemoryScores`). The
 * expensive half of training-data capture is done. What is missing is the
 * label that splits that pool:
 *
 *     cited            => positive candidate
 *     high-score, not  => graded hard-negative candidate
 *
 * That split is the documented design in the papr-embed-v2 curation plan (§3),
 * and it is what gates D3 (label fidelity) and D5 (hard-negative quality).
 *
 * Measured on UserFeedbackLog: only 7 of 31 rows (23%) carried
 * `citedMemoryIds`, and 26 of 31 were `thumbs_up` with ZERO negatives. The
 * cause was the sampling rule, not the plumbing — the agent was told to submit
 * only when results were "clearly helpful or clearly irrelevant", which
 * deletes the middle of the distribution where hard negatives live.
 *
 * So: derive citations from the assistant's own answer at turn end. No model
 * cooperation required, and it covers every search rather than the ones an
 * agent chose to grade.
 *
 * WHAT THIS PRODUCES IS A *CANDIDATE*, NOT A LABEL
 * ------------------------------------------------
 * D3 requires implicit positives be graded before they are trusted — "a cited
 * memory can still be wrong; not-cited != irrelevant." Everything emitted here
 * is therefore tagged with its derivation method and a confidence, so the
 * curation pipeline can grade auto-derived citations separately from
 * agent-asserted ones. Provenance is the whole point; unmarked weak labels
 * mixed into a training set are worse than no labels.
 *
 * PRIVACY (D2 is a launch blocker, not a step)
 * --------------------------------------------
 * `feedbackText` emitted here is machine-parseable and carries ONLY counts,
 * ranks and scores. Never query text, never memory content. Auto-capture on
 * every search would otherwise widen PII exposure across the whole corpus.
 */

/** One retrieved memory, with the rank it was returned at. */
export interface RetrievedCandidate {
  id: string;
  content: string;
  /** 0-based position in the result list. Rank is the ranking-quality signal. */
  rank: number;
}

export interface RecordedSearch {
  searchId: string;
  memoryCount: number;
  nodeCount: number;
  /**
   * CRITICAL: false when the payload could not be parsed into candidates
   * (e.g. an unrecognised TOON shape). "Unknown" must never be graded as
   * "nothing was cited" — that would emit a false negative label for every
   * successful search. Same failure class as reading a query that matched
   * nothing as proof that there was nothing to match.
   */
  candidatesKnown: boolean;
  candidates: RetrievedCandidate[];
}

/** Per-turn registry. Reset at the start of every user turn. */
let pendingSearches: RecordedSearch[] = [];
const submittedSearchIds = new Set<string>();

export function resetSearchOutcomes(): void {
  pendingSearches = [];
  submittedSearchIds.clear();
}

export function recordSearchOutcome(search: RecordedSearch): void {
  if (!search.searchId) return;
  // A searchId can only be recorded once per turn.
  if (pendingSearches.some((s) => s.searchId === search.searchId)) return;
  pendingSearches.push(search);
}

export function getPendingSearchOutcomes(): readonly RecordedSearch[] {
  return pendingSearches;
}

/**
 * Claim a searchId so the turn-end flush skips it. Used by the immediate
 * empty-search path, which submits inline — without this the same searchId
 * would receive two feedback rows for one retrieval.
 */
export function markSearchOutcomeSubmitted(searchId: string): void {
  if (searchId) submittedSearchIds.add(searchId);
}

// ---------------------------------------------------------------------------
// Citation derivation
// ---------------------------------------------------------------------------

/**
 * Terms that carry no evidence of reuse. Deliberately small: the real
 * discriminator is the document-frequency filter below, which adapts to the
 * candidate set instead of relying on a fixed list.
 */
const STOPWORDS = new Set([
  "about", "after", "again", "against", "along", "also", "although", "always",
  "among", "another", "because", "been", "before", "being", "below", "between",
  "both", "cannot", "could", "does", "doing", "done", "down", "during", "each",
  "either", "else", "even", "ever", "every", "from", "further", "have", "having",
  "here", "however", "into", "itself", "just", "like", "made", "make", "many",
  "more", "most", "much", "must", "need", "neither", "never", "next", "none",
  "only", "other", "over", "same", "should", "since", "some", "such", "than",
  "that", "their", "them", "then", "there", "these", "they", "this", "those",
  "through", "under", "until", "very", "were", "what", "when", "where", "which",
  "while", "will", "with", "within", "without", "would", "your",
]);

/** Minimum token length. Short tokens are overwhelmingly function words. */
const MIN_TOKEN_LENGTH = 4;

/**
 * A term appearing in more than this fraction of candidates is not evidence
 * for any single one of them. With 25 near-topical results from one query,
 * the shared vocabulary IS the query — matching on it would mark every
 * candidate as cited.
 */
const MAX_DOC_FREQUENCY_RATIO = 0.5;

/** Below this many distinctive terms, a candidate cannot be judged. Skip it. */
const MIN_DISTINCTIVE_TERMS = 4;

/** Absolute + relative thresholds must BOTH hold. Tuned to favour precision. */
const MIN_MATCHED_TERMS = 3;
const MIN_MATCH_RATIO = 0.18;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter(
    (t) => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t),
  );
}

export type CitationMethod = "explicit_id" | "distinctive_terms";

export interface DerivedCitation {
  id: string;
  rank: number;
  method: CitationMethod;
  /** 0–1. Explicit id mention is certain; term overlap is graded. */
  confidence: number;
  matchedTerms: number;
  distinctiveTerms: number;
}

export interface CitationDerivation {
  citations: DerivedCitation[];
  citedIds: string[];
  /** Best (lowest) rank among cited candidates — the ranking-quality signal. */
  bestCitedRank: number | null;
  /** Candidates that were judgeable (enough distinctive terms to decide). */
  judgeableCount: number;
}

/**
 * Decide which retrieved memories the answer actually used.
 *
 * Method, in order of strength:
 *  1. The answer names the memory id outright — certain.
 *  2. IDF-style containment: a candidate's DISTINCTIVE terms (those not shared
 *     across the candidate set) appear in the answer. This is what separates
 *     "the answer reused this memory" from "all these memories are about the
 *     same topic, because they came from one query."
 *
 * Conservative by construction: a false positive here mints a false training
 * positive, which is more damaging than a missed one.
 */
export function deriveCitations(
  answerText: string,
  candidates: readonly RetrievedCandidate[],
): CitationDerivation {
  const empty: CitationDerivation = {
    citations: [],
    citedIds: [],
    bestCitedRank: null,
    judgeableCount: 0,
  };
  if (!answerText.trim() || candidates.length === 0) return empty;

  const answerLower = answerText.toLowerCase();
  const answerTerms = new Set(tokenize(answerText));

  const perCandidateTerms = candidates.map((c) => new Set(tokenize(c.content)));

  // Document frequency is computed over DISTINCT documents, not raw rows.
  //
  // Measured on a real response: max_memories=25 returned ONE document fanned
  // out across 25 metadata rows. Counting rows made every term appear in 100%
  // of "documents", so the >50% filter removed all of them, every candidate
  // became un-judgeable, and a total retrieval miss graded as
  // `citations_unknown` (3) instead of `retrieved_unused` (2) — the degenerate
  // case scoring HIGHER than a normal unused result. Deduplicating by id keeps
  // the ranking defect visible while still judging the underlying document.
  const seenIds = new Set<string>();
  const distinctTermSets: Set<string>[] = [];
  candidates.forEach((candidate, index) => {
    if (seenIds.has(candidate.id)) return;
    seenIds.add(candidate.id);
    distinctTermSets.push(perCandidateTerms[index] ?? new Set<string>());
  });

  const docFrequency = new Map<string, number>();
  for (const terms of distinctTermSets) {
    for (const term of terms) {
      docFrequency.set(term, (docFrequency.get(term) ?? 0) + 1);
    }
  }
  const distinctCount = distinctTermSets.length;
  const maxDocFrequency = Math.max(
    1,
    Math.floor(distinctCount * MAX_DOC_FREQUENCY_RATIO),
  );

  const citations: DerivedCitation[] = [];
  let judgeableCount = 0;

  candidates.forEach((candidate, index) => {
    // 1. Explicit id mention — unambiguous.
    if (candidate.id.length >= 8 && answerLower.includes(candidate.id.toLowerCase())) {
      citations.push({
        id: candidate.id,
        rank: candidate.rank,
        method: "explicit_id",
        confidence: 1,
        matchedTerms: 0,
        distinctiveTerms: 0,
      });
      judgeableCount += 1;
      return;
    }

    // 2. Distinctive-term containment.
    const distinctive = [...(perCandidateTerms[index] ?? new Set<string>())].filter(
      (term) =>
        distinctCount === 1 || (docFrequency.get(term) ?? 0) <= maxDocFrequency,
    );
    if (distinctive.length < MIN_DISTINCTIVE_TERMS) {
      // Not judgeable — too little unique signal. Deliberately NOT counted as
      // "not cited", so it cannot become a spurious hard negative.
      return;
    }
    judgeableCount += 1;

    const matched = distinctive.filter((term) => answerTerms.has(term)).length;
    const ratio = matched / distinctive.length;
    if (matched >= MIN_MATCHED_TERMS && ratio >= MIN_MATCH_RATIO) {
      citations.push({
        id: candidate.id,
        rank: candidate.rank,
        method: "distinctive_terms",
        // Saturates at 1.0 around a 0.5 match ratio.
        confidence: Math.min(1, Number((ratio * 2).toFixed(3))),
        matchedTerms: matched,
        distinctiveTerms: distinctive.length,
      });
    }
  });

  const bestCitedRank = citations.length
    ? Math.min(...citations.map((c) => c.rank))
    : null;

  return {
    citations,
    citedIds: citations.map((c) => c.id),
    bestCitedRank,
    judgeableCount,
  };
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

export type SearchOutcomeVerdict =
  | "no_results"
  | "retrieved_unused"
  | "cited_deep_rank"
  | "cited_mid_rank"
  | "cited_top_rank"
  | "citations_unknown";

export interface SearchOutcomeGrade {
  verdict: SearchOutcomeVerdict;
  /** 1–5, matching the memory_relevance score range accepted by /v1/feedback. */
  score: number;
  citedIds: string[];
  /** Machine-parseable, PII-free (D2). */
  feedbackText: string;
}

/**
 * Grade a search by WHERE the useful result landed, not merely whether one
 * existed. A search whose only useful hit was at rank 20 retrieved the right
 * thing and ranked it badly; collapsing that to "helpful" throws away the
 * signal an embedding model most needs. This is bucketed reciprocal rank.
 */
export function gradeSearchOutcome(
  search: RecordedSearch,
  derivation: CitationDerivation,
): SearchOutcomeGrade {
  const base = {
    citedIds: derivation.citedIds,
  };

  if (search.memoryCount === 0 && search.nodeCount === 0) {
    return {
      ...base,
      verdict: "no_results",
      score: 1,
      feedbackText: fmt({ verdict: "no_results", retrieved: 0, cited: 0 }),
    };
  }

  // Unknown must not be graded as unused — see RecordedSearch.candidatesKnown.
  if (!search.candidatesKnown) {
    return {
      ...base,
      verdict: "citations_unknown",
      score: 3,
      feedbackText: fmt({
        verdict: "citations_unknown",
        retrieved: search.memoryCount,
        cited: 0,
        note: "payload_unparsed",
      }),
    };
  }

  if (derivation.judgeableCount === 0) {
    return {
      ...base,
      verdict: "citations_unknown",
      score: 3,
      feedbackText: fmt({
        verdict: "citations_unknown",
        retrieved: search.memoryCount,
        cited: 0,
        note: "no_judgeable_candidates",
      }),
    };
  }

  const rank = derivation.bestCitedRank;
  if (rank === null) {
    return {
      ...base,
      verdict: "retrieved_unused",
      score: 2,
      feedbackText: fmt({
        verdict: "retrieved_unused",
        retrieved: search.memoryCount,
        cited: 0,
        judgeable: derivation.judgeableCount,
      }),
    };
  }

  const verdict: SearchOutcomeVerdict =
    rank <= 2 ? "cited_top_rank" : rank <= 9 ? "cited_mid_rank" : "cited_deep_rank";
  const score = rank <= 2 ? 5 : rank <= 9 ? 4 : 3;

  return {
    ...base,
    verdict,
    score,
    feedbackText: fmt({
      verdict,
      retrieved: search.memoryCount,
      cited: derivation.citedIds.length,
      judgeable: derivation.judgeableCount,
      best_rank: rank,
      methods: derivation.citations.map((c) => c.method).join("|"),
      mean_confidence: Number(
        (
          derivation.citations.reduce((s, c) => s + c.confidence, 0) /
          derivation.citations.length
        ).toFixed(3),
      ),
    }),
  };
}

/**
 * `key=value` pairs only — no free prose, no user content. Keeps auto-captured
 * feedback machine-parseable for curation and safe under D2.
 */
function fmt(fields: Record<string, string | number>): string {
  return [
    "auto=search_outcome_v1",
    ...Object.entries(fields).map(([k, v]) => `${k}=${v}`),
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

/** Minimal shape of the Papr client's feedback surface (keeps this testable). */
export interface FeedbackSubmitter {
  feedback: {
    submit: (body: Record<string, unknown>) => Promise<unknown>;
  };
}

export interface FlushResult {
  submitted: number;
  skipped: number;
  grades: SearchOutcomeGrade[];
}

/**
 * Submit one graded outcome per search recorded this turn. Never throws:
 * feedback capture must not be able to fail a user's turn.
 */
export async function flushSearchOutcomeFeedback(
  client: FeedbackSubmitter,
  answerText: string,
  // `object`, not Record<string, unknown>: paprUserScope() returns a union
  // (identity fields, or {} when no user is resolved) and both spread fine.
  userScope: object = {},
): Promise<FlushResult> {
  const searches = pendingSearches;
  pendingSearches = [];

  const result: FlushResult = { submitted: 0, skipped: 0, grades: [] };

  for (const search of searches) {
    if (submittedSearchIds.has(search.searchId)) {
      result.skipped += 1;
      continue;
    }
    try {
      const derivation = deriveCitations(answerText, search.candidates);
      const grade = gradeSearchOutcome(search, derivation);
      result.grades.push(grade);

      await client.feedback.submit({
        search_id: search.searchId,
        ...userScope,
        feedbackData: {
          feedbackSource: "session_end",
          feedbackType: "memory_relevance",
          feedbackText: grade.feedbackText,
          feedbackScore: grade.score,
          citedMemoryIds: grade.citedIds,
        },
      });
      submittedSearchIds.add(search.searchId);
      result.submitted += 1;
    } catch (error) {
      result.skipped += 1;
      console.warn(
        `[searchOutcomeFeedback] submit failed for ${search.searchId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return result;
}

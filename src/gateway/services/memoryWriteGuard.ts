/**
 * Content-hash short-circuit for repeated memory writes.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Parse census of one namespace found 44,357 Memory rows collapsing to
 * 16,137 distinct memoryIds: 1,455 duplicate groups, 28,220 removable rows
 * (63.6% of the namespace). The worst single memoryId had 450 rows with
 * identical content and 450 distinct createdAt values.
 *
 * The memory server derives memoryId from content, so re-adding the same text
 * produces another Memory DOCUMENT sharing one memoryId. Every dedup in the
 * search pipeline operates on memory *ids* and assumes memoryId -> one
 * document, so a single logical memory then fans out and consumes the whole
 * max_memories budget. Measured live: one memoryId returned 25/25 times.
 *
 * WHAT THE MEASURED DUPLICATES ACTUALLY LOOK LIKE
 * -----------------------------------------------
 * Three post-guard groups, inspected row by row:
 *
 *   7ba04fb2  x4  database_snapshot   two rows at the SAME second (10:52:26)
 *   6660c916  x7  database_summary    pairs at identical timestamps
 *   05a6d704  x6  code_indexer        render.ts and drawer.ts, SAME content
 *
 * That rules out the two explanations we assumed:
 *
 *   - Not a missing per-database gate. DatabaseMemorySync already calls
 *     shouldSyncDatabaseToMemory() and it works. But it is check-then-act
 *     against a file that is written after the network round-trip, so two
 *     concurrent syncs both observe "changed" and both write.
 *   - Not only re-indexing. 05a6d704 is two DIFFERENT files with byte-identical
 *     content (generated scaffolding). No per-file gate can see that, because
 *     per-file state says "this file is new".
 *
 * So the guard has to key on the CONTENT ABOUT TO BE SENT, not on the source
 * artifact, and it has to be atomic against concurrent writers.
 *
 * DESIGN
 * ------
 * Reserve-before-write, keyed by sha256(content):
 *
 *   1. in-process Set  -- collapses concurrent writers inside one gateway
 *   2. on-disk journal -- survives restarts and separate processes
 *
 * The reservation is taken BEFORE the network call and released only if the
 * write fails, so a second caller with identical content is rejected while the
 * first is still in flight. That is the part a plain "compare hash then write"
 * check cannot do.
 *
 * SAFETY
 * ------
 * This can only ever PREVENT a write; it never writes, updates, or deletes.
 * Worst case on a bug is a memory that should have been stored is skipped --
 * recoverable by clearing the journal. It deliberately does not attempt
 * memory.update(): update semantics need a stable source_key mapping we do not
 * have yet, and that is a larger change than this guard.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";

const JOURNAL_FILENAME = ".memory-write-hashes.json";

/** Journal entries older than this are dropped, so the file cannot grow forever. */
const RETENTION_MS = 90 * 24 * 60 * 60_000;

/** Trim only when the journal is actually large — keeps the common path cheap. */
const COMPACT_THRESHOLD = 5_000;

interface JournalEntry {
  /** ISO timestamp of the write that claimed this hash. */
  at: string;
  /** Writer that claimed it, for diagnosis. */
  source: string;
}

type Journal = Record<string, JournalEntry>;

/**
 * Hashes reserved by an in-flight write in THIS process.
 *
 * The measured races (two rows at the same second) happen inside one gateway,
 * so the journal alone — which is only written after a successful add — cannot
 * stop them. This set closes that window.
 */
const inFlight = new Set<string>();

function journalPath(): string {
  return path.join(getPaprDataDir(), JOURNAL_FILENAME);
}

export function hashMemoryContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function loadJournal(): Journal {
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath(), "utf8")) as Journal;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    /* first run, or unreadable — treat as empty so we never block a write */
  }
  return {};
}

function saveJournal(journal: Journal): void {
  try {
    const entries = Object.entries(journal);
    let next = journal;

    if (entries.length > COMPACT_THRESHOLD) {
      const cutoff = Date.now() - RETENTION_MS;
      next = Object.fromEntries(
        entries.filter(([, entry]) => {
          const at = Date.parse(entry.at);
          return Number.isNaN(at) || at >= cutoff;
        }),
      );
    }

    // Write-then-rename: a crash mid-write must not leave a truncated journal
    // that reads as empty and silently disables the guard.
    const target = journalPath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), "utf8");
    fs.renameSync(tmp, target);
  } catch {
    /* journal is an optimisation — never fail a write because it could not be saved */
  }
}

export interface MemoryWriteReservation {
  /** False when identical content was already written (or is being written now). */
  proceed: boolean;
  hash: string;
  /** Call after a SUCCESSFUL add to persist the hash. */
  commit: () => void;
  /** Call when the add failed, so a retry is not blocked by our own reservation. */
  release: () => void;
}

/**
 * Reserve the right to write this content.
 *
 * Returns `proceed: false` when an identical body was already stored, or is
 * currently in flight in this process. Callers must invoke `commit()` after a
 * successful add and `release()` on failure.
 *
 * Never throws: on any internal error it returns `proceed: true`, because
 * failing open (a possible duplicate) is strictly better than failing closed
 * (silently losing a memory).
 */
export function reserveMemoryWrite(
  content: string,
  source: string,
): MemoryWriteReservation {
  const noop = () => {};

  try {
    if (!content?.trim()) {
      // Empty content has no identity worth deduping; let the caller decide.
      return { proceed: true, hash: "", commit: noop, release: noop };
    }

    const hash = hashMemoryContent(content);

    if (inFlight.has(hash)) {
      console.log(
        `[memoryWriteGuard] skip ${source}: identical content already in flight (${hash.slice(0, 12)})`,
      );
      return { proceed: false, hash, commit: noop, release: noop };
    }

    const journal = loadJournal();
    const previous = journal[hash];
    if (previous) {
      console.log(
        `[memoryWriteGuard] skip ${source}: identical content stored ${previous.at} by ${previous.source} (${hash.slice(0, 12)})`,
      );
      return { proceed: false, hash, commit: noop, release: noop };
    }

    inFlight.add(hash);

    return {
      proceed: true,
      hash,
      commit: () => {
        inFlight.delete(hash);
        const current = loadJournal();
        current[hash] = { at: new Date().toISOString(), source };
        saveJournal(current);
      },
      release: () => {
        inFlight.delete(hash);
      },
    };
  } catch (error) {
    // Fail open — see doc comment.
    console.warn(
      `[memoryWriteGuard] guard error for ${source}, allowing write:`,
      error,
    );
    return { proceed: true, hash: "", commit: noop, release: noop };
  }
}

/** Test/maintenance helper: forget all reservations. */
export function resetMemoryWriteGuard(): void {
  inFlight.clear();
  try {
    fs.rmSync(journalPath(), { force: true });
  } catch {
    /* nothing to remove */
  }
}

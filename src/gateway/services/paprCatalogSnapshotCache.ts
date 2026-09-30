/**
 * Disk cache for the Papr tiers snapshot used by the turn-2 memory catalog.
 *
 * `sync.getTiers` routinely takes 20–90s. Without a disk cache every gateway
 * restart (and every 30-minute in-memory expiry) puts that call on the
 * critical path of the first chat's second turn. Here we persist the last
 * good snapshot and serve it stale-while-revalidate: the caller uses whatever
 * is on disk immediately and refreshes in the background when it is older
 * than the in-memory TTL. Only a cold install with no cache ever waits.
 */

import { promises as fs } from "fs";
import path from "path";
import type { MemoryObject } from "@papr/memory/resources/shared.js";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";

export interface PaprCatalogSnapshot {
  fetchedAt: number;
  tier0: MemoryObject[];
  tier1: MemoryObject[];
}

/** Snapshots older than this are ignored even as stale fallbacks. */
export const CATALOG_SNAPSHOT_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function cachePath(userId: string): string {
  const safe = userId.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(getPaprDataDir(), "cache", `papr-catalog-tiers-${safe}.json`);
}

export async function readPaprCatalogSnapshotCache(
  userId: string,
  now: number = Date.now(),
): Promise<PaprCatalogSnapshot | null> {
  try {
    const raw = await fs.readFile(cachePath(userId), "utf-8");
    const parsed = JSON.parse(raw) as Partial<PaprCatalogSnapshot>;
    if (
      typeof parsed.fetchedAt !== "number" ||
      !Array.isArray(parsed.tier0) ||
      !Array.isArray(parsed.tier1)
    ) {
      return null;
    }
    if (now - parsed.fetchedAt > CATALOG_SNAPSHOT_MAX_STALE_MS) {
      return null;
    }
    return {
      fetchedAt: parsed.fetchedAt,
      tier0: parsed.tier0,
      tier1: parsed.tier1,
    };
  } catch {
    return null;
  }
}

export async function writePaprCatalogSnapshotCache(
  userId: string,
  snapshot: PaprCatalogSnapshot,
): Promise<void> {
  try {
    const file = cachePath(userId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Strip embeddings defensively — they are never requested but would bloat the file.
    const slim = {
      fetchedAt: snapshot.fetchedAt,
      tier0: snapshot.tier0.map(stripEmbedding),
      tier1: snapshot.tier1.map(stripEmbedding),
    };
    await fs.writeFile(file, JSON.stringify(slim), "utf-8");
  } catch (error) {
    console.warn(
      "[PaprCatalogSnapshotCache] write failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

function stripEmbedding(m: MemoryObject): MemoryObject {
  const { embedding: _e, embedding_int8: _i, ...rest } = m as MemoryObject & {
    embedding?: unknown;
    embedding_int8?: unknown;
  };
  return rest as MemoryObject;
}

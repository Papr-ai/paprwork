/**
 * Paprwork documents → Parse `Post` → Papr Memory.
 *
 * WHAT THIS DOES *NOT* DO
 * -----------------------
 * It does not compute similarity, batch writes, create PageVersions, or write
 * memories. All of that already runs server-side in Parse Server's
 * `beforeSave('Post')` / `afterSave('Post')` hooks, which fire on ANY write to
 * the Post class — REST included. This module's whole job is:
 *
 *     create or update a Post row, then stop.
 *
 * Verified live (2026-09-15, probe against server.papr.ai):
 *
 *   new Post           → 1 Memory row linked via Post.memories   ✓
 *   trivial edit       → 0 new memories (similarity gate held)   ✓
 *   major rewrite      → +1 Memory, hasSignificantUpdate = true  ✓
 *
 * That second line is the important one: the server's cosine-similarity gate
 * suppresses near-identical saves, so an editor that fires on every keystroke
 * cannot flood memory. We add a local hash check purely to skip the HTTP
 * round-trip when we already know nothing changed.
 *
 * REQUIREMENTS (both verified before this was written)
 * ----------------------------------------------------
 * - PAPR_SESSION_TOKEN — `savePostToMemory` returns early on a null session
 *   token, silently. A master-key write would create the Post and store NO
 *   memory, so session auth is mandatory, not optional.
 * - workspace pointer — `afterSave` dereferences `post.get("workspace").id`
 *   unconditionally; a Post without it throws inside the hook.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";
import { getApiKey } from "../utils/keyResolver.js";
import {
  getGatewayPaprProfile,
  getPaprWorkspaceId,
} from "../utils/paprGatewayProfile.js";

const PARSE_SERVER_URL =
  process.env.PARSE_SERVER_URL || "https://server.papr.ai/parse";
const PARSE_APP_ID =
  process.env.PARSE_APP_ID || "671e705a-f735-4ec0-8474-15899a475440";

const INDEX_FILENAME = ".document-posts.json";

/** Skip documents too short to be worth a memory (drafts, empty stubs). */
const MIN_CONTENT_CHARS = 80;

/** Parse text column limit guard — keep well under any server-side cap. */
const MAX_CONTENT_CHARS = 100_000;

export interface DocumentPostEntry {
  postId: string;
  contentHash: string;
  updatedAt: string;
}

type DocumentPostIndex = Record<string, DocumentPostEntry>;

export type DocumentPostSyncReason =
  | "created"
  | "updated"
  | "unchanged"
  | "too_short"
  | "no_session"
  | "no_workspace"
  | "error";

export interface DocumentPostSyncResult {
  synced: boolean;
  reason: DocumentPostSyncReason;
  postId?: string;
}

function indexPath(): string {
  return path.join(getPaprDataDir(), INDEX_FILENAME);
}

function loadIndex(): DocumentPostIndex {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(indexPath(), "utf8"),
    ) as DocumentPostIndex;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* first run or unreadable — treat as empty */
  }
  return {};
}

function saveIndex(index: DocumentPostIndex): void {
  try {
    const target = indexPath();
    // Same durability pattern as memoryWriteGuard: ensure the directory
    // exists, write to a pid-unique temp file, then rename. A missing data dir
    // previously made writeFileSync throw ENOENT into a swallowing catch,
    // silently disabling the whole index.
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index), "utf8");
    fs.renameSync(tmp, target);
  } catch {
    /* index is an optimisation — never fail a document save for it */
  }
}

export function documentSourceKey(documentId: string): string {
  return `document:${documentId}`;
}

export function hashDocumentContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Look up the Post already backing this document, if any. */
export function getDocumentPostEntry(
  documentId: string,
): DocumentPostEntry | undefined {
  return loadIndex()[documentSourceKey(documentId)];
}

function parseHeaders(sessionToken: string): Record<string, string> {
  return {
    "X-Parse-Application-Id": PARSE_APP_ID,
    "X-Parse-Session-Token": sessionToken,
    "Content-Type": "application/json",
  };
}

/**
 * Create or update the Parse Post backing a paprwork document.
 *
 * Never throws: a document save must not fail because memory sync did.
 */
export async function syncDocumentToPost(input: {
  documentId: string;
  title: string;
  content: string;
}): Promise<DocumentPostSyncResult> {
  try {
    const content = (input.content || "").trim();
    if (content.length < MIN_CONTENT_CHARS) {
      return { synced: false, reason: "too_short" };
    }

    const sourceKey = documentSourceKey(input.documentId);
    const contentHash = hashDocumentContent(content);

    const index = loadIndex();
    const existing = index[sourceKey];

    // Local no-op: content is byte-identical to what we last sent. The server
    // would compute similarity 1.0 and skip anyway — this just avoids the
    // round-trip. Title changes alone do not re-send: the memory is built from
    // `text`, and the server gate keys on `text` too.
    if (existing && existing.contentHash === contentHash) {
      return { synced: false, reason: "unchanged", postId: existing.postId };
    }

    const sessionToken = await getApiKey("PAPR_SESSION_TOKEN");
    if (!sessionToken) {
      // Not an error: signed-out users keep working locally, with no sync.
      return { synced: false, reason: "no_session" };
    }

    const workspaceId = getPaprWorkspaceId();
    if (!workspaceId) {
      return { synced: false, reason: "no_workspace" };
    }

    const userId = getGatewayPaprProfile().paprUserId;
    if (!userId) {
      return { synced: false, reason: "no_session" };
    }

    const text =
      content.length > MAX_CONTENT_CHARS
        ? content.slice(0, MAX_CONTENT_CHARS)
        : content;

    if (existing?.postId) {
      // UPDATE — beforeSave compares against the stored text and decides
      // whether this is worth a memory write at all.
      const res = await fetch(
        `${PARSE_SERVER_URL}/classes/Post/${existing.postId}`,
        {
          method: "PUT",
          headers: parseHeaders(sessionToken),
          body: JSON.stringify({ text, post_title: input.title }),
        },
      );

      if (res.status === 404) {
        // Post was deleted server-side; fall through and create a new one.
        delete index[sourceKey];
      } else if (!res.ok) {
        console.warn(
          `[documentPostSync] update failed for ${input.documentId}: ${res.status}`,
        );
        return { synced: false, reason: "error" };
      } else {
        index[sourceKey] = {
          postId: existing.postId,
          contentHash,
          updatedAt: new Date().toISOString(),
        };
        saveIndex(index);
        return { synced: true, reason: "updated", postId: existing.postId };
      }
    }

    // CREATE — a new Post always writes a memory (beforeSave sets all flags
    // true for `post.isNew()`).
    const res = await fetch(`${PARSE_SERVER_URL}/classes/Post`, {
      method: "POST",
      headers: parseHeaders(sessionToken),
      body: JSON.stringify({
        text,
        post_title: input.title,
        status: "published",
        user: { __type: "Pointer", className: "_User", objectId: userId },
        workspace: {
          __type: "Pointer",
          className: "WorkSpace",
          objectId: workspaceId,
        },
      }),
    });

    if (!res.ok) {
      console.warn(
        `[documentPostSync] create failed for ${input.documentId}: ${res.status}`,
      );
      return { synced: false, reason: "error" };
    }

    const created = (await res.json()) as { objectId?: string };
    if (!created.objectId) {
      return { synced: false, reason: "error" };
    }

    index[sourceKey] = {
      postId: created.objectId,
      contentHash,
      updatedAt: new Date().toISOString(),
    };
    saveIndex(index);
    return { synced: true, reason: "created", postId: created.objectId };
  } catch (error) {
    console.warn(
      `[documentPostSync] sync failed for ${input.documentId}:`,
      error,
    );
    return { synced: false, reason: "error" };
  }
}

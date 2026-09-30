/**
 * Atomic JSON file writes.
 *
 * Plain `fs.writeFile` truncates the target and streams new bytes in. Two
 * overlapping writers (e.g. updateJobStatus racing a job-config save) can
 * interleave so that a SHORTER payload lands on top of a LONGER previous
 * file, leaving trailing bytes from the old content:
 *
 *   {...valid json...}3784"
 *                     ^^^^^^ leftover tail
 *
 * The result parses as "Unexpected non-whitespace character after JSON",
 * which permanently breaks job.json reads and the code indexer.
 *
 * Writing to a unique temp file in the same directory and renaming is atomic
 * on POSIX: readers observe either the old file or the new one, never a mix.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";

/**
 * Serialize `value` and atomically replace the file at `filePath`.
 */
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  indent = 2,
): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, indent));
}

/**
 * Atomically replace the file at `filePath` with `contents`.
 */
export async function writeFileAtomic(
  filePath: string,
  contents: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto
      .randomBytes(6)
      .toString("hex")}.tmp`,
  );

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, "w");
    await handle.writeFile(contents, "utf8");
    // Flush to disk so a crash between rename and flush cannot leave an
    // empty/partial file in place of valid config.
    await handle.sync();
    await handle.close();
    handle = undefined;

    await fs.rename(tmpPath, filePath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

/**
 * Read and parse JSON, tolerating a corrupted trailing tail from a historic
 * torn write. Returns the parsed value, or undefined when unrecoverable.
 *
 * Recovery only accepts a prefix that parses cleanly — it never guesses at
 * missing data.
 */
export function parseJsonTolerant<T = unknown>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Torn write: valid JSON document followed by garbage. Walk back from the
    // last closing brace/bracket to find a parseable prefix.
    for (let i = raw.length - 1; i > 0; i--) {
      const ch = raw[i];
      if (ch !== "}" && ch !== "]") continue;
      try {
        return JSON.parse(raw.slice(0, i + 1)) as T;
      } catch {
        // keep walking back
      }
    }
    return undefined;
  }
}

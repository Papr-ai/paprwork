/**
 * App files the platform writes itself — never user code.
 *
 * These are rebuilt on each machine before publish (or written server-side), so a
 * different copy on the web never means "newer code" and must not ask the user to
 * pick Mine/Theirs on Get updates.
 *
 * Deliberately narrower than HASH_IGNORED_RELATIVE_SUFFIXES: requirements.json and
 * linked-databases.json carry real collaborator edits and still pull normally.
 */
export const PLATFORM_GENERATED_APP_PATHS: ReadonlySet<string> = new Set([
  "__papr__/app-meta.json",
  "__papr__/platform-catalog.json",
  "backend/bundle.json",
  "data/cloud-repo-head.txt",
  ".papr-cloud-revision",
]);

/** Seeded by the writer when it creates the per-app repo. Only noise while we have no local copy. */
export const WRITER_SCAFFOLD_PATHS: ReadonlySet<string> = new Set(["README.md", ".gitignore"]);

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

export function isPlatformGeneratedAppPath(relativePath: string): boolean {
  return PLATFORM_GENERATED_APP_PATHS.has(norm(relativePath));
}

export function isWriterScaffoldPath(relativePath: string): boolean {
  return WRITER_SCAFFOLD_PATHS.has(norm(relativePath));
}

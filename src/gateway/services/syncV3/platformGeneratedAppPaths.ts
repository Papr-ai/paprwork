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

/**
 * Build output each machine regenerates from source it already has: the
 * bundle (dist/), db.ts (from data-sources.json) and the vendored DB helper.
 * They are still published (the web host serves dist/), but Get updates never
 * compares them — two machines building the same merged source can produce
 * different bytes (different esbuild version, different db ids), and a single
 * bundled file can't be merged line by line. The pull rebuilds them instead.
 */
const LOCALLY_REBUILT_PREFIXES = ["dist/"];
const LOCALLY_REBUILT_FILES: ReadonlySet<string> = new Set(["db.ts", "backend/papr_db.py"]);

export function isLocallyRebuiltAppPath(relativePath: string): boolean {
  const rel = norm(relativePath);
  return LOCALLY_REBUILT_FILES.has(rel) || LOCALLY_REBUILT_PREFIXES.some((p) => rel.startsWith(p));
}

/** Seeded by the writer when it creates the per-app repo. Only noise while we have no local copy. */
export const WRITER_SCAFFOLD_PATHS: ReadonlySet<string> = new Set(["README.md", ".gitignore"]);

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

export function isPlatformGeneratedAppPath(relativePath: string): boolean {
  return PLATFORM_GENERATED_APP_PATHS.has(norm(relativePath));
}

export function isWriterScaffoldPath(relativePath: string): boolean {
  return WRITER_SCAFFOLD_PATHS.has(norm(relativePath));
}

/**
 * Rewrite machine-specific Papr job paths in agent prompts to portable env vars.
 * Used by built-in platform jobs (Sleep, Wiki Writer) and job architecture validation.
 */
export function normalizePortableJobPrompt(text: string): string {
  return text
    .replace(/~\/Papr\/jobs\//gi, "$PAPR_HOME/Jobs/")
    .replace(/\/Users\/[^\s"'`]+?\/Papr\/jobs\//gi, "$PAPR_HOME/Jobs/")
    .replace(/~\/Papr\/Jobs\//g, "$PAPR_HOME/Jobs/")
    .replace(/\/Users\/[^\s"'`]+?\/Papr\/Jobs\//g, "$PAPR_HOME/Jobs/");
}

/**
 * Rewrite machine-specific Papr job paths in agent prompts to portable env vars.
 * Used by built-in platform jobs (Sleep, Wiki Writer) and job architecture validation.
 */
export function normalizePortableJobPrompt(text: string): string {
  return text
    .replace(/~\/Papr\/jobs\//gi, "$PAPR_HOME/Jobs/")
    .replace(/\/Users\/[^\s"'`]+?\/Papr\/jobs\//gi, "$PAPR_HOME/Jobs/")
    .replace(/~\/Papr\/Jobs\//g, "$PAPR_HOME/Jobs/")
    .replace(/\/Users\/[^\s"'`]+?\/Papr\/Jobs\//g, "$PAPR_HOME/Jobs/")
    .replace(/~\/Papr\/workspace\//g, "$PAPR_HOME/workspace/")
    .replace(/\/Users\/[^\s"'`]+?\/Papr\/workspace\//g, "$PAPR_HOME/workspace/")
    .replace(/~\/Papr\/Chats\//g, "$PAPR_HOME/Chats/")
    .replace(/\/Users\/[^\s"'`]+?\/Papr\/Chats\//g, "$PAPR_HOME/Chats/")
    .replace(/~\/\.paprwork-v2\//g, "$PAPR_USER_DATA/")
    .replace(/\/Users\/[^\s"'`]+?\/\.paprwork-v2\//g, "$PAPR_USER_DATA/");
}

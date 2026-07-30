/**
 * Rewrite machine-specific Papr job paths in agent prompts to portable env vars.
 * Used by built-in platform jobs (Sleep, Wiki Writer) and job architecture validation.
 */
export function normalizePortableJobPrompt(text: string): string {
  return text
    .replace(/\$HOME\/Papr\/jobs\//gi, "$PAPR_HOME/Jobs/")
    .replace(/\$HOME\/Papr\/Jobs\//g, "$PAPR_HOME/Jobs/")
    .replace(/\$HOME\/Papr\/data\//g, "$PAPR_HOME/data/")
    .replace(/\$HOME\/Papr\/apps\//g, "$PAPR_HOME/apps/")
    .replace(/\$HOME\/Papr\/workspace\//g, "$PAPR_HOME/workspace/")
    .replace(/\$HOME\/Papr\/Chats\//g, "$PAPR_HOME/Chats/")
    .replace(/~\/Papr\/jobs\//gi, "$PAPR_HOME/Jobs/")
    .replace(/\/Users\/[^\s"'`]+?\/Papr\/jobs\//gi, "$PAPR_HOME/Jobs/")
    .replace(/~\/Papr\/Jobs\//g, "$PAPR_HOME/Jobs/")
    .replace(/\/Users\/[^\s"'`]+?\/Papr\/Jobs\//g, "$PAPR_HOME/Jobs/")
    .replace(/~\/Papr\/data\//g, "$PAPR_HOME/data/")
    .replace(/\/Users\/[^\s"'`]+?\/Papr\/data\//g, "$PAPR_HOME/data/")
    .replace(/~\/Papr\/apps\//g, "$PAPR_HOME/apps/")
    .replace(/\/Users\/[^\s"'`]+?\/Papr\/apps\//g, "$PAPR_HOME/apps/")
    .replace(
      /\/Users\/[^\s"'`]+?\/Papr\/orgs\/[^/\s"'`]+?\/namespaces\/[^/\s"'`]+?\//g,
      "$PAPR_HOME/",
    )
    .replace(/~\/Papr\/workspace\//g, "$PAPR_HOME/workspace/")
    .replace(/\/Users\/[^\s"'`]+?\/Papr\/workspace\//g, "$PAPR_HOME/workspace/")
    .replace(/~\/Papr\/Chats\//g, "$PAPR_HOME/Chats/")
    .replace(/\/Users\/[^\s"'`]+?\/Papr\/Chats\//g, "$PAPR_HOME/Chats/")
    .replace(/~\/\.paprwork-v2\//g, "$PAPR_USER_DATA/")
    .replace(/\/Users\/[^\s"'`]+?\/\.paprwork-v2\//g, "$PAPR_USER_DATA/");
}

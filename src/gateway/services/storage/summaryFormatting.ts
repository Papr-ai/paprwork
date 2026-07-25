/**
 * Shared helpers for Papr /compress summary persistence and LLM injection.
 */

export interface SummaryFileOperations {
  read?: string[];
  modified?: Array<{ path: string; description: string }>;
  created?: string[];
  deleted?: string[];
}

export interface SummaryProjectContext {
  project_name?: string;
  project_id?: string;
  project_path?: string;
  tech_stack?: string[];
  current_task?: string;
  git_repo?: string;
}

export interface SummaryEnhancedFields {
  session_intent?: string;
  key_decisions?: string[];
  current_state?: string;
  next_steps?: string[];
  technical_details?: string[];
  files_accessed?: SummaryFileOperations;
  project_context?: SummaryProjectContext;
}

export interface SummaryTierFields {
  short_term: string;
  medium_term: string;
  long_term: string;
  topics: string[];
  last_updated: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}

function parseFileOperations(value: unknown): SummaryFileOperations | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const read = asStringArray(value.read);
  const created = asStringArray(value.created);
  const deleted = asStringArray(value.deleted);

  let modified: SummaryFileOperations["modified"];
  if (Array.isArray(value.modified)) {
    modified = value.modified
      .filter(isRecord)
      .map((item) => ({
        path: asString(item.path) ?? "",
        description: asString(item.description) ?? "",
      }))
      .filter((item) => item.path.length > 0);
    if (modified.length === 0) {
      modified = undefined;
    }
  }

  if (!read && !created && !deleted && !modified) {
    return undefined;
  }

  return { read, modified, created, deleted };
}

function parseProjectContext(value: unknown): SummaryProjectContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const context: SummaryProjectContext = {
    project_name: asString(value.project_name),
    project_id: asString(value.project_id),
    project_path: asString(value.project_path),
    tech_stack: asStringArray(value.tech_stack),
    current_task: asString(value.current_task),
    git_repo: asString(value.git_repo),
  };

  const hasValue = Object.values(context).some((field) => {
    if (Array.isArray(field)) {
      return field.length > 0;
    }
    return field !== undefined;
  });

  return hasValue ? context : undefined;
}

/** Extract enhanced fields from /compress response or nested summaries object. */
export function extractEnhancedFields(response: unknown): SummaryEnhancedFields | undefined {
  if (!isRecord(response)) {
    return undefined;
  }

  const enhancedRoot = isRecord(response.enhanced_fields)
    ? response.enhanced_fields
    : undefined;
  const summaries = isRecord(response.summaries) ? response.summaries : undefined;

  const pick = (key: keyof SummaryEnhancedFields): unknown =>
    enhancedRoot?.[key] ?? summaries?.[key];

  const enhanced: SummaryEnhancedFields = {
    session_intent: asString(pick("session_intent")),
    key_decisions: asStringArray(pick("key_decisions")),
    current_state: asString(pick("current_state")),
    next_steps: asStringArray(pick("next_steps")),
    technical_details: asStringArray(pick("technical_details")),
    files_accessed: parseFileOperations(pick("files_accessed")),
    project_context: parseProjectContext(pick("project_context")),
  };

  const hasValue = Object.values(enhanced).some((field) => {
    if (Array.isArray(field)) {
      return field.length > 0;
    }
    if (isRecord(field)) {
      return Object.keys(field).length > 0;
    }
    return field !== undefined;
  });

  return hasValue ? enhanced : undefined;
}

export function serializeEnhancedFields(
  enhanced?: SummaryEnhancedFields,
): string | null {
  if (!enhanced) {
    return null;
  }
  return JSON.stringify(enhanced);
}

export function deserializeEnhancedFields(
  raw: string | null | undefined,
): SummaryEnhancedFields | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return extractEnhancedFields({ enhanced_fields: JSON.parse(raw) });
  } catch {
    return undefined;
  }
}

function formatEnhancedFieldsBlock(enhanced: SummaryEnhancedFields): string {
  const sections: string[] = ["", "STRUCTURED SESSION DETAILS:", ""];

  if (enhanced.session_intent) {
    sections.push(`SESSION INTENT: ${enhanced.session_intent}`, "");
  }

  if (enhanced.current_state) {
    sections.push(`CURRENT STATE: ${enhanced.current_state}`, "");
  }

  if (enhanced.key_decisions && enhanced.key_decisions.length > 0) {
    sections.push(
      "KEY DECISIONS:",
      ...enhanced.key_decisions.map((decision) => `- ${decision}`),
      "",
    );
  }

  if (enhanced.next_steps && enhanced.next_steps.length > 0) {
    sections.push(
      "NEXT STEPS:",
      ...enhanced.next_steps.map((step) => `- ${step}`),
      "",
    );
  }

  if (enhanced.technical_details && enhanced.technical_details.length > 0) {
    sections.push(
      "TECHNICAL DETAILS:",
      ...enhanced.technical_details.map((detail) => `- ${detail}`),
      "",
    );
  }

  if (enhanced.files_accessed) {
    const files = enhanced.files_accessed;
    sections.push("FILES ACCESSED:");
    if (files.read && files.read.length > 0) {
      sections.push(`  Read: ${files.read.join(", ")}`);
    }
    if (files.modified && files.modified.length > 0) {
      sections.push(
        "  Modified:",
        ...files.modified.map(
          (file) => `    - ${file.path}: ${file.description}`,
        ),
      );
    }
    if (files.created && files.created.length > 0) {
      sections.push(`  Created: ${files.created.join(", ")}`);
    }
    if (files.deleted && files.deleted.length > 0) {
      sections.push(`  Deleted: ${files.deleted.join(", ")}`);
    }
    sections.push("");
  }

  if (enhanced.project_context) {
    const project = enhanced.project_context;
    sections.push("PROJECT CONTEXT:");
    if (project.project_name) {
      sections.push(`  Name: ${project.project_name}`);
    }
    if (project.project_path) {
      sections.push(`  Path: ${project.project_path}`);
    }
    if (project.current_task) {
      sections.push(`  Current task: ${project.current_task}`);
    }
    if (project.tech_stack && project.tech_stack.length > 0) {
      sections.push(`  Tech stack: ${project.tech_stack.join(", ")}`);
    }
    if (project.git_repo) {
      sections.push(`  Git repo: ${project.git_repo}`);
    }
    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

export function formatSummaryForLLM(params: {
  tiers: SummaryTierFields;
  enhanced?: SummaryEnhancedFields;
  chatFilePath: string;
}): string {
  const { tiers, enhanced, chatFilePath } = params;
  const enhancedBlock = enhanced ? formatEnhancedFieldsBlock(enhanced) : "";

  return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 ARCHIVED CONVERSATION SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Earlier messages in this chat have been compressed into the summary below.
Recent messages follow after this block in the conversation history.

Full conversation export: ${chatFilePath}
For details not in the summary, search this chat: search_agent_memory({ query: "...", chatId: "current_chat" }).
You can also grep/read the export file above.

───────────────────────────────────────────────────────────

FULL SESSION SUMMARY:
${tiers.long_term}

RECENT CONTEXT (last ~100 messages):
${tiers.medium_term}

CURRENT BATCH (last 15 messages):
${tiers.short_term}

KEY TOPICS: ${tiers.topics?.join(", ") || "N/A"}
${enhancedBlock ? `\n${enhancedBlock}\n` : ""}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

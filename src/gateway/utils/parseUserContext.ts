/**
 * Fetch structured goals/OKRs and use cases from Parse Server classes.
 * Requires PAPR_SESSION_TOKEN (user-scoped ACL).
 */

const PARSE_SERVER_URL =
  process.env.PARSE_SERVER_URL || "https://server.papr.ai/parse";
const PARSE_APP_ID =
  process.env.PARSE_APP_ID || "671e705a-f735-4ec0-8474-15899a475440";

export const MAX_PARSE_GOALS = 10;
export const MAX_PARSE_USECASES = 10;
export const MAX_PARSE_FIELD_CHARS = 400;
export const MAX_PARSE_BLOCK_CHARS = 3500;

export const GOALS_OKRS_PREFIX = "[USER GOALS & OKRs";
export const USE_CASES_PREFIX = "[USER USE CASES";

interface ParseQueryResponse<T> {
  results?: T[];
}

export interface ParseGoalRecord {
  objectId: string;
  title?: string;
  description?: string;
  keyResults?: ParseKeyResult[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ParseUsecaseRecord {
  objectId: string;
  name?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

type ParseKeyResult =
  | string
  | {
      title?: string;
      name?: string;
      description?: string;
      text?: string;
    };

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.substring(0, maxChars)}...`;
}

function formatKeyResult(kr: ParseKeyResult): string {
  if (typeof kr === "string") {
    return truncateText(kr.trim(), MAX_PARSE_FIELD_CHARS);
  }
  const label = kr.title ?? kr.name ?? kr.text ?? kr.description ?? "";
  if (label.trim()) {
    return truncateText(label.trim(), MAX_PARSE_FIELD_CHARS);
  }
  return truncateText(JSON.stringify(kr), MAX_PARSE_FIELD_CHARS);
}

function formatUpdatedAt(updatedAt?: string): string | null {
  if (!updatedAt) {
    return null;
  }
  const parsed = Date.parse(updatedAt);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

async function queryParseClassForUser<T extends { objectId: string }>(
  className: string,
  sessionToken: string,
  userId: string,
  limit: number,
  keys: string,
): Promise<T[]> {
  const where = {
    user: {
      __type: "Pointer",
      className: "_User",
      objectId: userId,
    },
  };

  const url = new URL(`${PARSE_SERVER_URL}/classes/${className}`);
  url.searchParams.set("where", JSON.stringify(where));
  url.searchParams.set("order", "-updatedAt");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("keys", keys);

  const response = await fetch(url.toString(), {
    headers: {
      "X-Parse-Application-Id": PARSE_APP_ID,
      "X-Parse-Session-Token": sessionToken,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Parse ${className} query failed: ${response.status} ${text.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as ParseQueryResponse<T>;
  return data.results ?? [];
}

export async function fetchParseGoalsForUser(
  sessionToken: string,
  userId: string,
  limit: number = MAX_PARSE_GOALS,
): Promise<ParseGoalRecord[]> {
  return queryParseClassForUser<ParseGoalRecord>(
    "Goal",
    sessionToken,
    userId,
    limit,
    "title,description,keyResults,createdAt,updatedAt",
  );
}

export async function fetchParseUsecasesForUser(
  sessionToken: string,
  userId: string,
  limit: number = MAX_PARSE_USECASES,
): Promise<ParseUsecaseRecord[]> {
  return queryParseClassForUser<ParseUsecaseRecord>(
    "Usecase",
    sessionToken,
    userId,
    limit,
    "name,description,createdAt,updatedAt",
  );
}

export function formatGoalsOkrsBlock(
  goals: ParseGoalRecord[],
): string | undefined {
  if (goals.length === 0) {
    return undefined;
  }

  const lines: string[] = [];

  for (const goal of goals) {
    const title = goal.title?.trim() || "Untitled goal";
    const updated = formatUpdatedAt(goal.updatedAt);
    const heading = updated
      ? `**Goal: ${title}** (updated ${updated})`
      : `**Goal: ${title}**`;
    lines.push(heading);

    if (goal.description?.trim()) {
      lines.push(truncateText(goal.description.trim(), MAX_PARSE_FIELD_CHARS));
    }

    if (goal.keyResults && goal.keyResults.length > 0) {
      lines.push("Key Results:");
      for (const kr of goal.keyResults) {
        lines.push(`- ${formatKeyResult(kr)}`);
      }
    }

    lines.push("");
  }

  let body = lines.join("\n").trim();
  if (body.length > MAX_PARSE_BLOCK_CHARS) {
    body = `${body.substring(0, MAX_PARSE_BLOCK_CHARS)}\n[... truncated]`;
  }

  return `${GOALS_OKRS_PREFIX} — from Papr Parse Goal class; sorted by most recently updated]

${body}

Align your assistance with these goals when relevant.`;
}

export function formatUseCasesBlock(
  usecases: ParseUsecaseRecord[],
): string | undefined {
  if (usecases.length === 0) {
    return undefined;
  }

  const lines: string[] = [];

  for (const usecase of usecases) {
    const name = usecase.name?.trim() || "Untitled use case";
    const updated = formatUpdatedAt(usecase.updatedAt);
    const heading = updated
      ? `**${name}** (updated ${updated})`
      : `**${name}**`;
    lines.push(heading);

    if (usecase.description?.trim()) {
      lines.push(truncateText(usecase.description.trim(), MAX_PARSE_FIELD_CHARS));
    }

    lines.push("");
  }

  let body = lines.join("\n").trim();
  if (body.length > MAX_PARSE_BLOCK_CHARS) {
    body = `${body.substring(0, MAX_PARSE_BLOCK_CHARS)}\n[... truncated]`;
  }

  return `${USE_CASES_PREFIX} — from Papr Parse Usecase class; sorted by most recently updated]

${body}

These describe how the user applies Papr — use when planning workflows or features.`;
}

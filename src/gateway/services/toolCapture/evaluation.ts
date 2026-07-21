import { createHash } from "node:crypto";
import {
  CAPTURE_EXCLUDED_KEY_NAMES,
  MIN_CAPTURE_CHARS,
} from "./constants.js";

export interface CaptureEvaluationInput {
  originalCommand: string;
  stdout: string;
  listedKeyNames: string[];
}

export interface CaptureEvaluationResult {
  keysUsed: string[];
  inferredLabel: string;
  contentDate: string;
  stableEntityId?: string;
  dedupKey: string;
  contentHash: string;
  inferredSubject?: string;
}

export function extractUsedListedKeys(
  command: string,
  listedKeyNames: string[],
): string[] {
  const used: string[] = [];
  for (const name of listedKeyNames) {
    if (CAPTURE_EXCLUDED_KEY_NAMES.has(name)) {
      continue;
    }
    if (command.includes(`\${${name}}`)) {
      used.push(name);
    }
  }
  return used.sort();
}

export function deriveLabelFromKeyNames(keyNames: string[]): string {
  if (keyNames.length === 0) {
    return "custom_key";
  }
  const prefixes = keyNames
    .map((name) => name.split("_")[0])
    .filter((prefix) => prefix.length > 0);
  if (
    prefixes.length > 0 &&
    prefixes.every((prefix) => prefix === prefixes[0])
  ) {
    return prefixes[0]!.toLowerCase();
  }
  return keyNames[0]!.toLowerCase();
}

function normalizeBodyForHash(body: string): string {
  return body.replace(/\r\n/g, "\n").trim();
}

export function computeContentHash(body: string): string {
  return createHash("sha256")
    .update(normalizeBodyForHash(body), "utf8")
    .digest("hex");
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export function parseStableEntityId(body: string): string | undefined {
  const record = parseJsonRecord(body);
  if (!record) {
    return undefined;
  }
  const candidates = [
    "meeting_instance_id",
    "meeting_id",
    "instance_id",
    "uuid",
    "id",
  ];
  for (const field of candidates) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return undefined;
}

export function parseContentDate(body: string): string {
  const record = parseJsonRecord(body);
  if (record) {
    for (const field of ["start_time", "startTime", "date", "created_at"]) {
      const value = record[field];
      if (typeof value === "string") {
        const dateMatch = value.match(/\d{4}-\d{2}-\d{2}/);
        if (dateMatch) {
          return dateMatch[0];
        }
      }
    }
  }
  const inlineDate = body.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (inlineDate) {
    return inlineDate[1]!;
  }
  return new Date().toISOString().slice(0, 10);
}

export function parseInferredSubject(body: string): string | undefined {
  const record = parseJsonRecord(body);
  if (record) {
    for (const field of ["topic", "title", "name", "subject", "meeting_topic"]) {
      const value = record[field];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim().slice(0, 200);
      }
    }
  }
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine && firstLine.length <= 200) {
    return firstLine;
  }
  return undefined;
}

export function isAuthOnlyResult(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length >= 800) {
    return false;
  }
  const record = parseJsonRecord(trimmed);
  if (!record) {
    return false;
  }
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return false;
  }
  const authFields = new Set([
    "access_token",
    "token",
    "expires_in",
    "token_type",
    "scope",
    "refresh_token",
  ]);
  return keys.every((key) => authFields.has(key));
}

export function isSubstantiveCaptureBody(body: string): boolean {
  return normalizeBodyForHash(body).length >= MIN_CAPTURE_CHARS;
}

export function computeDedupKey(input: {
  inferredLabel: string;
  contentDate: string;
  stableEntityId?: string;
}): string {
  const parts = [
    input.inferredLabel,
    input.contentDate,
    input.stableEntityId ?? "",
  ];
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

export function evaluateBashCapture(
  input: CaptureEvaluationInput,
): CaptureEvaluationResult | null {
  const keysUsed = extractUsedListedKeys(
    input.originalCommand,
    input.listedKeyNames,
  );
  if (keysUsed.length === 0) {
    return null;
  }

  const body = input.stdout.trim();
  if (!isSubstantiveCaptureBody(body) || isAuthOnlyResult(body)) {
    return null;
  }

  const inferredLabel = deriveLabelFromKeyNames(keysUsed);
  const contentDate = parseContentDate(body);
  const stableEntityId = parseStableEntityId(body);
  const inferredSubject = parseInferredSubject(body);
  const contentHash = computeContentHash(body);
  const dedupKey = computeDedupKey({
    inferredLabel,
    contentDate,
    stableEntityId,
  });

  return {
    keysUsed,
    inferredLabel,
    contentDate,
    stableEntityId,
    dedupKey,
    contentHash,
    inferredSubject,
  };
}

export function formatCaptureMemoryBody(
  evaluation: CaptureEvaluationResult,
  body: string,
  chatId: string,
  maxChars: number,
): string {
  const subjectPart = evaluation.inferredSubject
    ? ` — ${evaluation.inferredSubject}`
    : "";
  const header = [
    `[Tool capture — ${evaluation.inferredLabel}${subjectPart} — ${evaluation.contentDate}]`,
    `API keys: ${evaluation.keysUsed.join(", ")}`,
    `Chat: ${chatId}`,
    "",
  ].join("\n");

  const truncated =
    body.length > maxChars
      ? `${body.slice(0, maxChars)}\n\n[... ${body.length - maxChars} chars truncated in memory copy; full body in local tool capture ledger]`
      : body;

  return `${header}---\n${truncated}`;
}

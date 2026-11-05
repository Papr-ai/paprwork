/**
 * Publish / propose errors, as a person reads them.
 *
 * The gateway's messages are written for Pen (tool names, file paths). The
 * propose sheet shows a short plain message, keeps the full text behind
 * "View full error", and offers "Ask Pen to fix this" with the full text.
 */

export interface ProposeErrorDisplay {
  /** One or two plain sentences. */
  message: string;
  /** Full original text, when it says more than `message`. */
  detail?: string;
  /** Pen can usually fix this one (offer the button prominently). */
  fixableByPen: boolean;
}

const MIGRATION_NEVER_RAN = /These migration files never ran on this copy's database:\s*([^]*?)\.\s+Apply them/;
const LEDGER_UNREADABLE = /Couldn't read this copy's migration ledger/;

/** `databases/x/migrations/0012_2026…_certification.sql` → `certification`. */
export function migrationLabel(path: string): string {
  const file = path.trim().split("/").pop() ?? path;
  return file.replace(/\.sql$/, "").replace(/^\d+_(\d{14}_)?/, "") || file;
}

/** Cut at a word boundary so the message never ends mid-word ("Apply them (papr_"). */
export function shorten(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:(]+$/, "")}…`;
}

export function describeProposeError(raw: string): ProposeErrorDisplay {
  const text = (raw ?? "").trim() || "Something went wrong.";

  const never = MIGRATION_NEVER_RAN.exec(text);
  if (never) {
    const names = never[1]
      .split(",")
      .map((p) => migrationLabel(p))
      .filter(Boolean);
    const list = names.length > 0 ? ` (${names.join(", ")})` : "";
    return {
      message:
        `Your edits include a database change${list} that hasn't been set up on your copy yet, ` +
        "so it can't go to the team untested. Pen can set it up, check it, and publish again.",
      detail: text,
      fixableByPen: true,
    };
  }
  if (LEDGER_UNREADABLE.test(text)) {
    return {
      message: "Couldn't check your copy's database before publishing. Pen can look into it.",
      detail: text,
      fixableByPen: true,
    };
  }

  const message = shorten(text);
  return { message, ...(message !== text ? { detail: text } : {}), fixableByPen: true };
}

/** Prompt for "Ask Pen to fix this": the full error plus what to do for known cases. */
export function buildProposeFailureAgentPrompt(input: {
  appId: string;
  appTitle?: string;
  error: string;
  publishNow: boolean;
}): string {
  const action = input.publishNow ? "Publish now" : "Send for review";
  const parts = [
    `Help me fix this error from "${action}" on my copy of ${input.appTitle ? `"${input.appTitle}"` : "a team app"}.`,
    `App id: ${input.appId}.`,
    `Error: ${input.error.trim()}`,
  ];
  if (MIGRATION_NEVER_RAN.test(input.error)) {
    parts.push(
      "For each listed migration file: apply it to this copy's database with papr_db_apply_migration",
      "(if it fails because the table already exists, make the statements IF NOT EXISTS first, never edit an applied migration),",
      "then check the screens that use it work.",
    );
  } else {
    parts.push("Use get_cloud_sync_status and get_cloud_app_publish to find the cause.");
  }
  parts.push(
    `Then send it again with submit_cloud_app_pr${input.publishNow ? " ({ publishNow: true })" : ""}.`,
    "Tell me what was wrong and what you changed.",
  );
  return parts.join(" ");
}

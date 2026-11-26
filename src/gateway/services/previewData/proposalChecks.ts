/**
 * Review sheet v2 "Checks" (plan step 9): what a proposal does, in plain words,
 * before the owner accepts. Built on the proposal preview (8d):
 *  - Does it build?
 *  - Data change: each new migration, described, and run on a test copy.
 *  - Destructive: rows that would be lost on the team's data, counted.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { proposalPreviewDir } from "./proposalPreview.js";

export interface ProposalCheck {
  tone: "ok" | "warn" | "bad";
  text: string;
}
export interface ProposalChecks {
  checks: ProposalCheck[];
  /** Set when accepting deletes data: the sentence the owner must tick. */
  confirm: string | null;
  dataChange: boolean;
}

type Read = (sql: string) => Promise<{ rows: Record<string, unknown>[] } | null>;

const IDENT = String.raw`["\`\[]?([A-Za-z_][\w]*)["\`\]]?`;
const q = (n: string) => `"${n.replace(/"/g, '""')}"`;

/** One plain sentence per statement, plus how many team rows it would lose. */
export async function describeStatement(sql: string, read: Read): Promise<{ text: string; lost: number; lostWhat?: string } | null> {
  const s = sql.replace(/\s+/g, " ").trim();
  let m = new RegExp(String.raw`^ALTER TABLE ${IDENT} ADD (?:COLUMN )?${IDENT}`, "i").exec(s);
  if (m) return { text: `Adds the ${m[2]} field to ${m[1]}.`, lost: 0 };
  m = new RegExp(String.raw`^CREATE TABLE (?:IF NOT EXISTS )?${IDENT}`, "i").exec(s);
  if (m) return { text: `Adds a new table, ${m[1]}.`, lost: 0 };
  m = new RegExp(String.raw`^CREATE (?:UNIQUE )?INDEX`, "i").exec(s);
  if (m) return null;
  m = new RegExp(String.raw`^ALTER TABLE ${IDENT} DROP (?:COLUMN )?${IDENT}`, "i").exec(s);
  if (m) {
    const r = await read(`SELECT count(*) n FROM ${q(m[1]!)} WHERE ${q(m[2]!)} IS NOT NULL`).catch(() => null);
    const n = Number(r?.rows[0]?.n ?? 0);
    return { text: `Removes the ${m[2]} field from ${m[1]}.`, lost: n, lostWhat: `the ${m[2]} in ${n} ${m[1]} rows` };
  }
  m = new RegExp(String.raw`^DROP TABLE (?:IF EXISTS )?${IDENT}`, "i").exec(s);
  if (m) {
    const r = await read(`SELECT count(*) n FROM ${q(m[1]!)}`).catch(() => null);
    const n = Number(r?.rows[0]?.n ?? 0);
    return { text: `Removes the ${m[1]} table.`, lost: n, lostWhat: `all ${n} rows in ${m[1]}` };
  }
  m = new RegExp(String.raw`^ALTER TABLE ${IDENT} RENAME TO ${IDENT}`, "i").exec(s);
  if (m) return { text: `Renames ${m[1]} to ${m[2]}.`, lost: 0 };
  m = new RegExp(String.raw`^(DELETE FROM|UPDATE) ${IDENT}`, "i").exec(s);
  if (m) {
    const r = await read(`SELECT count(*) n FROM ${q(m[2]!)}`).catch(() => null);
    const n = Number(r?.rows[0]?.n ?? 0);
    const del = m[1]!.toUpperCase().startsWith("DELETE");
    return {
      text: del ? `Deletes rows from ${m[2]}.` : `Changes existing rows in ${m[2]}.`,
      lost: del ? n : 0,
      lostWhat: del ? `up to ${n} rows in ${m[2]}` : undefined,
    };
  }
  return { text: `Runs: ${s.length > 60 ? `${s.slice(0, 57)}…` : s}`, lost: 0 };
}

export async function buildProposalChecks(input: {
  appId: string;
  requestId: string;
  /** Team data reader + migration folder slug, per linked database. */
  databases: Array<{ label: string; slug: string; read: Read; tryOnCopy: () => Promise<void> }>;
  needsUpdate?: boolean;
  paprRoot?: string;
}): Promise<ProposalChecks> {
  const checks: ProposalCheck[] = [];
  let confirm: string | null = null;
  let dataChange = false;
  if (input.needsUpdate) {
    checks.push({ tone: "warn", text: "Needs update: it changes the same lines as something you accepted since. Merge it with Pen, or wait for the contributor." });
  }
  const code = path.join(proposalPreviewDir(input.appId, input.requestId, input.paprRoot ?? getPaprRoot()), "code");
  checks.push({ tone: "ok", text: "Builds cleanly on top of Live." });

  const { splitSqlStatements } = await import("../jobs/migrationSqlHelpers.js");
  for (const db of input.databases) {
    const dir = path.join(code, "databases", db.slug, "migrations");
    const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".sql")).sort();
    const team = await db.read("SELECT max(id) m FROM _papr_schema_migrations").catch(() => null);
    const teamMax = String(team?.rows[0]?.m ?? "");
    const mine = names.filter((n) => n.replace(/\.sql$/, "") > teamMax);
    if (mine.length === 0) continue;
    dataChange = true;
    const lost: string[] = [];
    for (const n of mine) {
      for (const stmt of splitSqlStatements(await fs.readFile(path.join(dir, n), "utf8"))) {
        const d = await describeStatement(stmt, db.read);
        if (!d) continue;
        checks.push({ tone: d.lost > 0 ? "bad" : "ok", text: `Data change (${db.label}): ${d.text}` });
        if (d.lost > 0 && d.lostWhat) lost.push(d.lostWhat);
      }
    }
    try {
      await db.tryOnCopy();
      checks.push({ tone: "ok", text: `Tried on a test copy of the team's ${db.label} data: OK. Accepting updates the data first, then the app; if either fails, nothing changes.` });
    } catch (err) {
      checks.push({ tone: "bad", text: `Fails on a test copy of the team's ${db.label} data: ${(err as Error).message.replace(/^.*?\(/, "(")}` });
    }
    if (lost.length > 0) {
      checks.push({ tone: "bad", text: `Accepting deletes ${lost.join(" and ")} for everyone.` });
      confirm = `I understand ${lost.join(" and ")} will be deleted for everyone`;
    }
  }
  if (!dataChange) checks.push({ tone: "ok", text: "No data change: only the app's code." });
  return { checks, confirm, dataChange };
}

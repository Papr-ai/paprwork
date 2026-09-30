#!/usr/bin/env node
/**
 * Live-validate GraphQL + memory search queries used in SLEEP.md / WIKI_WRITER.md.
 *
 * Usage:
 *   PAPR_API_KEY=sk-... node scripts/validate-sleep-wiki-queries.mjs
 *   npm run test:sleep-wiki-queries   # loads .env.local if PAPR_API_KEY set
 */

import { config } from "dotenv";
import { join } from "path";
import Papr from "@papr/memory";
import { resolveMemoryAccess } from "./lib/testEnv.mjs";

config({ path: join(process.cwd(), ".env.local") });

/** @typedef {{ label: string; query: string; expect?: "pass" | "fail" }} GraphQLCase */
/** @typedef {{ label: string; query: string }} SearchCase */

/** @type {GraphQLCase[]} */
const GRAPHQL_CASES = [
  // --- NEW (prompt v14 / v5) ---
  {
    label: "people list (id name only — safe bulk)",
    query: "{ people(limit: 20) { id name } }",
    expect: "pass",
  },
  {
    label: "companies list (no industry, no nested employees)",
    query: "{ companies(limit: 20) { id name domain description } }",
    expect: "pass",
  },
  {
    label: "projects list (id name, limit 15)",
    query: "{ projects(limit: 15) { id name } }",
    expect: "pass",
  },
  {
    label: "person by id eq",
    query:
      '{ people(where: { id: { eq: "person_placeholder" } }) { id name role worksAtCompany { id name } } }',
    expect: "pass",
  },
  {
    label: "company by id eq",
    query:
      '{ companies(where: { id: { eq: "company_placeholder" } }) { id name employeesPerson { id name role } } }',
    expect: "pass",
  },
  // --- OLD (known broken in production) ---
  {
    label: "OLD people (first + title + updated_at sort)",
    query:
      "{ people(sort: [{ updated_at: DESC }], first: 20) { id name updated_at title description worksAtCompany { id name } } }",
    expect: "fail",
  },
  {
    label: "OLD companies (first + title on employees)",
    query:
      "{ companies(sort: [{ updated_at: DESC }], first: 20) { id name updated_at domain industry description employeesPerson { id name title } } }",
    expect: "fail",
  },
  {
    label: "OLD company name_CONTAINS filter",
    query: '{ companies(where: { name_CONTAINS: "TestCo" }) { id name } }',
    expect: "fail",
  },
  // --- Codebase still uses first in Wiki home rails ---
  {
    label: "Wiki home people(first) — codebase pattern (informational)",
    query: "{ people(first: 12) { id name role description updated_at } }",
  },
];

/** @type {SearchCase[]} */
const SEARCH_CASES = [
  {
    label: "Sleep entity sweep",
    query:
      "people companies projects organizations stakeholders that came up recently in chats jobs or meetings",
  },
  {
    label: "Wiki name lookup fallback",
    query: "Everything about a company — context, decisions, history, relationships",
  },
];

function section(title) {
  console.log(`\n=== ${title} ===`);
}

/**
 * @param {unknown} response
 * @returns {{ ok: boolean; rows: number; errors: string[] }}
 */
function summarizeGraphQL(response) {
  const typed = /** @type {{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }} */ (
    response
  );
  const errors = (typed.errors ?? []).map((e) => e.message);
  let rows = 0;
  if (typed.data) {
    for (const value of Object.values(typed.data)) {
      if (Array.isArray(value)) rows += value.length;
    }
  }
  // Partial data is OK when corrupt graph nodes cause field-level errors (common on people.role)
  const ok = errors.length === 0 || rows > 0;
  return { ok, rows, errors, hardFail: errors.length > 0 && rows === 0 };
}

async function main() {
  const access = await resolveMemoryAccess();
  const apiKey =
    access?.mode === "direct"
      ? access.apiKey
      : process.env.PAPR_API_KEY?.trim() ?? null;
  const baseURL =
    access?.mode === "direct"
      ? access.memoryBase
      : process.env.PAPR_BASE_URL || "https://memory.papr.ai";

  section("Config");
  console.log("Base URL:", baseURL);
  console.log(
    "API key:",
    apiKey
      ? `${apiKey.slice(0, 24)}… (${access?.source ?? "env"})`
      : access?.mode === "gateway"
        ? `via gateway ${access.gatewayBase}`
        : "MISSING — set PAPR_API_KEY or login via Papr Work",
  );

  if (!apiKey) {
    console.error(
      "\nSet PAPR_API_KEY in env/.env.local or sign in via Papr Work (keychain).",
    );
    process.exit(1);
  }

  const client = new Papr({ xAPIKey: apiKey, baseURL, maxRetries: 0, timeout: 30000 });

  section("GraphQL queries");
  let pass = 0;
  let fail = 0;
  let unexpected = 0;

  for (const testCase of GRAPHQL_CASES) {
    try {
      const raw = await client.graphql.query({ body: { query: testCase.query } });
      const { ok, rows, errors, hardFail } = summarizeGraphQL(raw);
      const informational = testCase.expect === undefined;
      const expectedPass = testCase.expect !== "fail";
      const matched = informational ? true : expectedPass ? !hardFail : hardFail;

      if (matched && !informational) pass++;
      else if (!informational) unexpected++;

      const status = informational ? "INFO" : matched ? "OK" : "UNEXPECTED";
      console.log(
        `[${status}] ${testCase.label}: errors=${errors.length} rows=${rows}${testCase.expect === "fail" ? " (expected fail)" : ""}`,
      );
      if (errors.length > 0) {
        console.log("       ", errors.slice(0, 3).join(" | ").slice(0, 200));
      }
      if (!informational && !matched) {
        console.log(
          `       expected ${expectedPass ? "pass" : "fail"}, got ${ok ? "pass" : "fail"}`,
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const expectedFail = testCase.expect === "fail";
      if (expectedFail) {
        pass++;
        console.log(`[OK] ${testCase.label}: HTTP error (expected fail) — ${msg.slice(0, 120)}`);
      } else {
        unexpected++;
        console.log(`[UNEXPECTED] ${testCase.label}: HTTP FAIL — ${msg.slice(0, 120)}`);
      }
    }
  }

  section("Memory search queries");
  for (const testCase of SEARCH_CASES) {
    try {
      const response = await client.memory.search({
        query: testCase.query,
        max_memories: 10,
        max_nodes: 15,
        enable_agentic_graph: true,
      });
      const root = /** @type {{ data?: { memories?: unknown[]; nodes?: unknown[] }; memories?: unknown[]; nodes?: unknown[] }} */ (
        response
      );
      const memories = root.data?.memories ?? root.memories ?? [];
      const nodes = root.data?.nodes ?? root.nodes ?? [];
      console.log(
        `[OK] ${testCase.label}: memories=${memories.length} nodes=${nodes.length}`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`[FAIL] ${testCase.label}: ${msg.slice(0, 160)}`);
      unexpected++;
    }
  }

  section("Summary");
  console.log(`GraphQL expectations met: ${pass}/${GRAPHQL_CASES.length}`);
  if (unexpected > 0) {
    console.log(`Unexpected results: ${unexpected}`);
    process.exit(1);
  }
  console.log("All expectations met.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

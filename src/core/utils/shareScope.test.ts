import { describe, expect, it } from "vitest";

import {
  buildScopedQuery,
  isFileReadableInScope,
  normalizeRecipientSlug,
  passcodeMatches,
  resolveScopeContext,
  ScopeViolationError,
  SCOPED_MAX_ROWS,
  type SharePolicy,
  type ShareRecipient,
} from "./shareScope.js";

/**
 * Modelled on the Papr Data Room, which is the app that motivated scoping:
 * founders see everything, VCs see a few sections, connectors see intro
 * pathways and no investor or partner data.
 */
const policy: SharePolicy = {
  scopes: {
    overview: {
      tables: {
        company_info: { columns: ["id", "name", "blurb"] },
        documents: {
          columns: ["id", "name", "section_id", "file_size"],
          where: "section_id = ?",
          whereParams: ["overview"],
        },
      },
    },
    legal: {
      tables: {
        documents: {
          columns: ["id", "name", "section_id", "file_size"],
          where: "section_id LIKE ?",
          whereParams: ["legal%"],
        },
      },
    },
    intros: {
      tables: {
        vc_intro_paths: {
          columns: ["id", "investor_name", "via_person", "intro_quality"],
          maxRows: 2000,
        },
      },
    },
  },
};

const vc: ShareRecipient = {
  appId: "app-1",
  slug: "gangesh",
  label: "Gangesh",
  passcode: "661034",
  scopes: ["overview"],
};

const connector: ShareRecipient = {
  appId: "app-1",
  slug: "kerty-levy-c",
  label: "Kerty Levy",
  scopes: ["intros"],
};

const founder: ShareRecipient = {
  appId: "app-1",
  slug: "wasseem-kabbara",
  label: "Wasseem Kabbara",
  passcode: "009933",
  scopes: ["*"],
};

describe("resolveScopeContext", () => {
  it("gives founder proxies full access", () => {
    const ctx = resolveScopeContext(founder, policy);
    expect(ctx.fullAccess).toBe(true);
  });

  it("exposes only the tables in the granted scope", () => {
    const ctx = resolveScopeContext(vc, policy);
    expect(ctx.fullAccess).toBe(false);
    expect(Object.keys(ctx.tables).sort()).toEqual([
      "company_info",
      "documents",
    ]);
    expect(ctx.tables.vc_intro_paths).toBeUndefined();
  });

  it("refuses revoked recipients", () => {
    expect(() =>
      resolveScopeContext({ ...vc, revokedAt: "2026-01-01" }, policy),
    ).toThrow(ScopeViolationError);
  });

  it("ignores unknown scope names instead of widening or crashing", () => {
    const ctx = resolveScopeContext({ ...vc, scopes: ["overview", "nope"] }, policy);
    expect(Object.keys(ctx.tables).sort()).toEqual([
      "company_info",
      "documents",
    ]);
  });

  it("ORs predicates when two scopes grant the same table", () => {
    const ctx = resolveScopeContext(
      { ...vc, scopes: ["overview", "legal"] },
      policy,
    );
    // An extra grant must widen access, never narrow it.
    expect(ctx.tables.documents.where).toBe("(section_id = ?) OR (section_id LIKE ?)");
    expect(ctx.tables.documents.whereParams).toEqual(["overview", "legal%"]);
  });
});

describe("buildScopedQuery", () => {
  const ctx = resolveScopeContext(vc, policy);

  it("always AND-s the policy predicate into the statement", () => {
    const { sql, params } = buildScopedQuery({ table: "documents" }, ctx);
    expect(sql).toContain("WHERE (section_id = ?)");
    expect(params).toEqual(["overview"]);
  });

  it("projects to the allowlist rather than SELECT *", () => {
    const { sql } = buildScopedQuery({ table: "documents" }, ctx);
    expect(sql).toContain('SELECT "id", "name", "section_id", "file_size"');
    expect(sql).not.toContain("*");
  });

  it("rejects a table outside the scope", () => {
    expect(() => buildScopedQuery({ table: "vc_partners" }, ctx)).toThrow(
      ScopeViolationError,
    );
  });

  it("rejects a column outside the allowlist", () => {
    expect(() =>
      buildScopedQuery({ table: "documents", columns: ["file_data"] }, ctx),
    ).toThrow(ScopeViolationError);
  });

  it("rejects filtering on a hidden column (blind oracle)", () => {
    expect(() =>
      buildScopedQuery(
        {
          table: "documents",
          filters: [{ column: "file_data", op: "is_not_null" }],
        },
        ctx,
      ),
    ).toThrow(ScopeViolationError);
  });

  it("rejects ordering by a hidden column", () => {
    expect(() =>
      buildScopedQuery({ table: "documents", orderBy: "file_data" }, ctx),
    ).toThrow(ScopeViolationError);
  });

  it("binds caller filter values instead of inlining them", () => {
    const { sql, params } = buildScopedQuery(
      {
        table: "documents",
        filters: [{ column: "name", op: "like", value: "%deck%" }],
      },
      ctx,
    );
    expect(sql).toContain('"name" LIKE ?');
    expect(params).toEqual(["overview", "%deck%"]);
  });

  it("neutralises SQL injection in identifiers", () => {
    expect(() =>
      buildScopedQuery({ table: "documents; DROP TABLE documents" }, ctx),
    ).toThrow(ScopeViolationError);
    expect(() =>
      buildScopedQuery(
        {
          table: "documents",
          filters: [{ column: "name' OR '1'='1", op: "=", value: "x" }],
        },
        ctx,
      ),
    ).toThrow(ScopeViolationError);
  });

  it("cannot be widened by a caller filter", () => {
    // Even a filter that looks like it should match everything is AND-ed
    // underneath the policy predicate.
    const { sql } = buildScopedQuery(
      {
        table: "documents",
        filters: [{ column: "id", op: "is_not_null" }],
      },
      ctx,
    );
    expect(sql.indexOf("(section_id = ?)")).toBeLessThan(sql.indexOf('"id" IS NOT NULL'));
    expect(sql).toContain("AND");
  });

  it("turns an empty IN set into match-nothing, not a syntax error", () => {
    const { sql } = buildScopedQuery(
      { table: "documents", filters: [{ column: "id", op: "in", value: [] }] },
      ctx,
    );
    expect(sql).toContain("0 = 1");
  });

  it("clamps limits to the policy and global cap", () => {
    const introCtx = resolveScopeContext(connector, policy);
    const { sql } = buildScopedQuery(
      { table: "vc_intro_paths", limit: 999_999 },
      introCtx,
    );
    expect(sql).toContain("LIMIT 2000");

    const { sql: docSql } = buildScopedQuery(
      { table: "documents", limit: 999_999 },
      ctx,
    );
    expect(docSql).toContain(`LIMIT ${SCOPED_MAX_ROWS}`);
  });

  it("keeps a connector away from investor and partner tables", () => {
    const introCtx = resolveScopeContext(connector, policy);
    expect(() => buildScopedQuery({ table: "investors" }, introCtx)).toThrow(
      ScopeViolationError,
    );
    expect(() => buildScopedQuery({ table: "vc_partners" }, introCtx)).toThrow(
      ScopeViolationError,
    );
    // ...but its own pathways still work.
    expect(buildScopedQuery({ table: "vc_intro_paths" }, introCtx).sql).toContain(
      '"investor_name"',
    );
  });

  it("refuses to build for a full-access context (caller must bypass)", () => {
    const founderCtx = resolveScopeContext(founder, policy);
    expect(() => buildScopedQuery({ table: "documents" }, founderCtx)).toThrow(
      /full-access/,
    );
  });
});

describe("isFileReadableInScope", () => {
  it("lets full access read anything", () => {
    const ctx = resolveScopeContext(founder, policy);
    expect(isFileReadableInScope("legal", ctx, policy, ["*"])).toBe(true);
  });

  it("denies untagged files to scoped recipients (default private)", () => {
    const ctx = resolveScopeContext(vc, policy);
    expect(isFileReadableInScope(null, ctx, policy, ["overview"])).toBe(false);
  });

  it("denies a file tagged outside the recipient's scopes", () => {
    const ctx = resolveScopeContext(vc, policy);
    expect(isFileReadableInScope("legal", ctx, policy, ["overview"])).toBe(false);
  });

  it("allows a file tagged inside the recipient's scopes", () => {
    const ctx = resolveScopeContext(vc, policy);
    expect(isFileReadableInScope("overview", ctx, policy, ["overview"])).toBe(true);
  });
});

describe("slug + passcode", () => {
  it("normalises slugs for URLs", () => {
    expect(normalizeRecipientSlug("  Wasseem Kabbara! ")).toBe("wasseem-kabbara");
    expect(normalizeRecipientSlug("A--B")).toBe("a-b");
  });

  it("matches passcodes and rejects wrong or missing ones", () => {
    expect(passcodeMatches("661034", "661034")).toBe(true);
    expect(passcodeMatches("661034", "661035")).toBe(false);
    expect(passcodeMatches("661034", undefined)).toBe(false);
    expect(passcodeMatches("661034", "66103")).toBe(false);
  });

  it("treats an absent passcode as no passcode required", () => {
    expect(passcodeMatches(undefined, undefined)).toBe(true);
  });
});

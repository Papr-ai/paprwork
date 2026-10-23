import { describe, expect, it } from "vitest";
import {
  escapeGraphQL,
  graphqlNameContainsWhere,
  graphqlStringEq,
  sanitizeGraphQLFilterValue,
  wrapWikiGraphQLSelection,
} from "../../src/gateway/services/wikiGraphqlUtils.js";

describe("wikiGraphqlUtils", () => {
  it("escapeGraphQL strips newlines and escapes quotes", () => {
    expect(escapeGraphQL('Acme "HQ"\nline2')).toBe('Acme \\"HQ\\" line2');
  });

  it("sanitizeGraphQLFilterValue rejects empty and unsafe values", () => {
    expect(sanitizeGraphQLFilterValue("  ")).toBeNull();
    expect(sanitizeGraphQLFilterValue('bad"brace')).toBe("badbrace");
    expect(sanitizeGraphQLFilterValue("Northwind Traders")).toBe(
      "Northwind Traders",
    );
  });

  it("graphqlStringEq emits Neo4j eq filter syntax", () => {
    expect(graphqlStringEq("id", "proj_123")).toBe(
      'id: { eq: "proj_123" }',
    );
    expect(graphqlStringEq("id", "")).toBeNull();
  });

  // Memory GraphQL uses StringScalarFilters; name_CONTAINS does not exist (Aug 19).
  it("graphqlNameContainsWhere uses nested contains filter", () => {
    expect(graphqlNameContainsWhere("Pivotvia")).toBe(
      '{ name: { contains: "Pivotvia" } }',
    );
    expect(graphqlNameContainsWhere("")).toBeNull();
  });

  it("wrapWikiGraphQLSelection accepts nested contains filters", () => {
    expect(
      wrapWikiGraphQLSelection('people(where: { name: { contains: "x" } }) { id }'),
    ).toBe('{ people(where: { name: { contains: "x" } }) { id } }');
  });

  it("wrapWikiGraphQLSelection accepts valid selections", () => {
    expect(
      wrapWikiGraphQLSelection('projects(first: 12) { id name }'),
    ).toBe("{ projects(first: 12) { id name } }");
  });
});

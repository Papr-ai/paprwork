import { describe, expect, it } from "vitest";
import {
  escapeGraphQL,
  graphqlNameContainsWhere,
  graphqlStringEq,
  sanitizeGraphQLFilterValue,
  wrapWikiGraphQLSelection,
} from "../src/gateway/services/wikiGraphqlUtils.js";

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

  it("graphqlNameContainsWhere uses name_CONTAINS", () => {
    expect(graphqlNameContainsWhere("Pivotvia")).toBe(
      '{ name_CONTAINS: "Pivotvia" }',
    );
    expect(graphqlNameContainsWhere("")).toBeNull();
  });

  it("wrapWikiGraphQLSelection rejects nested contains filters", () => {
    expect(() =>
      wrapWikiGraphQLSelection(
        'people(where: { name: { contains: "x" } }) { id }',
      ),
    ).toThrow(/field_CONTAINS/i);
  });

  it("wrapWikiGraphQLSelection accepts valid selections", () => {
    expect(
      wrapWikiGraphQLSelection('projects(first: 12) { id name }'),
    ).toBe("{ projects(first: 12) { id name } }");
  });
});

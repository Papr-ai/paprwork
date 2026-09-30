import { describe, it, expect } from "vitest";
import {
  assertValidWikiGraphQLSelection,
  graphqlNameContainsWhere,
  wrapWikiGraphQLSelection,
} from "../src/gateway/services/wikiGraphqlUtils.js";

/**
 * Regression tests for the GraphQL entity-lookup blocker.
 *
 * The memory GraphQL API exposes:
 *   input StringScalarFilters { eq, in, contains, startsWith, endsWith }
 *
 * so `where: { name: { contains: "Dria" } }` is the CORRECT syntax.
 * A previous client-side guard rejected that form and steered callers to
 * `name_CONTAINS`, which is not defined on any *Where type and 400s:
 *   'Field "name_CONTAINS" is not defined by type "CompanyWhere".'
 *
 * Net effect: every natural entity-name lookup failed before leaving the
 * process, which is why GraphQL appeared unused for entity queries.
 */
describe("wiki GraphQL contains filter", () => {
  describe("assertValidWikiGraphQLSelection", () => {
    it("accepts nested contains filters (valid StringScalarFilters syntax)", () => {
      expect(() =>
        assertValidWikiGraphQLSelection(
          'companies(where: { name: { contains: "Dria" } }) { name }',
        ),
      ).not.toThrow();
    });

    it("accepts nested contains on people lookups", () => {
      expect(() =>
        assertValidWikiGraphQLSelection(
          'people(where: { name: { contains: "Megan" } }) { name role }',
        ),
      ).not.toThrow();
    });

    it("accepts the other StringScalarFilters operators", () => {
      for (const op of ["eq", "startsWith", "endsWith"]) {
        expect(() =>
          assertValidWikiGraphQLSelection(
            `people(where: { name: { ${op}: "M" } }) { name }`,
          ),
        ).not.toThrow();
      }
    });

    it("still rejects mutations", () => {
      expect(() =>
        assertValidWikiGraphQLSelection('mutation { createPerson(name: "x") }'),
      ).toThrow(/read queries only/i);
    });

    it("still rejects subscriptions", () => {
      expect(() =>
        assertValidWikiGraphQLSelection("subscription { personAdded { name } }"),
      ).toThrow(/read queries only/i);
    });

    it("still rejects empty selections", () => {
      expect(() => assertValidWikiGraphQLSelection("   ")).toThrow(/empty/i);
    });

    it("still rejects raw newlines", () => {
      expect(() =>
        assertValidWikiGraphQLSelection("people {\n  name\n}"),
      ).toThrow(/newlines/i);
    });
  });

  describe("graphqlNameContainsWhere", () => {
    it("emits nested StringScalarFilters syntax, not name_CONTAINS", () => {
      const filter = graphqlNameContainsWhere("Dria Ventures");

      expect(filter).toBe('{ name: { contains: "Dria Ventures" } }');
      expect(filter).not.toContain("name_CONTAINS");
    });

    it("produces a filter that passes its own validator", () => {
      const filter = graphqlNameContainsWhere("Megan Maloney");
      expect(filter).not.toBeNull();

      expect(() =>
        assertValidWikiGraphQLSelection(`people(where: ${filter}) { name }`),
      ).not.toThrow();
    });

    it("returns null for empty input", () => {
      expect(graphqlNameContainsWhere("   ")).toBeNull();
    });

    it("strips characters that would break out of the filter literal", () => {
      const filter = graphqlNameContainsWhere('Acme" } }) { id } #');
      expect(filter).not.toContain('"}');
      expect(filter?.startsWith("{ name: { contains: ")).toBe(true);
    });
  });

  describe("wrapWikiGraphQLSelection", () => {
    it("wraps a contains-filtered entity lookup end to end", () => {
      const wrapped = wrapWikiGraphQLSelection(
        'companies(where: { name: { contains: "Dria" } }) { name description }',
      );

      expect(wrapped).toBe(
        '{ companies(where: { name: { contains: "Dria" } }) { name description } }',
      );
    });
  });
});

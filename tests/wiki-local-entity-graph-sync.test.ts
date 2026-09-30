import { describe, expect, it } from "vitest";
import {
  parseWikiEntityFilePath,
  parseWikiEntityFrontmatter,
} from "../src/gateway/services/wikiLocalEntityGraphSync.js";

describe("wikiLocalEntityGraphSync", () => {
  it("parseWikiEntityFilePath matches workspace entity markdown paths", () => {
    expect(
      parseWikiEntityFilePath(
        "/Users/me/Papr/orgs/x/namespaces/y/workspace/entities/companies/myadvice.md",
      ),
    ).toEqual({ entityDir: "companies", slug: "myadvice" });

    expect(parseWikiEntityFilePath("/tmp/other/file.md")).toBeNull();
  });

  it("parseWikiEntityFrontmatter reads name and app_id", () => {
    const content = `---
type: apps
id: gtm-metrics
name: "MyAdvice GTM Metrics"
app_id: 91d94d77-dace-4746-8be4-2f7e385c6944
kind: mini_app
description_short: "Dashboard for GTM metrics"
---
# Title
`;
    expect(parseWikiEntityFrontmatter(content)).toEqual({
      name: "MyAdvice GTM Metrics",
      description: "Dashboard for GTM metrics",
      appId: "91d94d77-dace-4746-8be4-2f7e385c6944",
      kind: "mini_app",
    });
  });
});

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getPaprApiCatalog } from "../paprApiCatalog/loadCatalog.js";
import {
  formatCatalogEntryForAgent,
  searchPaprApiCatalog,
} from "../paprApiCatalog/searchCatalog.js";
import type { PaprApiSurface } from "../paprApiCatalog/types.js";

const surfaceSchema = z.enum([
  "any",
  "mini-app-http",
  "mini-app-sdk",
  "agent-tool",
  "desktop-gateway",
  "cloud-gateway",
]);

const getPaprApiReferenceSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "What you need — e.g. 'db write batch', 'list jobs', 'papr files upload', 'create_app'",
    ),
  surface: surfaceSchema
    .optional()
    .default("any")
    .describe("Filter by API layer (default: any)"),
  limit: z.number().int().min(1).max(25).optional().default(10),
  detail: z.enum(["summary", "full"]).optional().default("full"),
});

export const getPaprApiReferenceTool = createTool({
  id: "get_papr_api_reference",
  description:
    "Lookup Papr platform API contracts BEFORE curl/grep/memory search: mini-app HTTP (/api/db/*, jobs, files), " +
    "mini-app SDK (papr.*), and agent tools. Returns method, path, body fields, limits, and examples. " +
    "For workflow/playbooks use read_skill({ skillId: 'preloaded-papr-api-reference' }) or preloaded-app-and-jobs-guide.",
  inputSchema: getPaprApiReferenceSchema,
  execute: async (inputData) => {
    const args =
      (inputData as { context?: z.infer<typeof getPaprApiReferenceSchema> }).context ??
      inputData;
    const catalog = getPaprApiCatalog();
    const surface = (args.surface ?? "any") as PaprApiSurface | "any";
    const hits = searchPaprApiCatalog(catalog, {
      query: args.query,
      surface,
      limit: args.limit ?? 10,
    });

    const detail = args.detail ?? "full";
    const results = hits.map((hit) => ({
      score: hit.score,
      ...formatCatalogEntryForAgent(hit.entry, detail),
    }));

    const hint =
      results.length === 0
        ? "No matches. Try broader terms (db, batch, jobs, files, sdk) or surface 'mini-app-http'."
        : undefined;

    return {
      success: true,
      query: args.query,
      surface,
      catalogVersion: catalog.version,
      generatedAt: catalog.generatedAt,
      count: results.length,
      results,
      ...(hint ? { hint } : {}),
    };
  },
});

export const paprApiReferenceTools = [getPaprApiReferenceTool];

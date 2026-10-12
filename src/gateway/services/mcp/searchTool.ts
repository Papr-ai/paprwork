/**
 * papr_search: find an item inside the user's Papr apps by meaning, then open the right card.
 *
 * Card tools take an item reference ("video": title or id). Claude only knows what the user
 * typed ("this is the deck"), and exact-title matching then lands on the wrong item. Apps
 * index their items in Papr Memory (papr.search.index); this tool searches them as the
 * signed-in caller and answers with the card tool and the exact args to open each hit.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpCaller } from "./auth.js";
import type { AppToolSpec } from "./appTools.js";
import type { ClaudeApp } from "./catalog.js";
import type { AppSearchHit } from "../appSearch/appSearchCore.js";
import { httpMemoryPort, queryItems } from "../appSearch/appSearchMemory.js";

export type AppSearchFn = (
  query: string,
  opts: { app?: { namespaceId: string; slug: string }; limit?: number },
) => Promise<AppSearchHit[]>;

/** Memory search as this caller: only memories they can read come back. */
export function memoryAppSearch(memoryBaseUrl: string, caller: McpCaller, fetchImpl: typeof fetch = fetch): AppSearchFn {
  const port = httpMemoryPort(memoryBaseUrl, { sessionToken: caller.sessionToken }, fetchImpl);
  return (query, opts) => queryItems(port, query, opts);
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** "scenario", "Scenario" or the slug → that app. */
export function findApp(apps: ClaudeApp[], ref: string, appTitle: (a: ClaudeApp) => string): ClaudeApp | undefined {
  const r = norm(ref);
  return apps.find((a) => norm(a.slug) === r || norm(appTitle(a)) === r);
}

export interface SearchResultRow extends AppSearchHit {
  app: string;
  /** Card tool that opens the hit, with args to pass. */
  tool?: string;
  openUrl: string;
}

export function toResultRows(hits: AppSearchHit[], apps: ClaudeApp[], tools: AppToolSpec[], appsBaseUrl: string, appTitle: (a: ClaudeApp) => string): SearchResultRow[] {
  return hits.map((h) => {
    const app = apps.find((a) => a.namespaceId === h.namespaceId && a.slug === h.slug);
    const own = tools.filter((t) => t.app.namespaceId === h.namespaceId && t.app.slug === h.slug);
    const tool = own.find((t) => t.view === h.view) ?? (h.view ? undefined : own[0]);
    const base = `${appsBaseUrl}/${h.namespaceId}/${h.slug}/`;
    const openUrl = h.url ? (/^https:\/\//.test(h.url) ? h.url : `${base}${h.url.replace(/^\//, "")}`) : base;
    return { ...h, app: app ? appTitle(app) : h.slug, ...(tool ? { tool: tool.name } : {}), openUrl };
  });
}

export function registerSearchTool(
  server: McpServer,
  deps: { search: AppSearchFn; apps: ClaudeApp[]; tools: AppToolSpec[]; appsBaseUrl: string; appTitle: (a: ClaudeApp) => string },
): void {
  server.registerTool(
    "papr_search",
    {
      title: "Search Papr apps",
      description:
        "Find a specific item inside the user's Papr apps (a video, lead, doc...) by meaning, not exact title. " +
        "Use it before opening a card about one item when you don't have its exact id, then call the returned tool with the returned args.",
      inputSchema: {
        query: z.string().min(1).max(500).describe("What the user said, e.g. \"this is the deck video\""),
        app: z.string().max(80).optional().describe("Limit to one app, by name or slug (from papr_list_apps)"),
        limit: z.number().int().min(1).max(20).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const app = args.app ? findApp(deps.apps, args.app, deps.appTitle) : undefined;
      if (args.app && !app) {
        return { isError: true, content: [{ type: "text", text: `No Papr app called "${args.app}". Use papr_list_apps to see them.` }] };
      }
      try {
        const hits = await deps.search(args.query, { ...(app ? { app } : {}), limit: args.limit ?? 5 });
        const rows = toResultRows(hits, deps.apps, deps.tools, deps.appsBaseUrl, deps.appTitle);
        const text = rows.length
          ? rows.map((r) =>
              `- ${r.title} (${r.app})${r.snippet ? `: ${r.snippet}` : ""}\n` +
              (r.tool ? `  open: ${r.tool} ${JSON.stringify(r.args ?? {})}\n` : "") +
              `  link: ${r.openUrl}`).join("\n")
          : `Nothing found${app ? ` in ${deps.appTitle(app)}` : ""}. The app may not index its items yet; ask the user for the exact name.`;
        return { content: [{ type: "text", text }], structuredContent: { results: rows } };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Papr search failed: ${(err as Error).message}` }] };
      }
    },
  );
}

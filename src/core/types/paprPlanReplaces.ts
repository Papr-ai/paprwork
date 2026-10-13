/**
 * "Replaces $X/mo" strip on each plan card — the niche point tools a plan stands in for.
 * Copied from the Papr Unit Economics app (lib/worth-tools.ts + lib/tool-brands.ts).
 * Tier is cumulative: 1 = Cloud, 2 = adds at Max 5x, 3 = adds at Max 20x.
 */

export interface PaprReplacedTool {
  job: string;
  tools: string;
  monthly: number;
  tier: 1 | 2 | 3;
  domain: string;
  /** What you build in Papr instead. */
  papr: string;
}

export const PAPR_REPLACED_TOOLS: readonly PaprReplacedTool[] = [
  { job: "Scraping lists off the web", tools: "Browse AI / Simplescraper", monthly: 49, tier: 1, domain: "browse.ai",
    papr: "A run that pulls the rows you need and writes them into your own table." },
  { job: "Recurring checklists", tools: "Process Street / Tallyfy", monthly: 45, tier: 1, domain: "process.st",
    papr: "A checklist app anyone can run, producing the same result every time." },
  { job: "Syncing data between tools", tools: "Whalesync / Bracket", monthly: 39, tier: 1, domain: "whalesync.com",
    papr: "One database both apps read, so there is nothing left to keep in sync." },
  { job: "Forms and intake", tools: "Tally / Fillout", monthly: 29, tier: 1, domain: "tally.so",
    papr: "A form on a real URL that writes straight into your app database." },
  { job: "Watching pages for changes", tools: "Visualping / Distill", monthly: 20, tier: 1, domain: "visualping.io",
    papr: "A watcher that checks pages and only speaks up when something changed." },
  { job: "Small sites and landing pages", tools: "Carrd / Typedream", monthly: 19, tier: 1, domain: "carrd.co",
    papr: "A page you publish from the same app that holds the data behind it." },

  { job: "Parsing PDFs and invoices", tools: "Docparser / Parseur", monthly: 99, tier: 2, domain: "docparser.com",
    papr: "A parsing run that extracts the fields you named into rows you defined." },
  { job: "Client-facing reporting", tools: "AgencyAnalytics / Databox", monthly: 59, tier: 2, domain: "agencyanalytics.com",
    papr: "A client-facing report on its own URL, refreshed on a schedule." },
  { job: "Cold email sequences", tools: "Instantly / Lemlist", monthly: 59, tier: 2, domain: "instantly.ai",
    papr: "An app that drafts and sends your sequence, with replies landing in memory." },
  { job: "LinkedIn outreach", tools: "Dripify / Expandi", monthly: 39, tier: 2, domain: "dripify.io",
    papr: "A LinkedIn run through your own signed-in browser session." },
  { job: "Internal portals", tools: "Softr / Glide", monthly: 39, tier: 2, domain: "softr.io",
    papr: "An internal portal you publish, where viewers never need a seat." },
  { job: "Approval routing", tools: "Approveit / Zenphi", monthly: 29, tier: 2, domain: "approveit.today",
    papr: "An approval step inside the app that already holds the thing being approved." },

  { job: "Embedded analytics", tools: "Explo / Luzmo", monthly: 99, tier: 3, domain: "explo.co",
    papr: "Charts in your own app, over your own tables, with no embed to license." },
  { job: "Automation at volume", tools: "Make Pro / n8n Cloud", monthly: 66, tier: 3, domain: "make.com",
    papr: "Runs that chain into each other, with real code you can open and fix." },
  { job: "Scraping at scale", tools: "Apify / Bright Data", monthly: 49, tier: 3, domain: "apify.com",
    papr: "A scraper run on a schedule, writing rows into your database." },
  { job: "Spreadsheet automation", tools: "Sheetgo / Coefficient", monthly: 49, tier: 3, domain: "sheetgo.com",
    papr: "The spreadsheet becomes an app, so the formulas stop being the system." },
  { job: "Generating documents", tools: "PandaDoc / Documint", monthly: 47, tier: 3, domain: "pandadoc.com",
    papr: "A document that fills from your data and records what was sent." },
  { job: "Monitors and alerting", tools: "Better Stack / Cronitor", monthly: 29, tier: 3, domain: "betterstack.com",
    papr: "A run that checks what matters to you and messages you when it breaks." },
  { job: "Tracked short links", tools: "Dub / Short.io", monthly: 24, tier: 3, domain: "dub.co",
    papr: "Links you issue and track in the app that uses the clicks." },
];

/** Tools a plan replaces, priciest first. */
export function replacedToolsFor(tier: number): PaprReplacedTool[] {
  return PAPR_REPLACED_TOOLS.filter((t) => t.tier <= tier).sort((a, b) => b.monthly - a.monthly);
}

export function replacedTotal(tier: number): number {
  return replacedToolsFor(tier).reduce((s, t) => s + t.monthly, 0);
}

export const toolFaviconUrl = (domain: string): string =>
  `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

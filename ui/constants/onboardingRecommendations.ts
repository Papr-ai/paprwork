/**
 * Curated first-run app picks for the onboarding "recommend" phase.
 *
 * Voice is ported from the onboarding redesign prototype (content-build.ts):
 * every card sells a RECURRING OUTCOME, not an app to browse. `title` says what
 * happens for you; `meta` states the real cadence. That schedule line is the
 * whole pitch — it's what separates Papr from a template gallery.
 *
 * `meta` must stay TRUE. It is read from each app's job.json, not invented:
 *   - LinkedIn Outreach ....... Sender runs every 15 min (daily outreach, paced
 *                               in small batches for rate limits) plus a Reply
 *                               Detector on its own quarter-hourly schedule.
 *                               Do NOT paste the raw crons here — a slash-star
 *                               sequence would close this comment.
 *   - Reddit Research Agent ... Reddit Harvester cron 0 7 * * *
 *   - Lead Prospector ......... 8 jobs, all on-demand (no schedule)
 *   - SEO Audit ............... no jobs at all
 * If you swap a pick, re-read its jobs and rewrite `meta` to match.
 *
 * Selection rule: no typing secrets. A pick may need credentials ONLY if they
 * can be obtained by clicking — platform connect writes the keychain keys for
 * us. Check the flags, not requirementsCount: the setup wizard only triggers on
 * specs where `required !== false && credentialScope !== "owner"`.
 */

export interface OnboardingRecommendation {
  /** Cloud catalog slug — matched against CommunityCatalogEntry.slug. */
  slug: string;
  /** Outcome-first headline. Replaces the catalog name on the card. */
  title: string;
  /** What it does, in one sentence. */
  desc: string;
  /** Real cadence, from job.json. Never decorative. */
  meta: string;
  /**
   * Platform sign-in this app needs before it can do anything.
   * One click opens Papr Chrome; the session service writes the required
   * keychain keys (e.g. LINKEDIN_LI_AT), so the install wizard finds them
   * already satisfied instead of asking for a paste.
   */
  connect?: {
    platformId: string;
    label: string;
    /** Why we're asking — shown inline, never as a surprise. */
    why: string;
  };
}

export const ONBOARDING_RECOMMENDATIONS: OnboardingRecommendation[] = [
  {
    slug: "seo-audit",
    title: "Audit any site on demand",
    desc: "Paste a URL and get a real SEO report — issues ranked by what actually costs you traffic.",
    meta: "An app you run whenever you need it — no keys, no setup",
  },
  {
    slug: "reddit-research-agent",
    title: "Hear what customers complain about",
    desc: "Watches Reddit for pain points in your category and extracts quote-cited insights.",
    meta: "App plus a job that runs every morning at 7:00am",
    connect: {
      platformId: "reddit",
      label: "Connect Reddit",
      why: "Opens Papr Chrome so you can sign in once. Read-only — it never posts.",
    },
  },
  {
    slug: "lead-prospector",
    title: "Find leads with the evidence attached",
    desc: "Describe your ideal customer and get a ranked list, each one quoting the source it came from.",
    meta: "App plus jobs you run when you need a list",
  },
  {
    slug: "linkedin-outreach",
    title: "Turn leads into conversations",
    desc: "Sends connection requests and follow-ups on your behalf, paced to stay under LinkedIn's limits, with replies drafted for you to approve.",
    meta: "App plus jobs that connect and message people daily, then watch for replies",
    connect: {
      platformId: "linkedin",
      label: "Connect LinkedIn",
      why: "Opens Papr Chrome so you can sign in once. Nothing is sent without your approval.",
    },
  },
];

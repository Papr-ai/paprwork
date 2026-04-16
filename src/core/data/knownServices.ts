/**
 * Known Services Registry
 *
 * Maps common API key names to rich metadata including signup URLs,
 * setup instructions, free-tier info, and alternative services in the
 * same category. Used by the Import Setup Wizard to guide users through
 * key configuration and service substitution.
 */

import type { ServiceCategory } from "../types/bundles.js";

export interface AlternativeService {
  keyName: string;
  service: string;
  signupUrl: string;
  docsUrl: string;
  freeTier?: boolean;
  freeTierNote?: string;
}

export interface ServiceInfo {
  service: string;
  category: ServiceCategory;
  description: string;
  signupUrl: string;
  docsUrl: string;
  instructions: string;
  freeTier: boolean;
  freeTierNote?: string;
  alternatives?: AlternativeService[];
}

export const KNOWN_SERVICES: Record<string, ServiceInfo> = {
  // ── Analytics ──────────────────────────────────────────────────────
  POSTHOG_PERSONAL_API_KEY: {
    service: "PostHog",
    category: "analytics",
    description: "Product analytics — events, sessions, funnels, feature flags",
    signupUrl: "https://posthog.com/signup",
    docsUrl: "https://posthog.com/docs/api/personal-api-keys",
    instructions:
      "Sign in to PostHog > Settings > Personal API Keys > Create personal API key",
    freeTier: true,
    freeTierNote: "1M events/month free",
    alternatives: [
      {
        keyName: "MIXPANEL_TOKEN",
        service: "Mixpanel",
        signupUrl: "https://mixpanel.com/signup",
        docsUrl:
          "https://docs.mixpanel.com/docs/orgs-and-projects/managing-projects",
        freeTier: true,
        freeTierNote: "20M events/month free",
      },
      {
        keyName: "AMPLITUDE_API_KEY",
        service: "Amplitude",
        signupUrl: "https://amplitude.com/signup",
        docsUrl:
          "https://www.docs.developers.amplitude.com/analytics/find-api-credentials/",
        freeTier: true,
        freeTierNote: "10M events/month free",
      },
    ],
  },

  MIXPANEL_TOKEN: {
    service: "Mixpanel",
    category: "analytics",
    description: "Product analytics — events, funnels, user profiles",
    signupUrl: "https://mixpanel.com/signup",
    docsUrl:
      "https://docs.mixpanel.com/docs/orgs-and-projects/managing-projects",
    instructions:
      "Sign in to Mixpanel > Settings > Project Settings > copy Project Token",
    freeTier: true,
    freeTierNote: "20M events/month free",
    alternatives: [
      {
        keyName: "POSTHOG_PERSONAL_API_KEY",
        service: "PostHog",
        signupUrl: "https://posthog.com/signup",
        docsUrl: "https://posthog.com/docs/api/personal-api-keys",
        freeTier: true,
        freeTierNote: "1M events/month free",
      },
      {
        keyName: "AMPLITUDE_API_KEY",
        service: "Amplitude",
        signupUrl: "https://amplitude.com/signup",
        docsUrl:
          "https://www.docs.developers.amplitude.com/analytics/find-api-credentials/",
        freeTier: true,
        freeTierNote: "10M events/month free",
      },
    ],
  },

  AMPLITUDE_API_KEY: {
    service: "Amplitude",
    category: "analytics",
    description: "Product analytics — behavioral cohorts, experiments",
    signupUrl: "https://amplitude.com/signup",
    docsUrl:
      "https://www.docs.developers.amplitude.com/analytics/find-api-credentials/",
    instructions:
      "Sign in to Amplitude > Settings > Projects > select project > copy API Key",
    freeTier: true,
    freeTierNote: "10M events/month free",
  },

  // ── Database ───────────────────────────────────────────────────────
  NEON_DB_URL: {
    service: "Neon",
    category: "database",
    description: "Serverless PostgreSQL database",
    signupUrl: "https://neon.tech",
    docsUrl: "https://neon.tech/docs/connect/connect-from-any-app",
    instructions:
      "Dashboard > select project > Connection Details > copy connection string",
    freeTier: true,
    freeTierNote: "0.5 GB storage free",
    alternatives: [
      {
        keyName: "SUPABASE_DB_URL",
        service: "Supabase",
        signupUrl: "https://supabase.com/dashboard",
        docsUrl:
          "https://supabase.com/docs/guides/database/connecting-to-postgres",
        freeTier: true,
        freeTierNote: "500 MB storage free",
      },
      {
        keyName: "TURSO_DB_URL",
        service: "Turso",
        signupUrl: "https://turso.tech",
        docsUrl: "https://docs.turso.tech/quickstart",
        freeTier: true,
        freeTierNote: "9 GB storage free",
      },
    ],
  },

  SUPABASE_DB_URL: {
    service: "Supabase",
    category: "database",
    description: "PostgreSQL database with realtime, auth, and storage",
    signupUrl: "https://supabase.com/dashboard",
    docsUrl: "https://supabase.com/docs/guides/database/connecting-to-postgres",
    instructions:
      "Dashboard > select project > Settings > Database > Connection string",
    freeTier: true,
    freeTierNote: "500 MB storage free",
    alternatives: [
      {
        keyName: "NEON_DB_URL",
        service: "Neon",
        signupUrl: "https://neon.tech",
        docsUrl: "https://neon.tech/docs/connect/connect-from-any-app",
        freeTier: true,
        freeTierNote: "0.5 GB storage free",
      },
    ],
  },

  SUPABASE_API_KEY: {
    service: "Supabase",
    category: "database",
    description: "Supabase project API key for client-side access",
    signupUrl: "https://supabase.com/dashboard",
    docsUrl: "https://supabase.com/docs/guides/api/api-keys",
    instructions:
      "Dashboard > select project > Settings > API > copy anon/public key",
    freeTier: true,
    freeTierNote: "500 MB storage free",
  },

  // ── Payments ───────────────────────────────────────────────────────
  STRIPE_API_KEY: {
    service: "Stripe",
    category: "payments",
    description: "Payment processing — charges, subscriptions, invoices",
    signupUrl: "https://dashboard.stripe.com/register",
    docsUrl: "https://docs.stripe.com/keys",
    instructions:
      "Dashboard > Developers > API Keys > copy Secret key (use test key for development)",
    freeTier: true,
    freeTierNote: "Test mode is always free",
    alternatives: [
      {
        keyName: "PADDLE_API_KEY",
        service: "Paddle",
        signupUrl: "https://login.paddle.com/signup",
        docsUrl: "https://developer.paddle.com/api-reference/overview",
        freeTier: true,
        freeTierNote: "Sandbox mode free",
      },
      {
        keyName: "LEMONSQUEEZY_API_KEY",
        service: "Lemon Squeezy",
        signupUrl: "https://app.lemonsqueezy.com/register",
        docsUrl: "https://docs.lemonsqueezy.com/api",
        freeTier: true,
        freeTierNote: "Test mode free",
      },
    ],
  },

  // ── Email ──────────────────────────────────────────────────────────
  SENDGRID_API_KEY: {
    service: "SendGrid",
    category: "email",
    description: "Transactional and marketing email delivery",
    signupUrl: "https://signup.sendgrid.com/",
    docsUrl: "https://docs.sendgrid.com/ui/account-and-settings/api-keys",
    instructions:
      "Settings > API Keys > Create API Key > copy the key (shown only once)",
    freeTier: true,
    freeTierNote: "100 emails/day free",
    alternatives: [
      {
        keyName: "RESEND_API_KEY",
        service: "Resend",
        signupUrl: "https://resend.com/signup",
        docsUrl: "https://resend.com/docs/api-reference/api-keys/create-api-key",
        freeTier: true,
        freeTierNote: "3,000 emails/month free",
      },
      {
        keyName: "POSTMARK_API_KEY",
        service: "Postmark",
        signupUrl: "https://account.postmarkapp.com/sign_up",
        docsUrl: "https://postmarkapp.com/developer",
        freeTier: true,
        freeTierNote: "100 emails/month free",
      },
    ],
  },

  RESEND_API_KEY: {
    service: "Resend",
    category: "email",
    description: "Developer-first email API",
    signupUrl: "https://resend.com/signup",
    docsUrl: "https://resend.com/docs/api-reference/api-keys/create-api-key",
    instructions: "Dashboard > API Keys > Create API Key > copy the key",
    freeTier: true,
    freeTierNote: "3,000 emails/month free",
  },

  // ── Messaging ──────────────────────────────────────────────────────
  TWILIO_API_KEY: {
    service: "Twilio",
    category: "messaging",
    description: "SMS, voice, and messaging APIs",
    signupUrl: "https://www.twilio.com/try-twilio",
    docsUrl: "https://www.twilio.com/docs/iam/api-keys",
    instructions:
      "Console > Account > API keys > Create API key > copy SID and Secret",
    freeTier: true,
    freeTierNote: "Trial credit included",
  },

  // ── Monitoring ─────────────────────────────────────────────────────
  SENTRY_DSN: {
    service: "Sentry",
    category: "monitoring",
    description: "Error tracking and performance monitoring",
    signupUrl: "https://sentry.io/signup/",
    docsUrl: "https://docs.sentry.io/product/sentry-basics/concepts/dsn-explainer/",
    instructions:
      "Settings > Projects > select project > Client Keys (DSN) > copy DSN",
    freeTier: true,
    freeTierNote: "5K errors/month free",
    alternatives: [
      {
        keyName: "DATADOG_API_KEY",
        service: "Datadog",
        signupUrl: "https://www.datadoghq.com/free-datadog-trial/",
        docsUrl: "https://docs.datadoghq.com/account_management/api-app-keys/",
        freeTier: true,
        freeTierNote: "14-day free trial",
      },
    ],
  },

  // ── Search ─────────────────────────────────────────────────────────
  ALGOLIA_API_KEY: {
    service: "Algolia",
    category: "search",
    description: "Search and discovery API",
    signupUrl: "https://www.algolia.com/users/sign_up",
    docsUrl: "https://www.algolia.com/doc/guides/security/api-keys/",
    instructions:
      "Dashboard > Settings > API Keys > copy Search-Only API Key (or Admin for writes)",
    freeTier: true,
    freeTierNote: "10K search requests/month free",
    alternatives: [
      {
        keyName: "TYPESENSE_API_KEY",
        service: "Typesense",
        signupUrl: "https://cloud.typesense.org",
        docsUrl: "https://typesense.org/docs/guide/",
        freeTier: true,
        freeTierNote: "Free tier available",
      },
    ],
  },

  // ── Notifications ──────────────────────────────────────────────────
  SLACK_BOT_TOKEN: {
    service: "Slack",
    category: "notifications",
    description: "Send messages and notifications to Slack channels",
    signupUrl: "https://api.slack.com/apps",
    docsUrl: "https://api.slack.com/authentication/token-types",
    instructions:
      "api.slack.com > Your Apps > Create New App > OAuth & Permissions > copy Bot User OAuth Token",
    freeTier: true,
    freeTierNote: "Free for all workspaces",
    alternatives: [
      {
        keyName: "DISCORD_BOT_TOKEN",
        service: "Discord",
        signupUrl: "https://discord.com/developers/applications",
        docsUrl: "https://discord.com/developers/docs/getting-started",
        freeTier: true,
        freeTierNote: "Free for all servers",
      },
    ],
  },

  DISCORD_BOT_TOKEN: {
    service: "Discord",
    category: "notifications",
    description: "Send messages and notifications to Discord channels",
    signupUrl: "https://discord.com/developers/applications",
    docsUrl: "https://discord.com/developers/docs/getting-started",
    instructions:
      "Developer Portal > Applications > select app > Bot > copy Token",
    freeTier: true,
    freeTierNote: "Free for all servers",
  },

  // ── CRM ────────────────────────────────────────────────────────────
  HUBSPOT_API_KEY: {
    service: "HubSpot",
    category: "crm",
    description: "CRM — contacts, deals, companies, marketing",
    signupUrl: "https://app.hubspot.com/signup-hubspot/crm",
    docsUrl: "https://developers.hubspot.com/docs/api/private-apps",
    instructions:
      "Settings > Integrations > Private Apps > Create a private app > copy access token",
    freeTier: true,
    freeTierNote: "Free CRM tier",
    alternatives: [
      {
        keyName: "SALESFORCE_API_KEY",
        service: "Salesforce",
        signupUrl: "https://developer.salesforce.com/signup",
        docsUrl:
          "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/",
        freeTier: true,
        freeTierNote: "Developer edition free",
      },
      {
        keyName: "PIPEDRIVE_API_TOKEN",
        service: "Pipedrive",
        signupUrl: "https://www.pipedrive.com/en/register",
        docsUrl: "https://developers.pipedrive.com/docs/api/v1",
        freeTier: true,
        freeTierNote: "14-day trial",
      },
    ],
  },

  // ── Auth ────────────────────────────────────────────────────────────
  AUTH0_CLIENT_SECRET: {
    service: "Auth0",
    category: "auth",
    description: "Authentication and authorization platform",
    signupUrl: "https://auth0.com/signup",
    docsUrl: "https://auth0.com/docs/get-started",
    instructions:
      "Dashboard > Applications > select app > Settings > copy Client Secret",
    freeTier: true,
    freeTierNote: "7,500 active users free",
    alternatives: [
      {
        keyName: "CLERK_SECRET_KEY",
        service: "Clerk",
        signupUrl: "https://dashboard.clerk.com/sign-up",
        docsUrl: "https://clerk.com/docs",
        freeTier: true,
        freeTierNote: "10,000 MAU free",
      },
    ],
  },

  // ── Storage ────────────────────────────────────────────────────────
  AWS_ACCESS_KEY_ID: {
    service: "AWS S3",
    category: "storage",
    description: "Object storage — files, images, backups",
    signupUrl: "https://aws.amazon.com/free/",
    docsUrl: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
    instructions:
      "IAM Console > Users > select user > Security credentials > Create access key",
    freeTier: true,
    freeTierNote: "5 GB S3 free for 12 months",
    alternatives: [
      {
        keyName: "CLOUDFLARE_R2_ACCESS_KEY",
        service: "Cloudflare R2",
        signupUrl: "https://dash.cloudflare.com/sign-up",
        docsUrl: "https://developers.cloudflare.com/r2/",
        freeTier: true,
        freeTierNote: "10 GB storage free",
      },
    ],
  },

  // ── GitHub ─────────────────────────────────────────────────────────
  GITHUB_TOKEN: {
    service: "GitHub",
    category: "github",
    description: "GitHub API — repositories, issues, pull requests",
    signupUrl: "https://github.com/signup",
    docsUrl: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    instructions:
      "Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token",
    freeTier: true,
    freeTierNote: "Free for public repos",
  },

  // ── Google ─────────────────────────────────────────────────────────
  GOOGLE_API_KEY: {
    service: "Google APIs",
    category: "google",
    description:
      "Google Cloud APIs — Maps, Sheets, Drive, Calendar, Gmail, etc.",
    signupUrl: "https://console.cloud.google.com/",
    docsUrl: "https://cloud.google.com/docs/authentication/api-keys",
    instructions:
      "Google Cloud Console > APIs & Services > Credentials > Create credentials > API key",
    freeTier: true,
    freeTierNote: "Many APIs have free quotas",
  },

  // ── AI ─────────────────────────────────────────────────────────────
  OPENAI_API_KEY: {
    service: "OpenAI",
    category: "ai",
    description: "GPT, DALL-E, Whisper, and Embeddings APIs",
    signupUrl: "https://platform.openai.com/signup",
    docsUrl: "https://platform.openai.com/docs/api-reference",
    instructions:
      "platform.openai.com > API keys > Create new secret key > copy key",
    freeTier: false,
    alternatives: [
      {
        keyName: "ANTHROPIC_API_KEY",
        service: "Anthropic",
        signupUrl: "https://console.anthropic.com/",
        docsUrl: "https://docs.anthropic.com/en/api/getting-started",
      },
      {
        keyName: "GOOGLE_AI_API_KEY",
        service: "Google AI (Gemini)",
        signupUrl: "https://aistudio.google.com/apikey",
        docsUrl: "https://ai.google.dev/gemini-api/docs",
        freeTier: true,
        freeTierNote: "Free tier available",
      },
    ],
  },

  ANTHROPIC_API_KEY: {
    service: "Anthropic",
    category: "ai",
    description: "Claude AI models for chat, analysis, and coding",
    signupUrl: "https://console.anthropic.com/",
    docsUrl: "https://docs.anthropic.com/en/api/getting-started",
    instructions:
      "console.anthropic.com > Settings > API Keys > Create Key > copy key",
    freeTier: false,
  },
};

/**
 * Look up rich metadata for a key name. Returns undefined if the key
 * is not in the registry — callers should fall back to generic UI.
 */
export function lookupService(keyName: string): ServiceInfo | undefined {
  return KNOWN_SERVICES[keyName];
}

/**
 * Get all known alternative services for a given key name.
 * Returns empty array if the key has no registered alternatives.
 */
export function getAlternatives(keyName: string): AlternativeService[] {
  return KNOWN_SERVICES[keyName]?.alternatives ?? [];
}

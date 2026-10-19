/**
 * declare_app_keys — the agent says what each key an app uses is for, who
 * provides it, and whether the app works without it. Publish checks that every
 * key found in the app's backend and linked jobs has been declared this way.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { RequiredKeySpec, ServiceCategory } from "../types/bundles.js";
import { SERVICE_CATEGORIES } from "../types/bundles.js";
import { lookupService } from "../data/knownServices.js";

/** One key, as the agent declares it. Shared by declare_app_keys and job requiredKeys. */
export const DeclaredKeySchema = z.object({
  name: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/, "UPPER_SNAKE_CASE env var name")
    .describe("Env var name, e.g. OPENAI_API_KEY"),
  purpose: z
    .string()
    .min(8)
    .describe(
      "One plain sentence a visitor will read: what the app does with it. e.g. 'Writes your post drafts with your OpenAI account'. No env var names, no jargon.",
    ),
  provider: z
    .enum(["owner", "user"])
    .describe(
      "owner = the app's publisher supplies it (app secrets, shared config, a paid API the publisher pays for). " +
        "user = every visitor connects their OWN account (their LinkedIn session, their Notion). " +
        "If it is a paid API and you don't know who should pay, ask the user once.",
    ),
  required: z
    .boolean()
    .default(true)
    .describe("false when the app still works without it (a feature is just off). Visitors can skip optional keys."),
  service: z.string().optional().describe("Display name, e.g. 'OpenAI'. Inferred for well-known keys."),
  signupUrl: z.string().url().optional().describe("Where a visitor gets the key (only matters for provider: user)."),
  category: z.enum(SERVICE_CATEGORIES).optional(),
  clientAccess: z
    .enum(["server", "client"])
    .optional()
    .describe("client only for publishable browser keys (e.g. Stripe publishable). Default server."),
});

export type DeclaredKey = z.infer<typeof DeclaredKeySchema>;

function titleFromName(name: string): string {
  return name
    .replace(/_(API_KEY|KEY|TOKEN|SECRET)$/i, "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ") || name;
}

export function declaredKeyToSpec(key: DeclaredKey): RequiredKeySpec {
  const known = lookupService(key.name);
  return {
    name: key.name,
    service: key.service?.trim() || known?.service || titleFromName(key.name),
    category: (key.category ?? known?.category ?? "other") as ServiceCategory,
    description: key.purpose.trim(),
    required: key.required !== false,
    credentialScope: key.provider,
    clientAccess: key.clientAccess ?? "server",
    ...(key.signupUrl || known?.signupUrl
      ? { signupUrl: key.signupUrl ?? known?.signupUrl }
      : {}),
    ...(known?.docsUrl ? { docsUrl: known.docsUrl } : {}),
    ...(known?.instructions ? { instructions: known.instructions } : {}),
    ...(known?.freeTierNote ? { freeTierNote: known.freeTierNote } : {}),
  };
}

const declareAppKeysSchema = z.object({
  appId: z.string().min(1).describe("Mini-app id"),
  keys: z
    .array(DeclaredKeySchema)
    .default([])
    .describe("Keys to declare or update (matched by name; other declared keys are kept)."),
  notKeys: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Names found in the app's code that are NOT secrets — job parameters like ${TASK} or ${CAMPAIGN_JSON}. Removed from the key list and never shown to visitors.",
    ),
});

export const declareAppKeysTool = createTool({
  id: "declare_app_keys",
  description: `Declare the API keys a mini-app uses: what each is for, who provides it (owner = publisher, user = each visitor brings their own), and whether it is required.

Writes apps/{appId}/requirements.json, which is what apps.papr.ai shows visitors on the setup screen. Publishing is blocked while any key found in the app's backend/manifest.json or linked jobs (requiredKeys, \${NAME} in commands) is undeclared — the error lists them with suggestions (e.g. "in your vault → probably owner", "not credential-shaped → probably a parameter").

Call it when you add a key to an app or job, or when publish says keys are undeclared. Call with no keys to see what still needs declaring.
Example: declare_app_keys({ appId, keys: [{ name: "OPENAI_API_KEY", purpose: "Writes your drafts", provider: "owner", required: true }], notKeys: ["TASK"] })`,
  inputSchema: declareAppKeysSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof declareAppKeysSchema> }).context ??
      input;
    const startTime = performance.now();
    const { getPaprRoot } = await import("../utils/paprRoot.js");
    const { upsertDeclaredAppKeys, checkAppKeyDeclarations } = await import(
      "../../gateway/services/cloudAppRequirements.js"
    );
    const paprDir = getPaprRoot();

    if (args.keys.length > 0 || args.notKeys.length > 0) {
      upsertDeclaredAppKeys(
        paprDir,
        args.appId,
        args.keys.map(declaredKeyToSpec),
        args.notKeys,
      );
      const { notifyAppRequirementsChanged } = await import(
        "../../gateway/services/appRequirementsChanged.js"
      );
      notifyAppRequirementsChanged(args.appId);
    }

    const stillUndeclared = await checkAppKeyDeclarations(paprDir, args.appId);
    return {
      success: true,
      data: {
        appId: args.appId,
        declared: args.keys.map((key) => ({
          name: key.name,
          provider: key.provider,
          required: key.required !== false,
        })),
        notKeys: args.notKeys,
        stillUndeclared,
        readyToPublish: stillUndeclared.length === 0,
        message:
          stillUndeclared.length === 0
            ? "All keys declared. Republish (publish_cloud_app) if the app is already live so visitors see the change."
            : `Still undeclared: ${stillUndeclared.map((key) => key.name).join(", ")}. Declare them (or list them in notKeys) before publishing.`,
      },
      duration: performance.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  },
});

export const appKeysTools = [declareAppKeysTool];

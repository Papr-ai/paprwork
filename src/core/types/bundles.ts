import { z } from "zod";

export const BUNDLE_SCHEMA_VERSION = "1.0.0" as const;

// ---------------------------------------------------------------------------
// Service categories — enable "I use a different service" substitution
// ---------------------------------------------------------------------------

export const SERVICE_CATEGORIES = [
  "analytics",
  "database",
  "crm",
  "email",
  "payments",
  "storage",
  "messaging",
  "search",
  "monitoring",
  "auth",
  "ai",
  "notifications",
  "google",
  "github",
  "other",
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Rich key requirement spec — replaces bare key-name strings in manifests
// ---------------------------------------------------------------------------

export const RequiredKeySpecSchema = z.object({
  name: z.string().min(1),
  service: z.string().min(1),
  category: z.enum(SERVICE_CATEGORIES).default("other"),
  description: z.string().default(""),
  required: z.boolean().default(true),
  signupUrl: z.string().optional(),
  docsUrl: z.string().optional(),
  instructions: z.string().optional(),
  freeTier: z.boolean().optional(),
  freeTierNote: z.string().optional(),
});

export type RequiredKeySpec = z.infer<typeof RequiredKeySpecSchema>;

/**
 * Accepts either a bare key name string (legacy) or a full RequiredKeySpec
 * object. Bare strings are normalized into spec objects with only `name` set.
 */
export const RequirementItemSchema = z.union([
  z.string().min(1),
  RequiredKeySpecSchema,
]);

export type RequirementItem = z.infer<typeof RequirementItemSchema>;

/** Normalize a mixed requirements array to always produce RequiredKeySpec[] */
export function normalizeRequirements(
  items: RequirementItem[],
): RequiredKeySpec[] {
  return items.map((item) => {
    if (typeof item === "string") {
      return {
        name: item,
        service: item,
        category: "other" as ServiceCategory,
        description: "",
        required: true,
      };
    }
    return RequiredKeySpecSchema.parse(item);
  });
}

export const RuntimeTypeSchema = z.enum([
  "python",
  "node",
  "swift",
  "bash",
  "agent",
]);
export type RuntimeType = z.infer<typeof RuntimeTypeSchema>;

const BundleAppSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  entryFile: z.string().min(1),
  appPath: z.string().min(1),
  description: z.string().optional(),
});

const JobDependencySchema = z.object({
  jobId: z.string().min(1),
  onStatus: z
    .array(z.enum(["completed", "failed", "cancelled", "timed_out"]))
    .default(["completed"]),
});

const JobResourceSchema = z.object({
  cpu: z.string().optional(),
  memoryMb: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const JobSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: RuntimeTypeSchema,
  entryPoint: z.string().optional(),
  command: z.string().optional(),
  schedule: z.string().optional(),
  dependsOn: z.array(JobDependencySchema).default([]),
  env: z.record(z.string(), z.string()).default({}),
  resources: JobResourceSchema.optional(),
  outputTables: z.array(z.string()).default([]),
});

const SqliteIndexSchema = z.object({
  name: z.string().min(1),
  columns: z.array(z.string()).min(1),
  unique: z.boolean().default(false),
});

const SqliteTableSchema = z.object({
  name: z.string().min(1),
  primaryKey: z.string().optional(),
  columns: z.array(z.string()).default([]),
  indexes: z.array(SqliteIndexSchema).default([]),
});

const SqliteDatabaseSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  migrationsPath: z.string().min(1),
  tables: z.array(SqliteTableSchema).default([]),
});

const SyncSettingsSchema = z.object({
  preferredRoot: z.string().default("~/Papr"),
  bundleSubpath: z.string().default("bundles"),
  cloudReady: z.boolean().default(true),
});

const DeploymentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  runtimeTarget: z.enum(["local", "cloud", "hybrid"]),
  environment: z.record(z.string(), z.string()).default({}),
  notes: z.string().optional(),
});

export const BundleManifestSchema = z.object({
  schemaVersion: z.literal(BUNDLE_SCHEMA_VERSION),
  bundleId: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  createdAt: z.string().min(1),
  createdBy: z.string().min(1).optional(),
  minPaprworkVersion: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  requirements: z.array(RequirementItemSchema).default([]),
  platform: z
    .array(z.enum(["macos", "windows", "linux"]))
    .default(["macos", "windows", "linux"]),
  app: BundleAppSchema,
  jobs: z.array(JobSpecSchema).default([]),
  sqlite: z.array(SqliteDatabaseSchema).default([]),
  deploymentProfiles: z.array(DeploymentProfileSchema).default([]),
  sync: SyncSettingsSchema.default({
    preferredRoot: "~/Papr",
    bundleSubpath: "bundles",
    cloudReady: true,
  }),
});

export type BundleManifest = z.infer<typeof BundleManifestSchema>;
export type BundleAppSpec = z.infer<typeof BundleAppSchema>;
export type BundleJobSpec = z.infer<typeof JobSpecSchema>;
export type BundleDatabaseSpec = z.infer<typeof SqliteDatabaseSchema>;
export type BundleDeploymentProfile = z.infer<typeof DeploymentProfileSchema>;

export function parseBundleManifest(input: unknown): BundleManifest {
  return BundleManifestSchema.parse(input);
}

/**
 * Community registry entry schema — validated when fetching from GitHub.
 * Entries that don't pass validation are silently dropped so malformed
 * or malicious contributions never reach the UI.
 */
export const CommunityRegistryEntrySchema = z.object({
  bundleId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  author: z.string().min(1),
  tags: z.array(z.string()).default([]),
  minPaprworkVersion: z.string().min(1),
  path: z.string().min(1),
  icon: z.string().optional(),
  requirements: z.array(RequirementItemSchema).default([]),
  platform: z
    .array(z.enum(["macos", "windows", "linux"]))
    .default(["macos", "windows", "linux"]),
});

export type CommunityRegistryEntry = z.infer<
  typeof CommunityRegistryEntrySchema
>;

export const CommunityRegistrySchema = z.object({
  schemaVersion: z.string().min(1),
  bundles: z.array(z.unknown()).default([]),
});

/**
 * Parse and validate a community registry. Invalid entries are filtered out
 * rather than crashing the whole page.
 */
export function parseValidRegistryEntries(
  raw: unknown,
): { schemaVersion: string; bundles: CommunityRegistryEntry[] } {
  const registry = CommunityRegistrySchema.parse(raw);
  const valid: CommunityRegistryEntry[] = [];
  for (const entry of registry.bundles) {
    const result = CommunityRegistryEntrySchema.safeParse(entry);
    if (result.success) {
      valid.push(result.data);
    }
  }
  return { schemaVersion: registry.schemaVersion, bundles: valid };
}

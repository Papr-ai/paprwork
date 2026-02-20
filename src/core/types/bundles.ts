import { z } from "zod";

export const BUNDLE_SCHEMA_VERSION = "1.0.0" as const;

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
  env: z.record(z.string()).default({}),
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
  preferredRoot: z.string().default("~/PAPR"),
  bundleSubpath: z.string().default("bundles"),
  cloudReady: z.boolean().default(true),
});

const DeploymentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  runtimeTarget: z.enum(["local", "cloud", "hybrid"]),
  environment: z.record(z.string()).default({}),
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
  app: BundleAppSchema,
  jobs: z.array(JobSpecSchema).default([]),
  sqlite: z.array(SqliteDatabaseSchema).default([]),
  deploymentProfiles: z.array(DeploymentProfileSchema).default([]),
  sync: SyncSettingsSchema.default({
    preferredRoot: "~/PAPR",
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

/**
 * Service Connectors - Provision cloud services via Stripe Projects CLI
 *
 * Wraps the Stripe Projects CLI to let agents provision databases, hosting,
 * auth, analytics, and other services with a single tool call. Credentials
 * are auto-stored in the system keychain via CustomKeysService.
 *
 * Supported providers: Neon, Supabase, Vercel, Railway, Cloudflare, Clerk,
 * PostHog, Amplitude, Mixpanel, OpenRouter, Hugging Face, and more.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";
import type { ToolResult } from "../types/index.js";

const execFileAsync = promisify(execFile);

const STRIPE_CLI_TIMEOUT_MS = 30_000;
const PROVISION_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 60_000;

/** Dedicated directory for Stripe Projects config & state */
const STRIPE_PROJECT_DIR = join(homedir(), "Papr", "stripe-project");

interface ExecResult {
  stdout: string;
  stderr: string;
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
): Promise<ExecResult> {
  try {
    const result = await execFileAsync(command, args, {
      timeout: timeoutMs,
      env: { ...process.env },
      shell: true,
      ...(cwd ? { cwd } : {}),
    });
    return { stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error: unknown) {
    const execError = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message?: string;
    };
    return {
      stdout: execError.stdout || "",
      stderr: execError.stderr || execError.message || "Unknown error",
    };
  }
}

async function isStripeCliInstalled(): Promise<boolean> {
  const result = await runCommand("which", ["stripe"], STRIPE_CLI_TIMEOUT_MS);
  return result.stdout.trim().length > 0 && !result.stderr.includes("not found");
}

async function isProjectsPluginInstalled(): Promise<boolean> {
  const result = await runCommand(
    "stripe",
    ["projects", "--help"],
    STRIPE_CLI_TIMEOUT_MS,
  );
  return !result.stderr.includes("unknown command") && !result.stderr.includes("not found");
}

async function installStripeCli(): Promise<{ success: boolean; message: string }> {
  const platform = process.platform;

  let cmd: string;
  let args: string[];

  if (platform === "darwin") {
    cmd = "brew";
    args = ["install", "stripe/stripe-cli/stripe"];
  } else if (platform === "win32") {
    cmd = "winget";
    args = ["install", "Stripe.StripeCLI", "--silent"];
  } else {
    cmd = "sh";
    args = [
      "-c",
      'curl -s https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public | gpg --dearmor | sudo tee /usr/share/keyrings/stripe.gpg > /dev/null && echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" | sudo tee -a /etc/apt/sources.list.d/stripe.list > /dev/null && sudo apt update && sudo apt install stripe',
    ];
  }

  const result = await runCommand(cmd, args, INSTALL_TIMEOUT_MS);

  if (result.stderr && !result.stdout.includes("stripe")) {
    return {
      success: false,
      message: `Failed to install Stripe CLI: ${result.stderr.substring(0, 200)}`,
    };
  }

  return { success: true, message: "Stripe CLI installed successfully." };
}

async function installProjectsPlugin(): Promise<{ success: boolean; message: string }> {
  const result = await runCommand(
    "stripe",
    ["plugin", "install", "projects"],
    INSTALL_TIMEOUT_MS,
  );

  if (result.stderr.includes("error") || result.stderr.includes("failed")) {
    return {
      success: false,
      message: `Failed to install projects plugin: ${result.stderr.substring(0, 200)}`,
    };
  }

  return { success: true, message: "Stripe Projects plugin installed." };
}

async function checkAuthentication(): Promise<boolean> {
  const result = await runCommand(
    "stripe",
    ["projects", "status", "--json"],
    STRIPE_CLI_TIMEOUT_MS,
  );

  const combined = result.stdout + result.stderr;
  const isUnauthenticated =
    combined.includes("not logged in") ||
    combined.includes("authentication") ||
    combined.includes("login") ||
    combined.includes("unauthorized") ||
    combined.includes("API key");

  if (isUnauthenticated && !combined.includes('"name"')) {
    return false;
  }

  return true;
}

async function ensureStripeReady(): Promise<ToolResult | null> {
  if (!(await isStripeCliInstalled())) {
    const installResult = await installStripeCli();
    if (!installResult.success) {
      return {
        success: false,
        error: installResult.message,
        data: {
          status: "cli_not_installed",
          instructions:
            "Install the Stripe CLI manually: https://docs.stripe.com/stripe-cli/install",
        },
      };
    }
  }

  if (!(await isProjectsPluginInstalled())) {
    const pluginResult = await installProjectsPlugin();
    if (!pluginResult.success) {
      return {
        success: false,
        error: pluginResult.message,
        data: {
          status: "plugin_not_installed",
          instructions:
            "Install manually: stripe plugin install projects",
        },
      };
    }
  }

  if (!(await checkAuthentication())) {
    return {
      success: false,
      data: {
        status: "needs_auth",
        message:
          "Stripe authentication required. Run `stripe login` via the bash tool to open the browser for one-time authentication. After logging in, retry this action.",
        instructions: [
          "1. Call bash({ command: 'stripe login' }) to open browser authentication",
          "2. User completes login in browser",
          "3. Retry the connect_service action",
        ],
      },
    };
  }

  return null;
}

async function ensureProjectInitialized(
  projectName: string,
): Promise<{ success: boolean; message: string }> {
  // Ensure dedicated project directory exists
  mkdirSync(STRIPE_PROJECT_DIR, { recursive: true });

  const statusResult = await runCommand(
    "stripe",
    ["projects", "status", "--json"],
    STRIPE_CLI_TIMEOUT_MS,
    STRIPE_PROJECT_DIR,
  );

  if (
    statusResult.stderr.includes("no project") ||
    statusResult.stderr.includes("not initialized") ||
    statusResult.stdout.includes('"error"')
  ) {
    const initResult = await runCommand(
      "stripe",
      ["projects", "init", projectName, "--no-interactive"],
      STRIPE_CLI_TIMEOUT_MS,
      STRIPE_PROJECT_DIR,
    );
    if (initResult.stderr.includes("error")) {
      return {
        success: false,
        message: `Failed to initialize project: ${initResult.stderr.substring(0, 200)}`,
      };
    }
    return {
      success: true,
      message: `Project '${projectName}' initialized.`,
    };
  }

  return { success: true, message: "Project already initialized." };
}

function parseEnvVarsFromOutput(output: string): Record<string, string> {
  const envVars: Record<string, string> = {};

  try {
    const parsed = JSON.parse(output);

    if (parsed.environment_variables) {
      for (const [key, value] of Object.entries(parsed.environment_variables)) {
        if (typeof value === "string" && value.length > 0) {
          envVars[key] = value;
        }
      }
    }

    if (parsed.credentials) {
      for (const [key, value] of Object.entries(parsed.credentials)) {
        if (typeof value === "string" && value.length > 0) {
          envVars[key] = value;
        }
      }
    }

    if (parsed.env) {
      for (const [key, value] of Object.entries(parsed.env)) {
        if (typeof value === "string" && value.length > 0) {
          envVars[key] = value;
        }
      }
    }
  } catch {
    const envPattern = /^([A-Z_][A-Z0-9_]*)=(.+)$/gm;
    let match;
    while ((match = envPattern.exec(output)) !== null) {
      envVars[match[1]] = match[2];
    }
  }

  return envVars;
}

async function storeCredentials(
  envVars: Record<string, string>,
  provider: string,
): Promise<string[]> {
  const { getCustomKeysService } = await import(
    "../../gateway/services/CustomKeysService.js"
  );
  const service = getCustomKeysService();
  const storedKeys: string[] = [];

  for (const [name, value] of Object.entries(envVars)) {
    try {
      await service.addKey({
        name,
        value,
        description: `Auto-provisioned via Stripe Projects (${provider})`,
        permission: "always",
      });
      storedKeys.push(name);
    } catch (error) {
      console.warn(
        `[connect_service] Failed to store key ${name}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return storedKeys;
}

export const connectServiceTool = createTool({
  id: "connect_service",
  description:
    "Provision cloud services (databases, hosting, auth, analytics) via Stripe Projects. " +
    "Handles CLI setup, authentication, provisioning, and credential storage automatically. " +
    "Actions: 'catalog' (browse available services), 'add' (provision and store credentials), " +
    "'status' (check provisioned services), 'remove' (remove a service). " +
    "Credentials are auto-stored in the keychain — use ${KEY_NAME} in jobs/bash after provisioning. " +
    "If a service is NOT in the catalog, fall back to manual setup: guide the user to sign up " +
    "at the provider's website, then use request_key() or set_key() to store their credentials.",
  inputSchema: z.object({
    action: z
      .enum(["catalog", "add", "status", "remove"])
      .describe(
        "Action: 'catalog' = browse services, 'add' = provision + store creds, " +
        "'status' = check provisioned, 'remove' = deprovision",
      ),
    provider: z
      .string()
      .optional()
      .describe(
        "Provider name (e.g., 'neon', 'supabase', 'vercel', 'clerk', 'posthog'). " +
        "For catalog action, optionally filter by provider or category.",
      ),
    service: z
      .string()
      .optional()
      .describe(
        "Service name (e.g., 'database', 'auth', 'analytics', 'project'). " +
        "Required for 'add' and 'remove' actions.",
      ),
    project: z
      .string()
      .optional()
      .describe(
        "Stripe project name. Auto-created as 'paprwork-default' if not specified.",
      ),
  }),
  execute: async (inputData): Promise<ToolResult> => {
    const args = (inputData as Record<string, unknown>).context
      ? ((inputData as Record<string, unknown>).context as {
          action: string;
          provider?: string;
          service?: string;
          project?: string;
        })
      : (inputData as {
          action: string;
          provider?: string;
          service?: string;
          project?: string;
        });
    const startTime = performance.now();

    try {
      const readyError = await ensureStripeReady();
      if (readyError) {
        return {
          ...readyError,
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      switch (args.action) {
        case "catalog": {
          const catalogArgs = ["projects", "catalog", "--json"];
          if (args.provider) {
            catalogArgs.splice(2, 0, args.provider);
          }

          const result = await runCommand(
            "stripe",
            catalogArgs,
            STRIPE_CLI_TIMEOUT_MS,
            STRIPE_PROJECT_DIR,
          );

          let catalogData: unknown;
          try {
            catalogData = JSON.parse(result.stdout);
          } catch {
            catalogData = result.stdout.trim();
          }

          return {
            success: true,
            data: {
              catalog: catalogData,
              message: args.provider
                ? `Showing services for provider: ${args.provider}`
                : "Full service catalog. Use provider/service with 'add' action to provision.",
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "add": {
          if (!args.provider || !args.service) {
            return {
              success: false,
              error:
                "Both 'provider' and 'service' are required for the 'add' action. " +
                "Example: connect_service({ action: 'add', provider: 'neon', service: 'database' })",
              duration: performance.now() - startTime,
              timestamp: new Date().toISOString(),
            };
          }

          const projectName = args.project || "paprwork-default";
          const initResult = await ensureProjectInitialized(projectName);
          if (!initResult.success) {
            return {
              success: false,
              error: initResult.message,
              duration: performance.now() - startTime,
              timestamp: new Date().toISOString(),
            };
          }

          const providerService = `${args.provider}/${args.service}`;
          const addResult = await runCommand(
            "stripe",
            [
              "projects",
              "add",
              providerService,
              "--json",
              "--auto-confirm",
            ],
            PROVISION_TIMEOUT_MS,
            STRIPE_PROJECT_DIR,
          );

          if (
            addResult.stderr.includes("error") &&
            !addResult.stdout.includes('"')
          ) {
            return {
              success: false,
              error: `Failed to provision ${providerService}: ${addResult.stderr.substring(0, 300)}`,
              data: {
                provider: args.provider,
                service: args.service,
                fallback:
                  "If this provider requires account linking first, try: " +
                  `bash({ command: 'stripe projects link ${args.provider}' }) then retry.`,
              },
              duration: performance.now() - startTime,
              timestamp: new Date().toISOString(),
            };
          }

          const outputToParse = addResult.stdout || addResult.stderr;
          const envVars = parseEnvVarsFromOutput(outputToParse);
          const storedKeys = await storeCredentials(envVars, args.provider);

          if (storedKeys.length === 0) {
            const envSyncResult = await runCommand(
              "stripe",
              ["projects", "env", "--pull", "--json"],
              STRIPE_CLI_TIMEOUT_MS,
              STRIPE_PROJECT_DIR,
            );
            const syncedVars = parseEnvVarsFromOutput(
              envSyncResult.stdout || envSyncResult.stderr,
            );
            const syncedKeys = await storeCredentials(syncedVars, args.provider);

            if (syncedKeys.length > 0) {
              return {
                success: true,
                data: {
                  provider: args.provider,
                  service: args.service,
                  keys_stored: syncedKeys,
                  key_usage: syncedKeys.map(
                    (k) => `Use \${${k}} in jobs and bash commands`,
                  ),
                  message: `Provisioned ${providerService}. Stored ${syncedKeys.length} credential(s) in keychain.`,
                },
                duration: performance.now() - startTime,
                timestamp: new Date().toISOString(),
              };
            }

            return {
              success: true,
              data: {
                provider: args.provider,
                service: args.service,
                keys_stored: [],
                raw_output: addResult.stdout.substring(0, 500),
                message:
                  `Provisioned ${providerService} but could not auto-extract credentials. ` +
                  "Run `stripe projects env` via bash to check environment variables, " +
                  "then use set_key() to store them manually.",
              },
              duration: performance.now() - startTime,
              timestamp: new Date().toISOString(),
            };
          }

          return {
            success: true,
            data: {
              provider: args.provider,
              service: args.service,
              keys_stored: storedKeys,
              key_usage: storedKeys.map(
                (k) => `Use \${${k}} in jobs and bash commands`,
              ),
              message: `Provisioned ${providerService}. Stored ${storedKeys.length} credential(s) in keychain.`,
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "status": {
          mkdirSync(STRIPE_PROJECT_DIR, { recursive: true });
          const result = await runCommand(
            "stripe",
            ["projects", "status", "--json"],
            STRIPE_CLI_TIMEOUT_MS,
            STRIPE_PROJECT_DIR,
          );

          let statusData: unknown;
          try {
            statusData = JSON.parse(result.stdout);
          } catch {
            statusData = result.stdout.trim();
          }

          return {
            success: true,
            data: {
              status: statusData,
              message: "Current project status and provisioned services.",
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "remove": {
          if (!args.provider || !args.service) {
            return {
              success: false,
              error:
                "Both 'provider' and 'service' are required for the 'remove' action.",
              duration: performance.now() - startTime,
              timestamp: new Date().toISOString(),
            };
          }

          const providerService = `${args.provider}/${args.service}`;
          const result = await runCommand(
            "stripe",
            [
              "projects",
              "remove",
              providerService,
              "--json",
              "--auto-confirm",
            ],
            PROVISION_TIMEOUT_MS,
            STRIPE_PROJECT_DIR,
          );

          if (
            result.stderr.includes("error") &&
            !result.stdout.includes('"')
          ) {
            return {
              success: false,
              error: `Failed to remove ${providerService}: ${result.stderr.substring(0, 300)}`,
              duration: performance.now() - startTime,
              timestamp: new Date().toISOString(),
            };
          }

          return {
            success: true,
            data: {
              provider: args.provider,
              service: args.service,
              message: `Removed ${providerService}. Note: associated keys in Settings are NOT automatically removed — delete them manually if no longer needed.`,
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        default:
          return {
            success: false,
            error: `Unknown action: ${args.action}. Use 'catalog', 'add', 'status', or 'remove'.`,
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
      }
    } catch (error) {
      throw new Error(
        JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  },
});

export const connectorsTools = [connectServiceTool];

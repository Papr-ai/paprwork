/**
 * Stripe Projects Provisioning Tool
 * 
 * MINIMAL tool that does ONE thing: provision a service and automatically store credentials.
 * For everything else (catalog search, authentication, status), agent should use Stripe CLI directly via bash.
 * 
 * Why this tool exists: Automatic credential extraction and storage prevents agent from forgetting to store keys.
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

async function checkStripeInstalled(): Promise<boolean> {
  try {
    const result = await runCommand("stripe", ["--version"], 5000);
    return result.stdout.includes("stripe") || !result.stderr.includes("not found");
  } catch {
    return false;
  }
}

async function ensureStripeReady(): Promise<ToolResult | null> {
  // First check if Stripe CLI is installed
  const isInstalled = await checkStripeInstalled();
  
  if (!isInstalled) {
    return {
      success: false,
      data: {
        status: "needs_install",
        message: "Stripe CLI not installed. Use the official installer (works for all users, no brew/npm required).",
        instructions: [
          "1. Run: bash({ command: 'curl -fsSL https://cli.stripe.com/install.sh | bash' })",
          "2. The installer places stripe in /tmp/ temporarily",
          "3. Move it to a permanent location: bash({ command: 'sudo mv /tmp/stripe /usr/local/bin/stripe && sudo chmod +x /usr/local/bin/stripe' })",
          "4. Verify installation: bash({ command: 'stripe --version' })",
          "5. If shell needs refresh: bash({ command: 'source ~/.zshrc' }) or bash({ command: 'source ~/.bashrc' })",
          "6. Then authenticate: shell.openExternal({ url: 'https://dashboard.stripe.com/login' }) → bash({ command: 'stripe login --interactive' })",
          "7. Retry provision_service() after setup completes",
        ],
        one_liner: "curl -fsSL https://cli.stripe.com/install.sh | bash && sudo mv /tmp/stripe /usr/local/bin/stripe && sudo chmod +x /usr/local/bin/stripe",
      },
    };
  }

  // Check authentication
  if (!(await checkAuthentication())) {
    return {
      success: false,
      data: {
        status: "needs_auth",
        message:
          "Stripe authentication required. Use shell.openExternal() to open the Stripe dashboard for authentication, OR run `stripe login` via bash if browser doesn't open automatically.",
        instructions: [
          "1. PREFERRED: shell.openExternal({ url: 'https://dashboard.stripe.com/login' })",
          "2. User logs in to Stripe dashboard",
          "3. Run: bash({ command: 'stripe login --interactive' }) to complete CLI pairing",
          "4. Retry provision_service() after authentication succeeds",
        ],
        manual_url: "https://dashboard.stripe.com/login",
        fallback_command: "stripe login --interactive",
      },
    };
  }

  return null;
}

async function ensureProjectInitialized(
  projectName: string,
): Promise<{ success: boolean; message: string }> {
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
        `[provision_service] Failed to store key ${name}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return storedKeys;
}

export const provisionServiceTool = createTool({
  id: "provision_service",
  description:
    "Provision a cloud service via Stripe Projects and automatically store credentials in keychain. " +
    "This is the ONLY Stripe Projects tool - for everything else (checking catalog, authentication, status), " +
    "use the Stripe CLI directly via bash. " +
    "Example: provision_service({ provider: 'neon', service: 'database' }) → provisions AND stores NEON_DATABASE_URL automatically. " +
    "The tool guarantees credentials are stored, preventing jobs/apps from failing due to missing keys.",
  inputSchema: z.object({
    provider: z
      .string()
      .describe("Provider name (e.g., 'neon', 'supabase', 'vercel', 'clerk', 'posthog')"),
    service: z
      .string()
      .describe("Service name (e.g., 'database', 'project', 'postgres', 'analytics')"),
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
          provider: string;
          service: string;
          project?: string;
        })
      : (inputData as {
          provider: string;
          service: string;
          project?: string;
        });
    const startTime = performance.now();

    try {
      // Check authentication
      const readyError = await ensureStripeReady();
      if (readyError) {
        return {
          ...readyError,
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      // Ensure project is initialized
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

      // Provision the service
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
              `bash({ command: 'cd ~/Papr/stripe-project && stripe projects link ${args.provider}' }) then retry.`,
          },
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      // Parse and auto-store credentials (THE KEY FEATURE)
      const outputToParse = addResult.stdout || addResult.stderr;
      const envVars = parseEnvVarsFromOutput(outputToParse);
      const storedKeys = await storeCredentials(envVars, args.provider);

      if (storedKeys.length === 0) {
        // Try pulling from Stripe Projects env if not in output
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
              credentials_stored: syncedKeys,
              usage_example: syncedKeys.map(
                (k) => `Use \${${k}} in jobs and bash commands`,
              ),
              message: `✓ Provisioned ${providerService}. Auto-stored ${syncedKeys.length} credential(s) in keychain.`,
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
            credentials_stored: [],
            raw_output: addResult.stdout.substring(0, 500),
            message:
              `Provisioned ${providerService} but could not auto-extract credentials. ` +
              "Run \`bash({ command: 'cd ~/Papr/stripe-project && stripe projects env' })\` to check environment variables, " +
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
          credentials_stored: storedKeys,
          usage_example: storedKeys.map(
            (k) => `Use \${${k}} in jobs and bash commands`,
          ),
          message: `✓ Provisioned ${providerService}. Auto-stored ${storedKeys.length} credential(s) in keychain.`,
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
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

export const connectorsTools = [provisionServiceTool];

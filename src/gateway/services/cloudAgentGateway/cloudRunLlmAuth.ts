/**
 * The LLM credential of the cloud agent run in progress, for helper agents it
 * starts (delegate_task → product-architect, research-specialist, …).
 *
 * The run's credential arrives on the request (llmAuth) and only the main
 * session received it as authOverride. A delegated sub-agent job resolved its
 * own auth from process env, found no keys (the cloud gateway has no keychain
 * or Electron IPC) and fell back to local Ollama, which does not exist in the
 * cloud — the delegation never finished and create_app stayed gated.
 *
 * Set when a run resolves its stream input, cleared when the run ends, so a
 * credential never outlives the run (or reaches another user's run).
 */
import type { Provider } from "../../../core/types/agents.js";
import type { CloudProviderAuthResolution } from "./types.js";

let active: CloudProviderAuthResolution | null = null;

export function setActiveCloudRunLlmAuth(auth: CloudProviderAuthResolution | null): void {
  active = auth;
}

export function getActiveCloudRunLlmAuth(): CloudProviderAuthResolution | null {
  return process.env.GATEWAY_MODE === "cloud_agent" ? active : null;
}

const sameFamily = (a: Provider, b: Provider) =>
  a === b || (a.startsWith("openai") && b.startsWith("openai"));

/**
 * Auth for a helper job inside a cloud run. The credential decides the provider:
 * keep the job's model when it is the same provider, otherwise let the resolver
 * pick the credential provider's default (same rule as pickCloudJobProviderModel).
 */
export function cloudRunHelperAuth(
  jobProvider: Provider | undefined,
  jobModel: string | undefined,
): {
  provider: Provider;
  model: string | undefined;
  authOverride: { apiKey: string; authType: "oauth" | "apiKey"; usePaprProxy?: boolean };
} | null {
  const auth = getActiveCloudRunLlmAuth();
  if (!auth) return null;
  const keep = !jobProvider || sameFamily(jobProvider, auth.provider);
  return {
    provider: keep ? (jobProvider ?? auth.provider) : auth.provider,
    model: keep ? jobModel : undefined,
    authOverride: {
      apiKey: auth.token,
      authType: auth.authType,
      ...(auth.usePaprProxy ? { usePaprProxy: true } : {}),
    },
  };
}

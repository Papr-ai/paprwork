/**
 * Contribute-back change requests for cloud-installed forks.
 */

const GATEWAY =
  typeof import.meta !== "undefined" &&
  import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

export interface SubmitCloudAppChangeInput {
  sourceNamespaceId: string;
  sourceSlug: string;
  installedAppId: string;
  title: string;
  description: string;
}

export interface SubmitCloudAppChangeResult {
  id: string;
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  headSha?: string;
  status?: string;
}

export async function submitCloudAppChange(
  input: SubmitCloudAppChangeInput,
): Promise<SubmitCloudAppChangeResult> {
  const res = await fetch(`${GATEWAY}/api/cloud/apps/changes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as SubmitCloudAppChangeResult & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed (${res.status})`);
  }
  return body;
}

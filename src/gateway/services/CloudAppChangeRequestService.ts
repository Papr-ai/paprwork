/**
 * Fetch contribute-back change requests from the memory server (owner incoming list).
 */

import { cloudApiFetch } from "../utils/cloudApiClient.js";

export interface ChangeRequestRecord {
  id: string;
  sourceAppId: string;
  installedAppId: string;
  status: string;
  prUrl?: string | null;
  prNumber?: number | null;
}

async function fetchIncomingChangeRequests(): Promise<ChangeRequestRecord[]> {
  const response = await cloudApiFetch("/v1/cloud/apps/changes/incoming");
  if (!response.ok) {
    return [];
  }
  const body = (await response.json()) as { requests?: ChangeRequestRecord[] };
  return body.requests ?? [];
}

export class CloudAppChangeRequestService {
  async getChangeRequest(requestId: string): Promise<ChangeRequestRecord | null> {
    const requests = await fetchIncomingChangeRequests();
    return requests.find((r) => r.id === requestId) ?? null;
  }
}

let instance: CloudAppChangeRequestService | null = null;

export function getCloudAppChangeRequestService(): CloudAppChangeRequestService {
  if (!instance) {
    instance = new CloudAppChangeRequestService();
  }
  return instance;
}

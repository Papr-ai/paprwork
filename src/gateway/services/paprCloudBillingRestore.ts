/**
 * Clears gateway Papr Cloud pause after billing is restored (active/trialing).
 */

import { setPaprCloudPaused } from "../../core/utils/paprQuota.js";
import { resumeCodeIndexingAfterBillingRestore } from "./CodeIndexingService.js";
import { getVaultSyncService } from "./VaultSyncService.js";

export async function resumePaprCloudAfterBillingRestore(): Promise<void> {
  setPaprCloudPaused(false);
  resumeCodeIndexingAfterBillingRestore();

  const vault = getVaultSyncService();
  if (vault) {
    void vault.runFullSync();
  }
}

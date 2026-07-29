/**
 * OrgKeysVaultBanner - Shows which organization vault Settings keys belong to
 */

import React from "react";
import type { CustomKeysVaultContext } from "../../hooks/useCustomKeys";
import "./OrgKeysVaultBanner.css";

interface OrgKeysVaultBannerProps {
  vaultContext: CustomKeysVaultContext | null;
  workspaceName?: string | null;
  namespaceName?: string | null;
}

export function OrgKeysVaultBanner({
  vaultContext,
  workspaceName,
  namespaceName,
}: OrgKeysVaultBannerProps) {
  if (!vaultContext?.organizationId) {
    return (
      <div className="org-keys-vault-banner org-keys-vault-banner--local">
        <p>
          Keys are stored locally on this device. Sign in to Papr and select an organization
          to use per-organization key vaults.
        </p>
      </div>
    );
  }

  const orgLabel = workspaceName?.trim() || vaultContext.organizationId;
  const teamSuffix = namespaceName ? ` · team ${namespaceName}` : "";

  return (
    <div className="org-keys-vault-banner">
      <p>
        Integration and model keys are stored per organization. Showing keys for{" "}
        <strong>{orgLabel}</strong>
        {teamSuffix}. Switch organization or team above to manage a different vault.
        Papr Memory uses a separate namespace API key (<code>PAPR_API_KEY</code>).
      </p>
    </div>
  );
}

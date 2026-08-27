/**
 * Product/edition metadata for telemetry events.
 * Packaged Paprwork = commercial product; dev builds = open-source style.
 */

export type TelemetryEdition = "paprwork" | "paprwork-dev" | "opensource";

export interface TelemetryProductContext {
  product: "paprwork";
  edition: TelemetryEdition;
  is_oss: boolean;
  is_packaged: boolean;
}

/** Read from gateway/main env (set by Electron on spawn). */
export function isTelemetryPackagedFromEnv(): boolean {
  return process.env.PAPRWORK_IS_PACKAGED === "true";
}

export function resolvePaprworkProductContext(
  isPackaged: boolean,
): TelemetryProductContext {
  return {
    product: "paprwork",
    edition: isPackaged ? "paprwork" : "paprwork-dev",
    is_oss: !isPackaged,
    is_packaged: isPackaged,
  };
}

/** Parse account id for Amplitude (survives proxy allowlist; not PII). */
export function paprAccountProperty(
  paprAccountId: string,
): Record<string, string> {
  return { papr_account_id: paprAccountId };
}

/**
 * Workspace identity for per-customer analytics.
 *
 * Cloud-side events already carry namespace_id/organization_id, so desktop
 * events without them cannot be joined to a customer: we could see that an
 * agency's published app got N visitors, but not how many apps that agency
 * built. These are workspace identifiers, not user identifiers — no PII.
 */
export function workspaceIdentityProperties(options: {
  namespaceId?: string;
  organizationId?: string;
}): Record<string, string> {
  const props: Record<string, string> = {};
  const namespaceId = options.namespaceId?.trim();
  const organizationId = options.organizationId?.trim();
  if (namespaceId) {
    props.namespace_id = namespaceId;
  }
  if (organizationId) {
    props.organization_id = organizationId;
  }
  return props;
}

export function mergeTelemetryEnvelope(
  base: Record<string, unknown>,
  options: {
    isPackaged?: boolean;
    paprAccountId?: string;
    namespaceId?: string;
    organizationId?: string;
  },
): Record<string, unknown> {
  const isPackaged = options.isPackaged ?? isTelemetryPackagedFromEnv();
  const merged: Record<string, unknown> = {
    ...resolvePaprworkProductContext(isPackaged),
    ...workspaceIdentityProperties(options),
    ...base,
  };
  const accountId = options.paprAccountId?.trim();
  if (accountId) {
    Object.assign(merged, paprAccountProperty(accountId));
  }
  return merged;
}

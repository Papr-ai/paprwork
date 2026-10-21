/**
 * Provider purposes and capabilities (BUILD_PLAN.md §5.1).
 * A campaign may run only if its purpose is permitted by BOTH the adapter (the provider's terms)
 * and the account (what the operator attests their contract allows).
 */
export const PROVIDER_PURPOSES = [
  'manual_correspondence',
  'transactional',
  'automated_outreach',
  'marketing',
  'bulk',
] as const;

export type ProviderPurpose = (typeof PROVIDER_PURPOSES)[number];

export interface CapabilitySnapshot {
  readonly provider: string;
  readonly send: boolean;
  readonly replyInThread: boolean;
  /** Whether we can set Message-ID and List-Unsubscribe headers. */
  readonly customHeaders: boolean;
  /** Whether the provider deduplicates on our idempotency key. */
  readonly externalIdempotency: boolean;
  readonly inboundWebhook: boolean;
  readonly mailboxPolling: boolean;
  readonly reconcileBySentSearch: boolean;
  readonly maxRecipientsPerMessage: number;
  readonly discoveredAt: number;
}

export function isProviderPurpose(value: unknown): value is ProviderPurpose {
  return typeof value === 'string' && (PROVIDER_PURPOSES as readonly string[]).includes(value);
}

export function purposePermitted(
  purpose: ProviderPurpose,
  adapterPurposes: readonly ProviderPurpose[],
  accountPurposes: readonly ProviderPurpose[],
): boolean {
  return adapterPurposes.includes(purpose) && accountPurposes.includes(purpose);
}

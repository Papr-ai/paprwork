/**
 * Playbook and API version this contracts package describes.
 * Every playbook and API payload carries this value in `apiVersion`.
 */
export const OUTREACH_API_VERSION = 'outreach.splitin.net/v1alpha1' as const;

export type OutreachApiVersion = typeof OUTREACH_API_VERSION;

export function isSupportedApiVersion(value: unknown): value is OutreachApiVersion {
  return value === OUTREACH_API_VERSION;
}

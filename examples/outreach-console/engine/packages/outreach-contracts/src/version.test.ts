import { describe, expect, it } from 'vitest';
import { OUTREACH_API_VERSION, isSupportedApiVersion } from './version';

describe('isSupportedApiVersion', () => {
  it('accepts the current API version', () => {
    expect(isSupportedApiVersion(OUTREACH_API_VERSION)).toBe(true);
  });

  it('rejects other versions and non-strings', () => {
    expect(isSupportedApiVersion('outreach.splitin.net/v1')).toBe(false);
    expect(isSupportedApiVersion(undefined)).toBe(false);
    expect(isSupportedApiVersion(1)).toBe(false);
  });
});

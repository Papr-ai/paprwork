import { describe, expect, it } from 'vitest';
import { purposePermitted } from './capabilities';

describe('purposePermitted', () => {
  it('requires both the adapter and the account to permit the purpose', () => {
    expect(purposePermitted('automated_outreach', ['automated_outreach'], ['automated_outreach'])).toBe(true);
    expect(purposePermitted('automated_outreach', ['manual_correspondence'], ['automated_outreach'])).toBe(false);
    expect(purposePermitted('automated_outreach', ['automated_outreach'], ['manual_correspondence'])).toBe(false);
  });
});

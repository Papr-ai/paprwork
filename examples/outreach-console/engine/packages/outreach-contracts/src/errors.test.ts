import { describe, expect, it } from 'vitest';
import { ERROR_CLASSES, ERROR_DISPOSITIONS, isErrorClass } from './errors';

describe('error taxonomy', () => {
  it('has a disposition for every class', () => {
    expect(Object.keys(ERROR_DISPOSITIONS).sort()).toEqual([...ERROR_CLASSES].sort());
  });

  it('never retries classes that mean the recipient or account is bad', () => {
    for (const cls of ['invalid_recipient', 'hard_bounce', 'auth_revoked', 'forbidden', 'complaint', 'unsupported'] as const) {
      expect(ERROR_DISPOSITIONS[cls].retry).toBe('never');
    }
  });

  it('gives non-retried classes a terminal state and retried classes none', () => {
    for (const cls of ERROR_CLASSES) {
      const disposition = ERROR_DISPOSITIONS[cls];
      expect(disposition.retry === 'never').toBe(disposition.terminal !== null);
    }
  });

  it('recognises classes', () => {
    expect(isErrorClass('rate_limited')).toBe(true);
    expect(isErrorClass('HTTP 500')).toBe(false);
  });
});

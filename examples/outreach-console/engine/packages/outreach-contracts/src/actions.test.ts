import { describe, expect, it } from 'vitest';
import {
  ACTION_STATES,
  ACTION_TRANSITIONS,
  CANCELLABLE_ACTION_STATES,
  InvalidTransitionError,
  TERMINAL_ACTION_STATES,
  assertTransition,
  canTransition,
} from './actions';

describe('action transition table', () => {
  it('is closed: every target is a known state and every state has an entry', () => {
    expect(Object.keys(ACTION_TRANSITIONS).sort()).toEqual([...ACTION_STATES].sort());
    for (const targets of Object.values(ACTION_TRANSITIONS)) {
      for (const target of targets) expect(ACTION_STATES).toContain(target);
    }
  });

  it('has no exits from terminal states', () => {
    for (const state of TERMINAL_ACTION_STATES) expect(ACTION_TRANSITIONS[state]).toEqual([]);
  });

  it('lets every cancellable state be cancelled', () => {
    for (const state of CANCELLABLE_ACTION_STATES) expect(canTransition(state, 'cancelled')).toBe(true);
  });

  it('never lets executing or uncertain actions be cancelled or rescheduled directly', () => {
    for (const state of ['executing', 'uncertain'] as const) {
      expect(canTransition(state, 'cancelled')).toBe(false);
      expect(canTransition(state, 'scheduled')).toBe(false);
      expect(canTransition(state, 'claimed')).toBe(false);
    }
  });

  it('only reaches executing from claimed', () => {
    const sources = ACTION_STATES.filter((state) => canTransition(state, 'executing'));
    expect(sources).toEqual(['claimed']);
  });

  it('only reaches scheduled from uncertain via reconciliation or review', () => {
    const intoScheduled = ACTION_STATES.filter((state) => canTransition(state, 'scheduled'));
    expect(intoScheduled).not.toContain('uncertain');
    expect(intoScheduled).not.toContain('executing');
  });

  it('throws a typed error on invalid transitions', () => {
    expect(() => assertTransition('succeeded', 'scheduled')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('scheduled', 'claimed')).not.toThrow();
  });
});

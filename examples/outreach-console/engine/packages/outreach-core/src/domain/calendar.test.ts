import fc from 'fast-check';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { addDuration, nextSlot, resolveZone, type SendWindow } from './calendar';

const WINDOW: SendWindow = { timezone: 'recipient', fallback: 'America/New_York', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], start: '09:30', end: '16:30' };
const at = (iso: string, zone: string) => DateTime.fromISO(iso, { zone }).toMillis();
const show = (ms: number, zone: string) => DateTime.fromMillis(ms, { zone }).toFormat("ccc yyyy-MM-dd'T'HH:mm");

describe('nextSlot', () => {
  it('keeps an instant already inside the window', () => {
    const t = at('2025-03-04T10:00', 'America/New_York');
    expect(nextSlot(t, WINDOW, 'America/New_York')).toBe(t);
  });

  it('moves early, late and weekend instants to the next opening', () => {
    const zone = 'America/New_York';
    expect(show(nextSlot(at('2025-03-04T07:00', zone), WINDOW, zone), zone)).toBe('Tue 2025-03-04T09:30');
    expect(show(nextSlot(at('2025-03-04T17:00', zone), WINDOW, zone), zone)).toBe('Wed 2025-03-05T09:30');
    expect(show(nextSlot(at('2025-03-07T16:45', zone), WINDOW, zone), zone)).toBe('Mon 2025-03-10T09:30');
  });

  it('skips holidays', () => {
    const zone = 'Europe/Berlin';
    const window = { ...WINDOW, holidays: ['2025-12-25', '2025-12-26'] };
    expect(show(nextSlot(at('2025-12-24T18:00', zone), window, zone), zone)).toBe('Mon 2025-12-29T09:30');
  });

  it('handles the spring-forward gap and fall-back overlap', () => {
    const zone = 'America/New_York';
    const window: SendWindow = { ...WINDOW, days: ['Sun', 'Mon'], start: '02:30', end: '04:00' };
    // 02:30 does not exist on 2025-03-09; luxon moves it forward to 03:30 local.
    expect(show(nextSlot(at('2025-03-09T00:00', zone), window, zone), zone)).toBe('Sun 2025-03-09T03:30');
    const fallBack = nextSlot(at('2025-11-02T00:00', zone), { ...window, start: '01:30', end: '03:00' }, zone);
    expect(show(fallBack, zone)).toBe('Sun 2025-11-02T01:30');
  });

  it('resolves the recipient zone with a fallback', () => {
    expect(resolveZone(WINDOW, 'Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(resolveZone(WINDOW, 'Mars/Olympus')).toBe('America/New_York');
    expect(resolveZone({ ...WINDOW, timezone: 'Europe/London' }, 'Asia/Tokyo')).toBe('Europe/London');
  });

  it('always lands inside the window, never earlier, and is idempotent', () => {
    const zones = ['America/New_York', 'Europe/Berlin', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Pacific/Chatham', 'America/Sao_Paulo'];
    fc.assert(
      fc.property(fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 }), fc.constantFrom(...zones), (from, zone) => {
        const slot = nextSlot(from, WINDOW, zone);
        const local = DateTime.fromMillis(slot, { zone });
        const minutes = local.hour * 60 + local.minute;
        expect(slot).toBeGreaterThanOrEqual(from);
        expect(local.weekday).toBeLessThanOrEqual(5);
        expect(minutes).toBeGreaterThanOrEqual(9 * 60 + 30);
        expect(minutes).toBeLessThan(16 * 60 + 30);
        expect(nextSlot(slot, WINDOW, zone)).toBe(slot);
      }),
      { numRuns: 300 },
    );
  });
});

describe('addDuration', () => {
  it('counts business days only on the business calendar', () => {
    const zone = 'America/New_York';
    const friday = at('2025-03-07T10:00', zone);
    expect(show(addDuration(friday, 'P3D', 'business', WINDOW, zone), zone)).toBe('Wed 2025-03-12T10:00');
    expect(show(addDuration(friday, 'P3D', 'calendar', WINDOW, zone), zone)).toBe('Mon 2025-03-10T10:00');
    expect(show(addDuration(friday, 'PT4H', 'business', WINDOW, zone), zone)).toBe('Fri 2025-03-07T14:00');
  });

  it('rejects invalid durations', () => {
    expect(() => addDuration(0, 'three days', 'business', WINDOW, 'UTC')).toThrow(/Invalid ISO duration/);
  });
});

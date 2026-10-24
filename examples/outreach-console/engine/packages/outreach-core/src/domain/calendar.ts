import { DateTime, Duration, IANAZone } from 'luxon';

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface SendWindow {
  /** 'recipient' uses the contact's time zone, falling back to `fallback`. */
  readonly timezone: string;
  readonly fallback: string;
  readonly days: readonly Weekday[];
  /** "HH:mm", local to the resolved zone. start < end (windows do not cross midnight). */
  readonly start: string;
  readonly end: string;
  /** ISO dates (yyyy-MM-dd) in the resolved zone on which nothing is sent. */
  readonly holidays?: readonly string[];
}

export function isValidZone(zone: string | null | undefined): zone is string {
  return !!zone && IANAZone.isValidZone(zone);
}

export function resolveZone(window: SendWindow, contactZone: string | null | undefined): string {
  if (window.timezone === 'recipient') return isValidZone(contactZone) ? contactZone : window.fallback;
  return window.timezone;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function allowedDay(dt: DateTime, window: SendWindow): boolean {
  const day = WEEKDAYS[dt.weekday - 1];
  return !!day && window.days.includes(day) && !(window.holidays ?? []).includes(dt.toISODate() ?? '');
}

function atMinutes(day: DateTime, minutes: number): DateTime {
  // Luxon moves times that fall into a DST gap forward, so this never lands on a nonexistent instant.
  return day.startOf('day').plus({ minutes });
}

/** The earliest instant >= `from` inside the window, in the resolved zone. */
export function nextSlot(from: number, window: SendWindow, zone: string): number {
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  let dt = DateTime.fromMillis(from, { zone });
  for (let i = 0; i < 400; i += 1) {
    if (allowedDay(dt, window)) {
      const open = atMinutes(dt, start);
      const close = atMinutes(dt, end);
      if (dt < open) return open.toMillis();
      if (dt < close) return dt.toMillis();
    }
    dt = dt.plus({ days: 1 }).startOf('day');
  }
  throw new Error('Send window never opens (no allowed days within 400 days)');
}

/**
 * Adds an ISO-8601 duration. With the business calendar, whole days count only allowed window days
 * (P3D = three sending days later, same local time); hours and minutes are added as elapsed time.
 */
export function addDuration(from: number, iso: string, calendar: 'business' | 'calendar', window: SendWindow, zone: string): number {
  const duration = Duration.fromISO(iso);
  if (!duration.isValid) throw new Error(`Invalid ISO duration ${iso}`);
  const days = Math.floor(duration.as('days'));
  const rest = duration.minus({ days }).as('milliseconds');
  let dt = DateTime.fromMillis(from, { zone });
  if (calendar === 'calendar') return dt.plus({ days }).toMillis() + rest;
  let counted = 0;
  while (counted < days) {
    dt = dt.plus({ days: 1 });
    if (allowedDay(dt, window)) counted += 1;
  }
  return dt.toMillis() + rest;
}

export function isValidDuration(iso: string): boolean {
  return /^P/.test(iso) && Duration.fromISO(iso).isValid;
}

export function durationMs(iso: string): number {
  return Duration.fromISO(iso).as('milliseconds');
}

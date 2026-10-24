import type { RawRow } from './detect';
import { normalizeCountry } from './country';
import type { CanonicalField, MappingProfile } from './profile';

export interface NormalizedContact {
  email: string | null;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  org_name: string | null;
  org_domain: string | null;
  profile_url: string | null;
  timezone: string | null;
  locale: string | null;
  phone: string | null;
  country: string | null;
  attributes: Record<string, string>;
}

export interface NormalizeResult {
  readonly contact: NormalizedContact;
  readonly errors: string[];
}

/** Consumer mailbox domains are never used as the organization domain. */
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'web.de', 'yandex.com', 'mail.com', 'zoho.com',
]);

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function collapse(value: string | undefined): string | null {
  const out = (value ?? '').replace(/\s+/g, ' ').trim();
  return out === '' ? null : out;
}

export function normalizeEmail(value: string): string | null {
  const email = value.trim().replace(/^mailto:/i, '').replace(/\?.*$/, '').toLowerCase();
  if (email.length > 254 || email.includes('..') || !EMAIL_RE.test(email)) return null;
  return email;
}

export function normalizeProfileUrl(value: string): string | null {
  try {
    const url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    return `https://${host}${path}`;
  } catch {
    return null;
  }
}

export function normalizeDomain(value: string): string | null {
  const raw = value.trim().toLowerCase();
  const host = raw.includes('://') ? (() => { try { return new URL(raw).hostname; } catch { return ''; } })() : raw.split('/')[0] ?? '';
  const domain = host.replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function lookup(row: RawRow, ref: string | readonly string[] | undefined): string | undefined {
  if (!ref) return undefined;
  const wanted = (Array.isArray(ref) ? ref : [ref]).map((name) => name.toLowerCase());
  const keys = Object.keys(row.values);
  for (const name of wanted) {
    const key = keys.find((candidate) => candidate.trim().toLowerCase() === name);
    const value = key === undefined ? undefined : row.values[key];
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}

/** Maps one raw row through the profile and validates it. Never invents data; reports what is wrong. */
export function normalizeRow(row: RawRow, profile: MappingProfile): NormalizeResult {
  const errors: string[] = [];
  const invalid = new Set<CanonicalField>();
  const get = (field: CanonicalField) => lookup(row, profile.columns[field]);
  const contact: NormalizedContact = {
    email: null,
    full_name: collapse(get('full_name')),
    first_name: collapse(get('first_name')),
    last_name: collapse(get('last_name')),
    title: collapse(get('title')),
    org_name: collapse(get('org_name')),
    org_domain: null,
    profile_url: null,
    timezone: null,
    locale: collapse(get('locale')),
    phone: collapse(get('phone')),
    country: null,
    attributes: {},
  };
  const rawEmail = get('email');
  if (rawEmail !== undefined) {
    contact.email = normalizeEmail(rawEmail);
    if (!contact.email) {
      errors.push(`invalid email "${rawEmail.slice(0, 80)}"`);
      invalid.add('email');
    }
  }
  const rawUrl = get('profile_url');
  if (rawUrl !== undefined) {
    contact.profile_url = normalizeProfileUrl(rawUrl);
    if (!contact.profile_url) {
      errors.push(`invalid profile URL "${rawUrl.slice(0, 80)}"`);
      invalid.add('profile_url');
    }
  }
  const rawDomain = get('org_domain');
  if (rawDomain !== undefined) {
    contact.org_domain = normalizeDomain(rawDomain);
    if (!contact.org_domain) errors.push(`invalid organization domain "${rawDomain.slice(0, 80)}"`);
  } else if (contact.email) {
    const domain = contact.email.split('@')[1] ?? '';
    if (!FREEMAIL.has(domain)) contact.org_domain = domain;
  }
  const rawZone = collapse(get('timezone'));
  if (rawZone) {
    if (isValidZone(rawZone)) contact.timezone = rawZone;
    else errors.push(`unknown time zone "${rawZone.slice(0, 60)}"`);
  }
  const rawCountry = collapse(get('country'));
  if (rawCountry) {
    contact.country = normalizeCountry(rawCountry);
    if (!contact.country) errors.push(`unknown country "${rawCountry.slice(0, 60)}"`);
  }
  if (!contact.full_name && (contact.first_name || contact.last_name)) {
    contact.full_name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
  }
  if (profile.splitFullName && contact.full_name && !contact.first_name) {
    const [first, ...rest] = contact.full_name.split(' ');
    contact.first_name = first ?? null;
    if (!contact.last_name && rest.length) contact.last_name = rest.join(' ');
  }
  for (const [key, ref] of Object.entries(profile.attributes)) {
    const value = collapse(lookup(row, ref));
    if (value) contact.attributes[key] = value.slice(0, 500);
  }
  for (const field of profile.required) {
    if (!contact[field] && !invalid.has(field)) errors.push(`missing required ${field}`);
  }
  if (!contact.full_name && !contact.email) errors.push('row has neither a name nor an email');
  return { contact, errors: [...new Set(errors)] };
}

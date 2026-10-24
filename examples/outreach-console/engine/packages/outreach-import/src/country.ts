/**
 * Country column -> ISO 3166 alpha-2 (decision D5: the recipient's country decides which law applies).
 * Built from the runtime's CLDR region names, so there is no table to maintain: "DE", "de", "Germany" and
 * "germany" all resolve to DE. Anything else is an error, never a guess.
 */

/** CLDR regions that are not countries, or not ISO codes. */
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ', 'UK']);

const ALIASES: Record<string, string> = {
  uk: 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  usa: 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  'united states of america': 'US',
  america: 'US',
  uae: 'AE',
  deutschland: 'DE',
  'south korea': 'KR',
  czechia: 'CZ',
  'czech republic': 'CZ',
  holland: 'NL',
  'the netherlands': 'NL',
};

let byName: Map<string, string> | undefined;

function table(): Map<string, string> {
  if (byName) return byName;
  const names = new Intl.DisplayNames('en', { type: 'region' });
  byName = new Map(Object.entries(ALIASES));
  for (let a = 65; a <= 90; a += 1) {
    for (let b = 65; b <= 90; b += 1) {
      const code = String.fromCharCode(a, b);
      if (NOT_COUNTRIES.has(code)) continue;
      const name = names.of(code);
      if (!name || name === code || name === 'Unknown Region') continue;
      byName.set(code.toLowerCase(), code);
      byName.set(name.toLowerCase(), code);
    }
  }
  return byName;
}

export function normalizeCountry(value: string): string | null {
  const key = value.trim().replace(/\s+/g, ' ').toLowerCase();
  return key ? (table().get(key) ?? null) : null;
}

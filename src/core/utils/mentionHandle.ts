/**
 * @mention handles for workspace people.
 *
 * A handle is a display affordance, never an identity. Everything that grants
 * access keys off the Parse _User.objectId; handles exist so a human can type
 * "@amir-kabbara" instead of "8f3a9c...". Two colleagues can genuinely share a
 * display name, so handles are disambiguated rather than assumed unique.
 */

export interface MentionCandidate {
  userId: string;
  displayName?: string;
  email?: string;
}

/** "Amir Kabbara" → "amir-kabbara". Falls back to the email local part. */
export function toMentionHandle(
  displayName?: string,
  email?: string,
): string {
  const fromName = (displayName ?? "").trim();
  const fromEmail = (email ?? "").split("@")[0] ?? "";
  const base = (fromName || fromEmail).toLowerCase();
  const slug = base
    // Strip accents so "Zoë" and "Zoe" produce the same typeable handle.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "user";
}

/**
 * Handles for a roster, guaranteed unique and stable for a given input order.
 *
 * Collisions fall back to the email local part, then to a numeric suffix, so
 * the picker can never show two identical handles for different people.
 */
export function buildUniqueMentionHandles(
  people: readonly MentionCandidate[],
): Map<string, string> {
  const taken = new Set<string>();
  const out = new Map<string, string>();

  for (const person of people) {
    const preferred = toMentionHandle(person.displayName, person.email);
    let handle = preferred;

    if (taken.has(handle)) {
      const local = toMentionHandle(undefined, person.email);
      if (local && local !== "user" && !taken.has(local)) {
        handle = local;
      } else {
        let n = 2;
        while (taken.has(`${preferred}-${n}`)) {
          n += 1;
        }
        handle = `${preferred}-${n}`;
      }
    }

    taken.add(handle);
    out.set(person.userId, handle);
  }

  return out;
}

/** Case-insensitive match on handle, display name, or email. */
export function matchesMentionQuery(
  person: MentionCandidate,
  handle: string,
  rawQuery: string,
): boolean {
  // A leading @ is how people naturally type a mention; it is not part of any
  // field being searched.
  const query = rawQuery.trim().replace(/^@+/, "").toLowerCase();
  if (!query) {
    return true;
  }
  return (
    handle.toLowerCase().includes(query) ||
    (person.displayName ?? "").toLowerCase().includes(query) ||
    (person.email ?? "").toLowerCase().includes(query)
  );
}

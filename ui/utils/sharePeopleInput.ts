import {
  normalizeEmail,
  normalizeEmailDomain,
} from "./shareAudienceModel";

export type SharePeopleMenuEntry =
  | { kind: "member"; userId: string }
  | { kind: "external_email"; email: string }
  | { kind: "domain"; domain: string };

export interface BuildSharePeopleMenuOptions {
  query: string;
  memberUserIds: readonly string[];
  memberEmailsByUserId: ReadonlyMap<string, string>;
  allowedEmails: readonly string[];
  allowedEmailDomains: readonly string[];
  /** Workspace members matching the search (excluding owner / already added). */
  memberMatches: readonly { userId: string; email: string }[];
  currentUserId?: string | null;
}

/**
 * One search box: teammate by name, external email, or @domain / domain.com.
 */
export function buildSharePeopleMenuEntries(
  options: BuildSharePeopleMenuOptions,
): SharePeopleMenuEntry[] {
  const q = options.query.trim();
  if (!q) {
    return [];
  }

  const chosen = new Set(options.memberUserIds);
  const emails = new Set(options.allowedEmails);
  const domains = new Set(options.allowedEmailDomains);
  const entries: SharePeopleMenuEntry[] = [];
  const seenMember = new Set<string>();

  const pushMember = (userId: string) => {
    if (
      userId === options.currentUserId ||
      chosen.has(userId) ||
      seenMember.has(userId)
    ) {
      return;
    }
    seenMember.add(userId);
    entries.push({ kind: "member", userId });
  };

  const normalizedEmail = normalizeEmail(q);
  if (normalizedEmail) {
    let matchedMemberId: string | null = null;
    for (const [userId, email] of options.memberEmailsByUserId) {
      if (normalizeEmail(email) === normalizedEmail) {
        matchedMemberId = userId;
        break;
      }
    }
    if (matchedMemberId) {
      pushMember(matchedMemberId);
    } else if (!emails.has(normalizedEmail)) {
      entries.push({ kind: "external_email", email: normalizedEmail });
    }
  }

  const normalizedDomain = normalizeEmailDomain(q);
  if (normalizedDomain && !domains.has(normalizedDomain) && !normalizedEmail) {
    entries.push({ kind: "domain", domain: normalizedDomain });
  }

  for (const match of options.memberMatches) {
    pushMember(match.userId);
  }

  return entries.slice(0, 8);
}

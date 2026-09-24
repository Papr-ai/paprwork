/**
 * Resolve contributor display names on incoming change requests when the
 * memory server omits proposerDisplayName but includes a user id.
 */

export interface ContributorMemberLookup {
  displayName: string;
  email?: string;
}

const DISPLAY_NAME_KEYS = [
  "contributorDisplayName",
  "contributor_display_name",
  "proposerDisplayName",
  "proposer_display_name",
  "submitterDisplayName",
  "submitter_display_name",
  "externalUserDisplayName",
  "external_user_display_name",
  "userDisplayName",
  "user_display_name",
  "contributorName",
  "contributor_name",
  "proposer_name",
  "createdByDisplayName",
  "created_by_display_name",
] as const;

const USER_ID_KEYS = [
  "proposerUserId",
  "proposer_user_id",
  "contributorUserId",
  "contributor_user_id",
  "submitterUserId",
  "submitter_user_id",
  "externalUserId",
  "external_user_id",
  "createdByUserId",
  "created_by_user_id",
  "userId",
  "user_id",
] as const;

function readString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readNestedProposer(
  record: Record<string, unknown>,
): { displayName?: string; userId?: string; email?: string } {
  const nestedKeys = ["proposer", "contributor", "submitter", "createdBy", "user"];
  for (const key of nestedKeys) {
    const value = record[key];
    if (!value || typeof value !== "object") {
      continue;
    }
    const obj = value as Record<string, unknown>;
    const displayName = readString(obj, [
      "displayName",
      "display_name",
      "fullname",
      "fullName",
      "name",
    ]);
    const userId = readString(obj, [
      "userId",
      "user_id",
      "objectId",
      "object_id",
      "externalUserId",
      "external_user_id",
    ]);
    const email = readString(obj, ["email"]);
    if (displayName || userId || email) {
      return { displayName, userId, email };
    }
  }
  return {};
}

export function changeRequestHasContributorDisplayName(
  raw: Record<string, unknown>,
): boolean {
  return Boolean(readString(raw, [...DISPLAY_NAME_KEYS]));
}

export function extractChangeRequestProposerUserId(
  raw: Record<string, unknown>,
): string | undefined {
  const direct = readString(raw, [...USER_ID_KEYS]);
  if (direct) {
    return direct;
  }
  return readNestedProposer(raw).userId;
}

/** Apply workspace member roster to a single incoming change request row. */
export function enrichChangeRequestContributorRow(
  raw: Record<string, unknown>,
  membersByUserId: ReadonlyMap<string, ContributorMemberLookup>,
): Record<string, unknown> {
  if (changeRequestHasContributorDisplayName(raw)) {
    return raw;
  }

  const nested = readNestedProposer(raw);
  if (nested.displayName) {
    return {
      ...raw,
      proposerDisplayName: nested.displayName,
      ...(nested.email ? { proposerEmail: nested.email } : {}),
      ...(nested.userId ? { proposerUserId: nested.userId } : {}),
    };
  }

  const userId = extractChangeRequestProposerUserId(raw);
  if (!userId) {
    return raw;
  }

  const member = membersByUserId.get(userId);
  if (!member?.displayName?.trim()) {
    return { ...raw, proposerUserId: userId };
  }

  return {
    ...raw,
    proposerUserId: userId,
    proposerDisplayName: member.displayName.trim(),
    ...(member.email ? { proposerEmail: member.email } : {}),
  };
}

export function enrichChangeRequestContributorList(
  requests: unknown[],
  membersByUserId: ReadonlyMap<string, ContributorMemberLookup>,
): unknown[] {
  return requests.map((row) => {
    if (!row || typeof row !== "object") {
      return row;
    }
    return enrichChangeRequestContributorRow(
      row as Record<string, unknown>,
      membersByUserId,
    );
  });
}

export function buildMemberLookupByUserId(
  members: ReadonlyArray<{
    externalUserId?: string;
    userId?: string;
    user?: { objectId?: string; displayName?: string; email?: string };
    displayName?: string;
    email?: string;
  }>,
): Map<string, ContributorMemberLookup> {
  const map = new Map<string, ContributorMemberLookup>();
  for (const entry of members) {
    const userId =
      entry.externalUserId?.trim() ||
      entry.userId?.trim() ||
      entry.user?.objectId?.trim() ||
      undefined;
    if (!userId) {
      continue;
    }
    const displayName =
      entry.displayName?.trim() ||
      entry.user?.displayName?.trim() ||
      undefined;
    const email =
      entry.email?.trim() || entry.user?.email?.trim() || undefined;
    if (!displayName && !email) {
      continue;
    }
    map.set(userId, {
      displayName: displayName ?? email ?? userId,
      email,
    });
  }
  return map;
}

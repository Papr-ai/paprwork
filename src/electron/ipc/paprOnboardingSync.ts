/**
 * Server-side persistence of Paprwork onboarding progress (Parse `_User`).
 *
 * WHY THIS EXISTS: onboarding state has lived in localStorage, so a cleared
 * cache, a second machine, or a reinstall replayed the whole gate for someone
 * who had already finished it. These columns make completion a property of the
 * USER rather than of one browser profile.
 *
 * Three columns, added specifically for this (do not reuse the older
 * `completedProfileSignup` / `developerOnboardedAt` — those predate the desktop
 * app and may already be set by web signup, which would skip the gate for
 * people who have never seen it):
 *
 *   completedPaprWorkOnboarding  Boolean  did they finish
 *   PaprWorkOnboardedAt          Date     when they finished
 *   PaprWorkOnboardingStep       String   where they are (resume + funnel drop-off)
 *
 * CASING IS LOAD-BEARING. Two of the three are PascalCase server-side and
 * GraphQL is case-sensitive — `paprWorkOnboardedAt` is a validation error, not
 * a silent no-op. The constants below are the single place these names appear.
 */

import { parseFetch } from "./parseTransport.js";

const PARSE_GRAPHQL_URL =
  process.env.PARSE_GRAPHQL_URL || "https://server.papr.ai/graphql";
const PARSE_APP_ID =
  process.env.PARSE_APP_ID || "671e705a-f735-4ec0-8474-15899a475440";

/** Exact server field names — verified against live schema introspection. */
export const ONBOARDING_FIELDS = {
  completed: "completedPaprWorkOnboarding",
  completedAt: "PaprWorkOnboardedAt",
  step: "PaprWorkOnboardingStep",
} as const;

export interface RemoteOnboardingState {
  completed: boolean;
  completedAt?: string;
  step?: string;
}

const GET_ONBOARDING = `
  query GetPaprWorkOnboarding($userId: ID!) {
    user(id: $userId) {
      objectId
      ${ONBOARDING_FIELDS.completed}
      ${ONBOARDING_FIELDS.completedAt}
      ${ONBOARDING_FIELDS.step}
    }
  }
`;

const UPDATE_ONBOARDING = `
  mutation UpdatePaprWorkOnboarding($input: UpdateUserInput!) {
    updateUser(input: $input) {
      user {
        objectId
        ${ONBOARDING_FIELDS.completed}
        ${ONBOARDING_FIELDS.completedAt}
        ${ONBOARDING_FIELDS.step}
      }
    }
  }
`;

async function onboardingGraphQL(
  sessionToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await parseFetch(PARSE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Parse-Application-Id": PARSE_APP_ID,
      "X-Parse-Session-Token": sessionToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(
      `Parse GraphQL error: ${response.status} ${await response.text()}`,
    );
  }

  const result = (await response.json()) as {
    data?: Record<string, unknown>;
    errors?: unknown[];
  };
  if (result.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  return result.data ?? {};
}

/** Read server-side onboarding state. Returns undefined if it can't be read. */
export async function fetchOnboardingState(
  sessionToken: string,
  userId: string,
): Promise<RemoteOnboardingState | undefined> {
  const data = (await onboardingGraphQL(sessionToken, GET_ONBOARDING, {
    userId,
  })) as { user?: Record<string, unknown> };

  if (!data.user) return undefined;

  const completedAt = data.user[ONBOARDING_FIELDS.completedAt];
  const step = data.user[ONBOARDING_FIELDS.step];

  return {
    completed: data.user[ONBOARDING_FIELDS.completed] === true,
    completedAt: typeof completedAt === "string" ? completedAt : undefined,
    step: typeof step === "string" ? step : undefined,
  };
}

/**
 * Record progress. `step` alone is a checkpoint; `completed` stamps the date.
 *
 * Only sends the fields it was given — a mid-flow checkpoint must never clear
 * a completion flag written by an earlier session on another machine.
 */
export async function saveOnboardingState(
  sessionToken: string,
  userId: string,
  update: { step?: string; completed?: boolean },
): Promise<void> {
  const fields: Record<string, unknown> = {};

  if (update.step !== undefined) {
    fields[ONBOARDING_FIELDS.step] = update.step;
  }
  if (update.completed !== undefined) {
    fields[ONBOARDING_FIELDS.completed] = update.completed;
    // Stamp only on completion — re-running setup shouldn't erase the original
    // date, and a null date next to completed:true reads as corrupt.
    if (update.completed) {
      fields[ONBOARDING_FIELDS.completedAt] = new Date().toISOString();
    }
  }

  if (Object.keys(fields).length === 0) return;

  await onboardingGraphQL(sessionToken, UPDATE_ONBOARDING, {
    input: { id: userId, fields },
  });
}

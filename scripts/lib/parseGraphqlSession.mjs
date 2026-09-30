/**
 * Minimal Parse GraphQL client for Electron billing probe scripts.
 */

const PARSE_GRAPHQL_URL =
  process.env.PARSE_GRAPHQL_URL || "https://server.papr.ai/graphql";
const PARSE_APP_ID =
  process.env.PARSE_APP_ID || "671e705a-f735-4ec0-8474-15899a475440";

export async function runParseGraphQL(sessionToken, query, variables = {}) {
  const response = await fetch(PARSE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Parse-Application-Id": PARSE_APP_ID,
      "X-Parse-Session-Token": sessionToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Parse GraphQL HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  if (body.errors?.length) {
    throw new Error(
      `Parse GraphQL error: ${body.errors.map((entry) => entry.message).join("; ")}`,
    );
  }
  return body.data ?? {};
}

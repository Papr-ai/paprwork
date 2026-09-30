/**
 * Lightweight Parse session validation for desktop → web cookie bridge.
 */

const PARSE_SERVER_URL =
  process.env.PARSE_SERVER_URL?.replace(/\/$/, "") ??
  "https://server.papr.ai/parse";
const PARSE_APP_ID =
  process.env.PARSE_APP_ID ?? "671e705a-f735-4ec0-8474-15899a475440";

export interface ValidParseSession {
  objectId: string;
  email?: string;
}

export async function validateParseSessionToken(
  sessionToken: string,
): Promise<ValidParseSession | null> {
  const token = sessionToken.trim();
  if (!token) {
    return null;
  }

  try {
    const response = await fetch(`${PARSE_SERVER_URL}/users/me`, {
      headers: {
        "X-Parse-Application-Id": PARSE_APP_ID,
        "X-Parse-Session-Token": token,
      },
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { objectId?: string; email?: string };
    const objectId = body.objectId?.trim();
    if (!objectId) {
      return null;
    }
    const email = body.email?.trim();
    return email ? { objectId, email } : { objectId };
  } catch {
    return null;
  }
}

/**
 * Sync user profile (name + photo) with Parse / Papr cloud.
 * Mirrors papr-dev-platform SettingsModal + parse-file-upload flow.
 */

const PARSE_GRAPHQL_URL =
  process.env.PARSE_GRAPHQL_URL || "https://server.papr.ai/graphql";
const PARSE_SERVER_URL =
  process.env.PARSE_SERVER_URL || "https://server.papr.ai/parse";
const PARSE_APP_ID =
  process.env.PARSE_APP_ID || "671e705a-f735-4ec0-8474-15899a475440";

export interface ParseUserProfileDetails {
  userId: string;
  email?: string;
  displayName?: string;
  fullname?: string;
  profileImageUrl?: string;
}

interface ParseFileUploadResult {
  url: string;
  name: string;
}

interface ParseProfileImageInput {
  file: {
    __type: "File";
    name: string;
    url: string;
  };
}

const GET_USER_DETAILS = `
  query GetUser($userId: ID!) {
    user(id: $userId) {
      objectId
      fullname
      displayName
      email
      profileimage {
        url
        name
        __typename
      }
    }
  }
`;

const UPDATE_USER_DETAILS = `
  mutation UpdateUserDetails($input: UpdateUserInput!) {
    updateUser(input: $input) {
      user {
        objectId
        fullname
        displayName
        profileimage {
          url
          name
          __typename
        }
      }
    }
  }
`;

async function parseGraphQL(
  sessionToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(PARSE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Parse-Application-Id": PARSE_APP_ID,
      "X-Parse-Session-Token": sessionToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Parse GraphQL error: ${response.status} ${text}`);
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

function parseDataUrl(
  dataUrl: string,
): { buffer: Buffer; mimeType: string; extension: string } {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl.trim());
  if (!match) {
    throw new Error("Invalid profile image data URL");
  }

  const mimeType = match[1];
  const buffer = Buffer.from(match[2], "base64");
  let extension = "jpg";
  if (mimeType === "image/png") extension = "png";
  else if (mimeType === "image/webp") extension = "webp";
  else if (mimeType === "image/gif") extension = "gif";

  return { buffer, mimeType, extension };
}

function isDataUrl(value: string): boolean {
  return value.trim().startsWith("data:");
}

function isRemoteProfileImageUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

export async function fetchParseUserProfile(
  sessionToken: string,
  userId: string,
): Promise<ParseUserProfileDetails> {
  const data = await parseGraphQL(sessionToken, GET_USER_DETAILS, { userId });
  const user = data.user as
    | {
        objectId?: string;
        fullname?: string;
        displayName?: string;
        email?: string;
        profileimage?: { url?: string };
      }
    | undefined;

  if (!user?.objectId) {
    throw new Error("Parse user profile not found");
  }

  return {
    userId: user.objectId,
    email: user.email,
    displayName: user.displayName || user.fullname,
    fullname: user.fullname,
    profileImageUrl: user.profileimage?.url,
  };
}

export async function uploadProfileImageToParse(
  sessionToken: string,
  dataUrl: string,
  userId: string,
): Promise<ParseFileUploadResult> {
  const { buffer, mimeType, extension } = parseDataUrl(dataUrl);
  const sanitizedFileName = `profile_${userId}_${Date.now()}.${extension}`.replace(
    /[^a-zA-Z0-9.-]/g,
    "_",
  );

  const response = await fetch(
    `${PARSE_SERVER_URL}/files/${encodeURIComponent(sanitizedFileName)}`,
    {
      method: "POST",
      headers: {
        "X-Parse-Application-Id": PARSE_APP_ID,
        "X-Parse-Session-Token": sessionToken,
        "Content-Type": mimeType,
      },
      body: buffer,
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Parse file upload failed: ${response.status} ${text}`);
  }

  const payload = (await response.json()) as { url?: string; name?: string };
  if (!payload.url || !payload.name) {
    throw new Error("Parse file upload returned an incomplete response");
  }

  return { url: payload.url, name: payload.name };
}

export async function updateParseUserProfile(
  sessionToken: string,
  userId: string,
  fields: {
    displayName?: string;
    fullname?: string;
    profileImage?: ParseProfileImageInput;
  },
): Promise<{ profileImageUrl?: string }> {
  const input: Record<string, unknown> = {
    id: userId,
  };

  if (fields.fullname?.trim()) {
    input.fullname = fields.fullname.trim();
  }
  if (fields.displayName?.trim()) {
    input.displayName = fields.displayName.trim();
  }
  if (fields.profileImage) {
    input.profileimage = fields.profileImage;
  }

  const data = await parseGraphQL(sessionToken, UPDATE_USER_DETAILS, { input });
  const user = (data.updateUser as { user?: { profileimage?: { url?: string } } })
    ?.user;

  return { profileImageUrl: user?.profileimage?.url };
}

export interface SyncProfileToParseInput {
  sessionToken: string;
  userId: string;
  name?: string;
  email?: string;
  imageUrl?: string;
}

export interface SyncProfileToParseResult {
  profileImageUrl?: string;
  syncedImageUrl?: string;
}

/**
 * Push profile changes to Parse. Uploads data-URL photos first, then updates the user record.
 * Returns the canonical cloud image URL when a photo was synced.
 */
export async function syncProfileToParse(
  input: SyncProfileToParseInput,
): Promise<SyncProfileToParseResult> {
  const trimmedName = input.name?.trim();
  const imageUrl = input.imageUrl?.trim() ?? "";
  let profileImage: ParseProfileImageInput | undefined;
  let syncedImageUrl: string | undefined;

  if (imageUrl && isDataUrl(imageUrl)) {
    const uploaded = await uploadProfileImageToParse(
      input.sessionToken,
      imageUrl,
      input.userId,
    );
    profileImage = {
      file: {
        __type: "File",
        name: uploaded.name,
        url: uploaded.url,
      },
    };
    syncedImageUrl = uploaded.url;
  } else if (imageUrl && isRemoteProfileImageUrl(imageUrl)) {
    syncedImageUrl = imageUrl;
  }

  const updateResult = await updateParseUserProfile(input.sessionToken, input.userId, {
    displayName: trimmedName,
    fullname: trimmedName,
    ...(profileImage ? { profileImage } : {}),
  });

  return {
    profileImageUrl: updateResult.profileImageUrl ?? syncedImageUrl,
    syncedImageUrl,
  };
}

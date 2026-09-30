import { describe, expect, it } from "vitest";
import {
  buildParseProfileImageInput,
  buildUpdateUserProfileGraphQLInput,
  parseParseProfileImageFileName,
  parseParseProfileImageFromUrl,
} from "../src/electron/ipc/paprProfileSync.ts";

describe("paprProfileSync GraphQL input", () => {
  it("nests profile fields under UpdateUserInput.fields with full Parse File pointer", () => {
    const fileUrl =
      "https://parseserverstoragewest.blob.core.windows.net/parse/app-id/profile_user-123_123.png";

    expect(
      buildUpdateUserProfileGraphQLInput("user-123", {
        fullname: "Ada Lovelace",
        displayName: "Ada",
        profileImage: {
          __type: "File",
          name: "profile_user-123_123.png",
          url: fileUrl,
        },
      }),
    ).toEqual({
      id: "user-123",
      fields: {
        fullname: "Ada Lovelace",
        displayName: "Ada",
        profileimage: {
          file: {
            __type: "File",
            name: "profile_user-123_123.png",
            url: fileUrl,
          },
        },
      },
    });
  });

  it("buildParseProfileImageInput matches papr-dev-platform FileInput shape", () => {
    expect(
      buildParseProfileImageInput("avatar.png", "https://example.com/avatar.png"),
    ).toEqual({
      file: {
        __type: "File",
        name: "avatar.png",
        url: "https://example.com/avatar.png",
      },
    });
  });

  it("extracts Parse file name from hosted profile image URL", () => {
    expect(
      parseParseProfileImageFileName(
        "https://parseserver-staging.example.run.app/parse/files/app-id/861f65105b_profile_WkPutXGdqg.png",
      ),
    ).toBe("861f65105b_profile_WkPutXGdqg.png");
  });

  it("builds Parse File pointer from an existing hosted URL", () => {
    const url =
      "https://parseserver-staging.example.run.app/parse/files/app-id/861f65105b_profile_WkPutXGdqg.png";

    expect(parseParseProfileImageFromUrl(url)).toEqual({
      __type: "File",
      name: "861f65105b_profile_WkPutXGdqg.png",
      url,
    });
  });
});

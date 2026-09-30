import { describe, expect, it } from "vitest";
import {
  isProfileImagePendingSync,
  resolveDisplayProfileImage,
} from "../ui/utils/profileImageSyncCore";

describe("profileImageSync", () => {
  it("treats data URLs as pending sync", () => {
    expect(isProfileImagePendingSync("data:image/jpeg;base64,abc")).toBe(true);
    expect(isProfileImagePendingSync("https://cdn.example.com/a.jpg")).toBe(false);
  });

  it("treats explicit pending flag as pending", () => {
    expect(
      isProfileImagePendingSync("https://cdn.example.com/a.jpg", true),
    ).toBe(true);
  });

  it("prefers cloud when sync is not pending", () => {
    expect(
      resolveDisplayProfileImage(
        "https://local.example.com/stale.jpg",
        "https://cloud.example.com/a.jpg",
        false,
      ),
    ).toBe("https://cloud.example.com/a.jpg");
  });

  it("falls back to local while sync is pending", () => {
    const local = "data:image/jpeg;base64,local";
    expect(
      resolveDisplayProfileImage(
        local,
        "https://cloud.example.com/old.jpg",
        true,
      ),
    ).toBe(local);
  });

  it("uses local when cloud is empty", () => {
    expect(
      resolveDisplayProfileImage("https://local.example.com/a.jpg", "", false),
    ).toBe("https://local.example.com/a.jpg");
  });
});

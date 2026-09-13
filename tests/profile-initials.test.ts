import { describe, expect, it } from "vitest";
import { getProfileInitials } from "../ui/utils/profileInitials";

describe("getProfileInitials", () => {
  it("uses first and last name letters", () => {
    expect(getProfileInitials("Dale Zwizinski")).toBe("DZ");
    expect(getProfileInitials("Amir Kabbara")).toBe("AK");
  });

  it("uses a single initial for one-word names", () => {
    expect(getProfileInitials("Adam")).toBe("A");
    expect(getProfileInitials("Papr")).toBe("P");
  });

  it("falls back to email when name is empty", () => {
    expect(getProfileInitials("", "adam@example.com")).toBe("A");
  });

  it("returns empty when nothing is available", () => {
    expect(getProfileInitials("", "")).toBe("");
  });
});

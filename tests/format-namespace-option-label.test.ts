import { describe, expect, it } from "vitest";
import { formatNamespaceOptionLabel } from "../ui/components/Settings/formatNamespaceOptionLabel";

describe("formatNamespaceOptionLabel", () => {
  it("shows name and id only when environment matches name", () => {
    expect(
      formatNamespaceOptionLabel({
        id: "VIA2C5VDxj",
        name: "development",
        environmentType: "development",
      }),
    ).toBe("development (VIA2C5VDxj)");
  });

  it("shows environment when it differs from name", () => {
    expect(
      formatNamespaceOptionLabel({
        id: "abc123",
        name: "Engineering",
        environmentType: "production",
      }),
    ).toBe("Engineering · production (abc123)");
  });
});

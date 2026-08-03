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

  it("hides environment when name already ends with -production", () => {
    expect(
      formatNamespaceOptionLabel({
        id: "85ZIB7mD1V",
        name: "papr-ai-production",
        environmentType: "production",
      }),
    ).toBe("papr-ai-production (85ZIB7mD1V)");
  });
});

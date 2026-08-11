import { describe, expect, it } from "vitest";
import {
  autoUploadToggleHint,
  resolveEffectiveAutoUpload,
  uploadModeFromToggle,
  usesGlobalUploadDefault,
} from "../ui/utils/appUploadMode";

describe("appUploadMode", () => {
  describe("resolveEffectiveAutoUpload", () => {
    it("returns true for auto mode regardless of global", () => {
      expect(resolveEffectiveAutoUpload("auto", false)).toBe(true);
      expect(resolveEffectiveAutoUpload("auto", true)).toBe(true);
    });

    it("returns false for manual mode regardless of global", () => {
      expect(resolveEffectiveAutoUpload("manual", true)).toBe(false);
      expect(resolveEffectiveAutoUpload("manual", false)).toBe(false);
    });

    it("inherits global default when mode is inherit or undefined", () => {
      expect(resolveEffectiveAutoUpload("inherit", true)).toBe(true);
      expect(resolveEffectiveAutoUpload("inherit", false)).toBe(false);
      expect(resolveEffectiveAutoUpload(undefined, false)).toBe(false);
      expect(resolveEffectiveAutoUpload(undefined, true)).toBe(true);
    });
  });

  describe("usesGlobalUploadDefault", () => {
    it("is true only for inherit or undefined", () => {
      expect(usesGlobalUploadDefault("inherit")).toBe(true);
      expect(usesGlobalUploadDefault(undefined)).toBe(true);
      expect(usesGlobalUploadDefault("auto")).toBe(false);
      expect(usesGlobalUploadDefault("manual")).toBe(false);
    });
  });

  describe("uploadModeFromToggle", () => {
    it("maps toggle to explicit modes", () => {
      expect(uploadModeFromToggle(true)).toBe("auto");
      expect(uploadModeFromToggle(false)).toBe("manual");
    });
  });

  describe("autoUploadToggleHint", () => {
    it("uses plain language without jargon", () => {
      expect(autoUploadToggleHint(true)).toContain("background");
      expect(autoUploadToggleHint(false)).toContain("Upload now");
      expect(autoUploadToggleHint(false)).not.toMatch(/manual|turso|uploadMode/i);
    });
  });
});

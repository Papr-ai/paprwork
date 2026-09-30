import { describe, expect, it } from "vitest";
import { summarizeBrand } from "../src/gateway/services/brandDesignContext.js";

describe("summarizeBrand", () => {
  it("unset brand asks the user", () => {
    const ctx = summarizeBrand({ name: "", colors: { primary: "", accent: "" } });
    expect(ctx.status).toBe("unset");
    expect(ctx.askUser).toContain("ask the user");
    expect(ctx.block).toContain("UNSET");
  });

  it("recorded default choice stops re-asking", () => {
    const ctx = summarizeBrand({
      sources: [{ date: "2026-09-29", note: "User chose Papr default design" }],
    });
    expect(ctx.status).not.toBe("unset");
    expect(ctx.askUser).toBeUndefined();
  });

  it("partial brand lists set values and missing fields", () => {
    const ctx = summarizeBrand({
      name: "Papr",
      colors: { primary: "#0161E0", accent: "#0CCDFF" },
      logo: { light: "brand/logo.svg" },
    });
    expect(ctx.status).toBe("partial");
    expect(ctx.block).toContain("primary: #0161E0");
    expect(ctx.missing).toEqual(expect.arrayContaining(["headingFont", "bodyFont", "voice"]));
    expect(ctx.block).toContain("dark");
  });

  it("fully configured brand", () => {
    const ctx = summarizeBrand({
      colors: { primary: "#111", accent: "#222" },
      fonts: { heading: "Inter", body: "Inter" },
      logo: { light: "a.svg" },
      voice: "concise",
    });
    expect(ctx.status).toBe("configured");
    expect(ctx.missing).toEqual([]);
  });
});

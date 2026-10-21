import { describe, expect, it } from "vitest";
import { isPlatformGeneratedAppPath, isWriterScaffoldPath } from "./platformGeneratedAppPaths.js";

describe("platform-generated app paths", () => {
  it.each(["__papr__/app-meta.json", "__papr__/platform-catalog.json", "backend/bundle.json", ".papr-cloud-revision"])(
    "%s is platform-written",
    (p) => expect(isPlatformGeneratedAppPath(p)).toBe(true),
  );

  it.each(["index.html", "app.js", "metadata.json", "requirements.json", "linked-databases.json", "README.md"])(
    "%s is not skipped as generated",
    (p) => expect(isPlatformGeneratedAppPath(p)).toBe(false),
  );

  it("only root README.md / .gitignore are writer scaffold", () => {
    expect(isWriterScaffoldPath("README.md")).toBe(true);
    expect(isWriterScaffoldPath(".gitignore")).toBe(true);
    expect(isWriterScaffoldPath("content/README.md")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  isLocallyRebuiltAppPath,
  isPlatformGeneratedAppPath,
  isWriterScaffoldPath,
} from "./platformGeneratedAppPaths.js";

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

  it.each(["dist/app.js", "dist/app.css", "dist/cards/x.js", "db.ts", "backend/papr_db.py", "./db.ts"])(
    "%s is rebuilt locally, not pulled",
    (p) => expect(isLocallyRebuiltAppPath(p)).toBe(true),
  );

  it.each(["app.ts", "backend/handler.py", "backend/db_helper.py", "src/db.ts", "distribution/x.ts"])(
    "%s is real source and still pulls",
    (p) => expect(isLocallyRebuiltAppPath(p)).toBe(false),
  );
});

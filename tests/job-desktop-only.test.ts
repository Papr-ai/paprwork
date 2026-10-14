import { describe, expect, test } from "vitest";
import {
  detectJobDesktopOnly,
  explainDesktopOnlyForAgent,
  referencedJobIds,
  summarizeDesktopOnly,
} from "../src/gateway/utils/jobDesktopOnly.js";

const files = (o: Record<string, string>) => new Map(Object.entries(o));
const kinds = (input: Parameters<typeof detectJobDesktopOnly>[0]) =>
  detectJobDesktopOnly(input).map((h) => h.kind);

describe("detectJobDesktopOnly", () => {
  test("LinkedIn sender using the browser helper → chrome", () => {
    expect(
      kinds({
        type: "python",
        command: "python3 code/send.py",
        files: files({
          "code/send.py": 'browser, page = await connect_platform_browser(pw, "linkedin.com")',
        }),
      }),
    ).toEqual(["chrome"]);
  });

  test("copied helpers alone do not make a job desktop-only", () => {
    expect(
      kinds({
        type: "python",
        files: files({
          "papr_db.py": 'BASE = "http://127.0.0.1:18789"',
          "papr_platform_browser.py": "cdp = 'http://127.0.0.1:9222'",
          "code/main.py": "from papr_db import query\nprint(query('select 1'))",
        }),
      }),
    ).toEqual([]);
  });

  test("gateway URL as env default is cloud-safe; hardcoded is not", () => {
    expect(
      kinds({
        type: "python",
        files: files({
          "code/a.py": 'BASE = os.environ.get("PAPR_GATEWAY_URL", "http://127.0.0.1:18789")',
        }),
      }),
    ).toEqual([]);
    expect(
      kinds({ type: "python", files: files({ "code/db.py": 'BASE = "http://localhost:18789"' }) }),
    ).toEqual(["desktop-gateway"]);
  });

  test("comments are ignored", () => {
    expect(
      kinds({
        type: "python",
        files: files({
          "code/a.py": "# Runs in the local Chrome (CDP :9222)\n# Work dir: ~/Documents/x\nprint(1)",
        }),
      }),
    ).toEqual([]);
  });

  test("macOS, home folders, Ollama, swift", () => {
    expect(
      kinds({ type: "bash", command: "osascript -e 'tell app \"Calendar\"'", files: files({}) }),
    ).toEqual(["macos"]);
    expect(
      kinds({
        type: "python",
        files: files({ "code/main.py": 'DOWNLOADS = Path.home() / "Downloads"' }),
      }),
    ).toEqual(["home-files"]);
    expect(
      kinds({
        type: "python",
        files: files({ "code/d.py": 'ROOT = os.path.join(HOME, "Documents/GitHub")' }),
      }),
    ).toEqual(["home-files"]);
    expect(kinds({ type: "agent", provider: "ollama", files: files({}) })).toEqual(["ollama"]);
    expect(kinds({ type: "swift", files: files({}) })).toEqual(["swift"]);
  });

  test("agent prompts are not scanned (agent can choose a cloud-safe tool)", () => {
    expect(
      kinds({
        type: "agent",
        command: "curl -s http://localhost:18789/api/db/query … if that fails use papr_db_query",
        files: files({}),
      }),
    ).toEqual([]);
  });

  test("referencedJobIds finds cross-job script paths", () => {
    const id = "62b8cc56-322d-4129-8787-4d8dd31b362b";
    expect(
      referencedJobIds({
        id: "a64a1e10-c6be-4028-8bf5-4a41de7737bf",
        type: "bash",
        command: `python3 $HOME/Papr/orgs/o/namespaces/n/Jobs/${id}/code/pipeline.py tweak`,
        files: files({}),
      }),
    ).toEqual([id]);
  });

  test("summaries for the card and the agent", () => {
    const hits = detectJobDesktopOnly({
      type: "python",
      files: files({ "code/s.py": "await connect_platform_browser(pw, 'linkedin.com')" }),
    });
    expect(summarizeDesktopOnly(hits)).toBe("Uses your Chrome");
    const msg = explainDesktopOnlyForAgent(hits) ?? "";
    expect(msg).toContain("local-only");
    expect(msg).toContain("code/s.py:1");
    expect(msg).toContain("headless Playwright");
    expect(explainDesktopOnlyForAgent([])).toBeUndefined();
  });
});

import { decideDesktopOnly } from "../src/gateway/services/jobs/desktopOnlyAssessment.js";

describe("decideDesktopOnly", () => {
  const chrome = detectJobDesktopOnly({
    type: "python",
    files: files({ "code/s.py": "await connect_platform_browser(pw, 'x')" }),
  });

  test("unset placement + desktop code → auto local-only with reason", () => {
    const d = decideDesktopOnly({ appIds: ["app-1"] }, chrome);
    expect(d.patch).toEqual({
      executionCapability: "local-only",
      localOnlyReason: "Uses your Chrome",
      localOnlyAuto: true,
    });
  });

  test("a chosen cloud placement is never overridden — flagged as a conflict", () => {
    const d = decideDesktopOnly({ appIds: ["app-1"], executionCapability: "cloud-preferred" }, chrome);
    expect(d.patch).toBeNull();
    expect(d.conflictsWithChoice).toBe(true);
  });

  test("chosen local-only just gains a reason", () => {
    const d = decideDesktopOnly({ appIds: ["app-1"], executionCapability: "local-only" }, chrome);
    expect(d.patch?.localOnlyReason).toBe("Uses your Chrome");
    expect(d.patch?.localOnlyAuto).toBe(false);
  });

  test("auto pin is undone when the code becomes cloud-safe; a chosen one is not", () => {
    const auto = decideDesktopOnly(
      { appIds: ["app-1"], executionCapability: "local-only", localOnlyReason: "Uses your Chrome", localOnlyAuto: true },
      [],
    );
    expect(auto.patch).toEqual({
      executionCapability: undefined,
      localOnlyReason: undefined,
      localOnlyAuto: undefined,
    });
    const chosen = decideDesktopOnly({ appIds: ["app-1"], executionCapability: "local-only" }, []);
    expect(chosen.patch).toBeNull();
  });

  test("no-op when already pinned for the same reason", () => {
    const d = decideDesktopOnly(
      { appIds: ["app-1"], executionCapability: "local-only", localOnlyReason: "Uses your Chrome", localOnlyAuto: true },
      chrome,
    );
    expect(d.patch).toBeNull();
  });
});

describe("python docstrings", () => {
  test("prose inside a module docstring is ignored, code after it is not", () => {
    const src = [
      '"""LinkedIn warm paths.',
      "",
      "Runs in the local Chrome (CDP :9222).",
      "Work dir: ~/Documents/Launch Post Studio/work/<id>/",
      '"""',
      "import os",
      'OUT = Path.home() / "Desktop" / "x"',
    ].join("\n");
    const hits = detectJobDesktopOnly({ type: "python", files: files({ "code/a.py": src }) });
    expect(hits.map((h) => [h.kind, h.line])).toEqual([["home-files", 7]]);
  });

  test("one-line docstring is ignored", () => {
    expect(
      kinds({ type: "python", files: files({ "code/a.py": '"""Reads ~/Documents/x on the Mac."""\nprint(1)' }) }),
    ).toEqual([]);
  });
});

describe("macOS media + local workspace", () => {
  test("ffmpeg avfoundation capture is macOS-only", () => {
    expect(kinds({ type: "bash", command: "ffmpeg -f avfoundation -list_devices true -i ''", files: files({}) })).toEqual(["macos"]);
  });
  test("pyobjc frameworks are macOS-only", () => {
    expect(kinds({ type: "python", files: files({ "code/a.py": "import AVFoundation\n" }) })).toEqual(["macos"]);
    expect(kinds({ type: "python", files: files({ "code/a.py": "from Quartz import CGWindowListCopyWindowInfo\n" }) })).toEqual(["macos"]);
  });
  test("literal ~/Papr workspace path needs the Mac; $PAPR_HOME does not", () => {
    expect(kinds({ type: "bash", command: 'for db in ~/Papr/jobs/*/data/data.db; do echo $db; done', files: files({}) })).toEqual(["home-files"]);
    expect(kinds({ type: "bash", command: 'ls "$PAPR_HOME/Jobs"', files: files({}) })).toEqual([]);
  });
});

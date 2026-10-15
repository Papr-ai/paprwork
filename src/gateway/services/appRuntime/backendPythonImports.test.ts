import { describe, expect, it } from "vitest";
import {
  isSafeBackendModulePath,
  pythonImportNames,
  resolveBackendPythonModules,
} from "./backendPythonImports.js";
import { runPythonHandlerFromSource } from "./appBackendRunner.js";

const HANDLER = `import json
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from caller import current_user_id  # noqa: E402
from papr_db import connect, query  # noqa: E402
from add_source import classify
import urllib.parse
print(json.dumps({"user": current_user_id(), "kind": classify()}))
`;

describe("pythonImportNames", () => {
  it("keeps local-looking names, drops stdlib and papr_db", () => {
    expect(pythonImportNames(HANDLER).sort()).toEqual(["add_source", "caller"]);
  });

  it("ignores comments and relative imports", () => {
    expect(pythonImportNames("# from caller import x\nfrom . import y\nimport foo as bar")).toEqual(["foo"]);
  });
});

describe("isSafeBackendModulePath", () => {
  it("allows only flat X.py and lib/X.py", () => {
    expect(isSafeBackendModulePath("caller.py")).toBe(true);
    expect(isSafeBackendModulePath("lib/caller.py")).toBe(true);
    expect(isSafeBackendModulePath("../caller.py")).toBe(false);
    expect(isSafeBackendModulePath("lib/../../x.py")).toBe(false);
    expect(isSafeBackendModulePath("/etc/x.py")).toBe(false);
    expect(isSafeBackendModulePath("lib/a/b.py")).toBe(false);
  });
});

describe("resolveBackendPythonModules", () => {
  const repo: Record<string, string> = {
    "backend/lib/caller.py": "from roles import ROLE\ndef current_user_id():\n    return 'u1'\n",
    "backend/lib/roles.py": "ROLE = 'owner'\n",
    "backend/add_source.py": "def classify():\n    return 'csv'\n",
  };
  const fetched: string[] = [];
  const fetchFile = async (p: string) => {
    fetched.push(p);
    return repo[p] ?? null;
  };

  it("finds sibling and lib modules, recursively", async () => {
    const out = await resolveBackendPythonModules(HANDLER, fetchFile, "overview.py");
    expect(Object.keys(out).sort()).toEqual(["add_source.py", "lib/caller.py", "lib/roles.py"]);
    expect(fetched).not.toContain("backend/json.py");
    expect(fetched).not.toContain("backend/papr_db.py");
  });

  it("returns nothing for a handler with only stdlib imports", async () => {
    expect(await resolveBackendPythonModules("import json\nprint(1)", fetchFile)).toEqual({});
  });
});

describe.each(["0", "1"])("runPythonHandlerFromSource with extraFiles (worker=%s)", (worker) => {
  it("runs a handler that imports lib/ and sibling modules from a temp dir", async () => {
    const prev = process.env.CLOUD_APP_HOST_PYTHON_WORKER;
    process.env.CLOUD_APP_HOST_PYTHON_WORKER = worker;
    try {
      const res = await runPythonHandlerFromSource(
        HANDLER.replace("from papr_db import connect, query  # noqa: E402\n", ""),
        { PATH: process.env.PATH ?? "" },
        20_000,
        {
          "lib/caller.py": "def current_user_id():\n    return 'u1'\n",
          "add_source.py": "def classify():\n    return 'csv'\n",
          "../escape.py": "raise SystemExit(9)\n",
        },
      );
      expect(res.stderr).toBe("");
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({ user: "u1", kind: "csv" });
    } finally {
      if (prev === undefined) delete process.env.CLOUD_APP_HOST_PYTHON_WORKER;
      else process.env.CLOUD_APP_HOST_PYTHON_WORKER = prev;
    }
  }, 30_000);
});

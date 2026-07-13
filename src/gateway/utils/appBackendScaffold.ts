/**
 * Default mini-app backend scaffold (apps/{appId}/backend/).
 *
 * Convention: server-side handlers live under backend/ and are registered in
 * manifest.json — same idea as Vercel's api/ folder, but manifest-driven.
 */

export const DEFAULT_BACKEND_MANIFEST = {
  version: 1,
  actions: {
    ping: {
      handler: "ping.py",
      runtime: "python",
      description: "Health check — returns JSON on stdout",
      timeoutMs: 10_000,
    },
  },
} as const;

export const DEFAULT_BACKEND_PING_HANDLER = `#!/usr/bin/env python3
"""Default backend ping handler — replace or add actions in manifest.json."""
import json
import os
import sys

def main() -> None:
    # Vault keys: declare names in manifest.json "keys" array — injected as env vars.
    # Example: api_key = os.environ.get("RR_ATTENTION_API_KEY")
    # Linked DB: APP_DB (local) or PAPR_DB_URL + PAPR_DB_AUTH_TOKEN (cloud Turso).
    #   from papr_db import connect, execute
    #   con = connect(); execute(con, "INSERT INTO ...", [...]); con.close()
    params = json.loads(os.environ.get("PAPR_ACTION_PARAMS", "{}"))
    payload = {
        "ok": True,
        "action": os.environ.get("PAPR_ACTION", "ping"),
        "appId": os.environ.get("PAPR_APP_ID"),
        "dbMode": os.environ.get("PAPR_DB_MODE"),
        "params": params,
    }
    json.dump(payload, sys.stdout)

if __name__ == "__main__":
    main()
`;

export const DEFAULT_BACKEND_PING_HANDLER_TS = `/** Default TypeScript backend ping — register with runtime "typescript". */
const params = JSON.parse(process.env.PAPR_ACTION_PARAMS ?? "{}") as Record<string, string>;
const payload = {
  ok: true,
  action: process.env.PAPR_ACTION ?? "ping",
  appId: process.env.PAPR_APP_ID,
  params,
};
console.log(JSON.stringify(payload));
`;

export const DEFAULT_BACKEND_PING_HANDLER_JS = `/** Default Node backend ping — register with runtime "node". */
const params = JSON.parse(process.env.PAPR_ACTION_PARAMS ?? "{}");
const payload = {
  ok: true,
  action: process.env.PAPR_ACTION ?? "ping",
  appId: process.env.PAPR_APP_ID,
  params,
};
console.log(JSON.stringify(payload));
`;

export const BACKEND_FOLDER = "backend";

export function hasBackendFiles(files: ReadonlyArray<{ filename: string }>): boolean {
  return files.some((f) => f.filename.startsWith(`${BACKEND_FOLDER}/`));
}

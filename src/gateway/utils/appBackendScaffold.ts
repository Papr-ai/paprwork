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
    # Example: api_key = os.environ.get("YOUR_API_KEY")
    # Linked DB (desktop + cloud, through the gateway). Never sqlite3.connect(APP_DB).
    #   from papr_db import connect, query, write
    #   con = connect()
    #   rows = query(con, "SELECT id, name FROM items", []).rows        # list of plain dicts
    #   new_id = write(con, "INSERT INTO items (name) VALUES (?)", [n]).last_insert_rowid
    # ACL: PAPR_CALLER_USER_ID / PAPR_CALLER_EMAIL — server-injected when signed in; never trust params.userId
    params = json.loads(os.environ.get("PAPR_ACTION_PARAMS", "{}"))
    payload = {
        "ok": True,
        "action": os.environ.get("PAPR_ACTION", "ping"),
        "appId": os.environ.get("PAPR_APP_ID"),
        "dbMode": os.environ.get("PAPR_DB_MODE"),
        "callerUserId": os.environ.get("PAPR_CALLER_USER_ID"),
        "callerEmail": os.environ.get("PAPR_CALLER_EMAIL"),
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
  callerUserId: process.env.PAPR_CALLER_USER_ID,
  callerEmail: process.env.PAPR_CALLER_EMAIL,
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
  callerUserId: process.env.PAPR_CALLER_USER_ID,
  callerEmail: process.env.PAPR_CALLER_EMAIL,
  params,
};
console.log(JSON.stringify(payload));
`;

export const BACKEND_FOLDER = "backend";

export function hasBackendFiles(files: ReadonlyArray<{ filename: string }>): boolean {
  return files.some((f) => f.filename.startsWith(`${BACKEND_FOLDER}/`));
}

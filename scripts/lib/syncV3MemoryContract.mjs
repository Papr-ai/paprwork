/**
 * Sync V3 memory server route contract — verified via OpenAPI before E2E probes.
 * Prevents false positives where FastAPI returns 404 for both "route missing" and
 * "app repo not found".
 */

/** OpenAPI path keys must match one pattern per required capability. */
export const SYNC_V3_OPENAPI_PATH_PATTERNS = [
  {
    id: "app_repo_get",
    label: "GET /v1/cloud/apps/{appId}/repo",
    test: (path) =>
      /\/v1\/cloud\/apps\/\{[^}]+\}\/repo$/.test(path) &&
      !path.includes("/repo/"),
  },
  {
    id: "app_repo_ensure",
    label: "POST /v1/cloud/apps/{appId}/repo/ensure",
    test: (path) => /\/v1\/cloud\/apps\/\{[^}]+\}\/repo\/ensure$/.test(path),
  },
  {
    id: "workspace_log_append",
    label: "POST /v1/cloud/workspace/log/append",
    test: (path) => path === "/v1/cloud/workspace/log/append",
  },
  {
    id: "workspace_log_append_batch",
    label: "POST /v1/cloud/workspace/log/append-batch",
    test: (path) => path === "/v1/cloud/workspace/log/append-batch",
  },
  {
    id: "workspace_log_since",
    label: "GET /v1/cloud/workspace/log/since",
    test: (path) => path === "/v1/cloud/workspace/log/since",
  },
  {
    id: "workspace_log_genesis",
    label: "POST /v1/cloud/workspace/log/genesis",
    test: (path) => path === "/v1/cloud/workspace/log/genesis",
  },
  {
    id: "scheduler_run_lease_acquire",
    label: "POST /v1/cloud/runtime/scheduler-run-lease/acquire",
    test: (path) => path === "/v1/cloud/runtime/scheduler-run-lease/acquire",
  },
  {
    id: "scheduler_run_lease_release",
    label: "POST /v1/cloud/runtime/scheduler-run-lease/release",
    test: (path) => path === "/v1/cloud/runtime/scheduler-run-lease/release",
  },
  {
    id: "writer_lease_acquire",
    label: "POST /v1/cloud/apps/{appId}/writer-lease/acquire",
    test: (path) =>
      /\/v1\/cloud\/apps\/\{[^}]+\}\/writer-lease\/acquire$/.test(path),
  },
  {
    id: "writer_lease_release",
    label: "POST /v1/cloud/apps/{appId}/writer-lease/release",
    test: (path) =>
      /\/v1\/cloud\/apps\/\{[^}]+\}\/writer-lease\/release$/.test(path),
  },
  {
    id: "runtime_dispatch_stream",
    label: "GET /v1/cloud/runtime/dispatch/stream",
    test: (path) => path === "/v1/cloud/runtime/dispatch/stream",
  },
  {
    id: "shards_status",
    label: "GET /v1/cloud/shards/status",
    test: (path) => path === "/v1/cloud/shards/status",
  },
];

/**
 * @param {string} memoryBase
 * @returns {Promise<{ ok: true, paths: string[] } | { ok: false, error: string, missing: Array<{ id: string, label: string }>, paths: string[] }>}
 */
export async function fetchMemoryOpenApiPaths(memoryBase) {
  const base = memoryBase.replace(/\/$/, "");
  let res;
  try {
    res = await fetch(`${base}/openapi.json`, { method: "GET" });
  } catch (err) {
    return {
      ok: false,
      error: `Failed to fetch OpenAPI: ${err instanceof Error ? err.message : String(err)}`,
      missing: SYNC_V3_OPENAPI_PATH_PATTERNS.map((r) => ({
        id: r.id,
        label: r.label,
      })),
      paths: [],
    };
  }

  if (!res.ok) {
    const text = await res.text();
    return {
      ok: false,
      error: `OpenAPI fetch ${res.status}: ${text.slice(0, 200)}`,
      missing: SYNC_V3_OPENAPI_PATH_PATTERNS.map((r) => ({
        id: r.id,
        label: r.label,
      })),
      paths: [],
    };
  }

  /** @type {{ paths?: Record<string, unknown> }} */
  const doc = await res.json();
  const paths = Object.keys(doc.paths ?? {});
  return { ok: true, paths };
}

/**
 * @param {string} memoryBase
 * @returns {Promise<{ ok: true, paths: string[] } | { ok: false, error: string, missing: Array<{ id: string, label: string }>, paths: string[] }>}
 */
export async function verifySyncV3MemoryRoutes(memoryBase) {
  const fetched = await fetchMemoryOpenApiPaths(memoryBase);
  if (!fetched.ok) {
    return fetched;
  }

  const { paths } = fetched;
  const missing = SYNC_V3_OPENAPI_PATH_PATTERNS.filter(
    (required) => !paths.some((path) => required.test(path)),
  ).map((r) => ({ id: r.id, label: r.label }));

  if (missing.length > 0) {
    return {
      ok: false,
      error: `Sync V3 routes missing from OpenAPI (${missing.length}/${SYNC_V3_OPENAPI_PATH_PATTERNS.length})`,
      missing,
      paths,
    };
  }

  return { ok: true, paths };
}

/**
 * After OpenAPI contract passes, GET /repo for unknown appId must be 404.
 * (Generic FastAPI "Not Found" vs app-specific message both acceptable once route is in OpenAPI.)
 *
 * @param {(path: string, init?: { method?: string, body?: unknown }) => Promise<{ status: number, text: string }>} memoryFetch
 * @param {string} appId
 */
export async function assertAppRepoRouteHandlesMissingApp(memoryFetch, appId) {
  const getRes = await memoryFetch(
    `/v1/cloud/apps/${encodeURIComponent(appId)}/repo`,
  );
  if (getRes.status === 404) {
    return { ok: true };
  }
  if (getRes.status === 200) {
    return {
      ok: false,
      error: "Expected GET /repo 404 for unknown appId, got 200",
    };
  }
  return {
    ok: false,
    error: `GET /repo unexpected ${getRes.status}: ${getRes.text.slice(0, 160)}`,
  };
}

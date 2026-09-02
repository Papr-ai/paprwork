/**
 * Papr surface attribution.
 *
 * Every request Paprwork makes to the memory server is stamped with the product
 * surface that issued it, so memories can be attributed to the client that
 * actually wrote them.
 *
 * The memory server resolves the surface in this order:
 *   1. X-Papr-Client            (paprwork | dev_platform | mcp | cli)
 *   2. X-Stainless-Lang: js     -> ts_sdk
 *   3. X-Stainless-Lang: python -> py_sdk
 *   4. otherwise                -> api
 *
 * Paprwork runs *on top of* the TypeScript SDK, which already sends
 * X-Stainless-Lang: js. Without this explicit stamp every Paprwork write would
 * be misattributed to `ts_sdk`. The explicit header wins over the SDK signal.
 *
 * No SDK release is required — `defaultHeaders` is already supported by
 * @papr/memory.
 */
export const PAPR_CLIENT_HEADER = "X-Papr-Client";
export const PAPR_SURFACE = "paprwork";

/** Default headers to pass to every `new Papr({ ... })` construction. */
export const PAPR_DEFAULT_HEADERS: Record<string, string> = {
  [PAPR_CLIENT_HEADER]: PAPR_SURFACE,
};

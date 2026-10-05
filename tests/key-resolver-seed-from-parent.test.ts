import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearKeyCache,
  getPaprApiKey,
  seedPaprApiKeyFromParent,
} from "../src/gateway/utils/keyResolver.js";

const noIpc = {} as never; // publish worker: no process.send

describe("seedPaprApiKeyFromParent (publish worker key handoff)", () => {
  // Active workspace as the gateway sees it (Electron sets these on namespace switch).
  beforeEach(() => {
    clearKeyCache();
    delete process.env.PAPR_API_KEY;
    process.env.PAPR_ORG_ID = "orgA";
    process.env.PAPR_NAMESPACE_ID = "nsA";
  });
  afterEach(() => {
    clearKeyCache();
    delete process.env.PAPR_API_KEY;
    delete process.env.PAPR_ORG_ID;
    delete process.env.PAPR_NAMESPACE_ID;
  });

  it("accepts a legacy key without an embedded namespace (the real-world case env rejects)", async () => {
    const legacy = "sk-legacy-key-without-namespace-scope";
    process.env.PAPR_API_KEY = legacy;
    // Regression: the env path refuses unparseable keys, so the worker saw no key.
    expect(await getPaprApiKey(noIpc)).toBeUndefined();

    clearKeyCache();
    delete process.env.PAPR_API_KEY;
    expect(seedPaprApiKeyFromParent(legacy)).toBe(true);
    expect(await getPaprApiKey(noIpc)).toBe(legacy);
  });

  it("accepts a key scoped to the active namespace", async () => {
    const key = "sk-org-orgA-namespace-nsA-secret";
    expect(seedPaprApiKeyFromParent(key)).toBe(true);
    expect(await getPaprApiKey(noIpc)).toBe(key);
  });

  it("refuses a key scoped to a different namespace", async () => {
    expect(seedPaprApiKeyFromParent("sk-org-orgA-namespace-nsOTHER-secret")).toBe(false);
    expect(await getPaprApiKey(noIpc)).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isRawCodeMemoryIndexEnabled,
  announceRawCodeIndexPolicyOnce,
  resetRawCodeIndexPolicyAnnounce,
} from "../src/gateway/services/storage/codeIndexPolicy.js";

const KEY = "PAPR_CODE_RAW_MEMORY_INDEX";
let original: string | undefined;

beforeEach(() => {
  original = process.env[KEY];
  delete process.env[KEY];
  resetRawCodeIndexPolicyAnnounce();
});

afterEach(() => {
  if (original === undefined) {
    delete process.env[KEY];
  } else {
    process.env[KEY] = original;
  }
});

describe("isRawCodeMemoryIndexEnabled", () => {
  it("is OFF when the env var is unset — this is the whole point of the PR", () => {
    // 29,315 duplicate code_indexer rows served 1.3% of searches. Default off.
    expect(isRawCodeMemoryIndexEnabled()).toBe(false);
  });

  it.each(["1", "true", "TRUE", "yes", "on", " 1 "])(
    "is ON for %j so the indexer can be re-enabled for measurement",
    (value) => {
      process.env[KEY] = value;
      expect(isRawCodeMemoryIndexEnabled()).toBe(true);
    },
  );

  it.each(["0", "false", "no", "off", "", "  ", "maybe", "2"])(
    "stays OFF for %j — only explicit opt-in counts",
    (value) => {
      process.env[KEY] = value;
      expect(isRawCodeMemoryIndexEnabled()).toBe(false);
    },
  );

  it("is read at call time, not module load", () => {
    // A running gateway or a test can flip it without a restart.
    expect(isRawCodeMemoryIndexEnabled()).toBe(false);
    process.env[KEY] = "1";
    expect(isRawCodeMemoryIndexEnabled()).toBe(true);
    delete process.env[KEY];
    expect(isRawCodeMemoryIndexEnabled()).toBe(false);
  });
});

describe("announceRawCodeIndexPolicyOnce", () => {
  it("logs once per process, not once per file", () => {
    // indexCodeFile() runs per file; an un-deduped log would be thousands of lines.
    const seen: string[] = [];
    const log = console.log;
    const warn = console.warn;
    console.log = (m?: unknown) => void seen.push(String(m));
    console.warn = (m?: unknown) => void seen.push(String(m));
    try {
      announceRawCodeIndexPolicyOnce();
      announceRawCodeIndexPolicyOnce();
      announceRawCodeIndexPolicyOnce();
    } finally {
      console.log = log;
      console.warn = warn;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("off (default)");
  });

  it("warns loudly when raw indexing is re-enabled", () => {
    process.env[KEY] = "1";
    const seen: string[] = [];
    const warn = console.warn;
    console.warn = (m?: unknown) => void seen.push(String(m));
    try {
      announceRawCodeIndexPolicyOnce();
    } finally {
      console.warn = warn;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("ENABLED");
    expect(seen[0]).toContain("duplicate");
  });

  it("never throws", () => {
    expect(() => announceRawCodeIndexPolicyOnce()).not.toThrow();
  });
});

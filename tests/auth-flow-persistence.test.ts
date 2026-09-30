import { describe, expect, it, beforeEach } from "vitest";
import {
  clearAuthFlowPersistence,
  isAuthFlowCompleteLocal,
  markAuthFlowCompleteLocal,
  mergeAuthFlowStage,
  persistAuthFlowStage,
  resumeStageWhenLoggedIn,
} from "../ui/utils/authFlowPersistence";

function installLocalStorage(): void {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
  (globalThis as { window?: unknown; localStorage?: typeof storage }).window = {
    localStorage: storage,
  };
  globalThis.localStorage = storage as Storage;
}

describe("authFlowPersistence", () => {
  beforeEach(() => {
    installLocalStorage();
    clearAuthFlowPersistence();
  });

  it("marks done after complete", () => {
    persistAuthFlowStage("connect");
    expect(isAuthFlowCompleteLocal()).toBe(false);
    markAuthFlowCompleteLocal();
    expect(isAuthFlowCompleteLocal()).toBe(true);
  });

  it("merge picks furthest stage", () => {
    expect(mergeAuthFlowStage("connect", "recommend")).toBe("recommend");
    expect(mergeAuthFlowStage("recommend", "connect")).toBe("recommend");
  });

  it("resume when logged in skips signin", () => {
    expect(resumeStageWhenLoggedIn("signin", undefined)).toBe("connect");
    expect(resumeStageWhenLoggedIn(undefined, "connect")).toBe("connect");
  });
});

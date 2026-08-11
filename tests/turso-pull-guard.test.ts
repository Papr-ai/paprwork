import { describe, expect, it } from "vitest";
import {
  evaluateBulkPullGate,
  shouldBlockPullWhileLocalDirty,
  shouldSkipBulkReconcileWhileMerging,
} from "../src/gateway/services/tursoPullReconcile.js";
import { isBidirectionalWriteAuthority } from "../src/gateway/services/appDataSources.js";

describe("shouldBlockPullWhileLocalDirty", () => {
  it("blocks all pull paths when local has unpushed changes", () => {
    expect(
      shouldBlockPullWhileLocalDirty({
        force: false,
        hadLocalUserTables: true,
        localDirty: true,
      }),
    ).toBe(true);
  });

  it("allows delta merge pull when mergeWhileLocalDirty is set", () => {
    expect(
      shouldBlockPullWhileLocalDirty({
        force: false,
        hadLocalUserTables: true,
        localDirty: true,
        mergeWhileLocalDirty: true,
      }),
    ).toBe(false);
  });

  it("allows pull when local is clean", () => {
    expect(
      shouldBlockPullWhileLocalDirty({
        force: false,
        hadLocalUserTables: true,
        localDirty: false,
      }),
    ).toBe(false);
  });

  it("allows forced pull when explicitly requested", () => {
    expect(
      shouldBlockPullWhileLocalDirty({
        force: true,
        hadLocalUserTables: true,
        localDirty: true,
      }),
    ).toBe(false);
  });

  it("allows empty-local bootstrap even if dirty flag set", () => {
    expect(
      shouldBlockPullWhileLocalDirty({
        force: false,
        hadLocalUserTables: false,
        localDirty: true,
      }),
    ).toBe(false);
  });
});

describe("evaluateBulkPullGate", () => {
  it("allows full pull for empty local bootstrap", () => {
    expect(
      evaluateBulkPullGate({
        force: false,
        hadLocalUserTables: false,
        localDirty: false,
        staleConsumer: false,
      }),
    ).toEqual({ action: "full_pull" });
  });

  it("blocks full pull when local has unpushed changes", () => {
    expect(
      evaluateBulkPullGate({
        force: false,
        hadLocalUserTables: true,
        localDirty: true,
        staleConsumer: false,
      }),
    ).toEqual({ action: "skip", reason: "pull_would_clobber_local" });
  });

  it("blocks stale consumer repair when local is dirty", () => {
    expect(
      evaluateBulkPullGate({
        force: false,
        hadLocalUserTables: true,
        localDirty: true,
        staleConsumer: true,
      }),
    ).toEqual({ action: "skip", reason: "stale_consumer_local_dirty" });
  });

  it("uses reconcile when local is clean and has tables", () => {
    expect(
      evaluateBulkPullGate({
        force: false,
        hadLocalUserTables: true,
        localDirty: false,
        staleConsumer: false,
      }),
    ).toEqual({ action: "reconcile" });
  });

  it("blocks forced pull when local is dirty", () => {
    expect(
      evaluateBulkPullGate({
        force: true,
        hadLocalUserTables: true,
        localDirty: true,
        staleConsumer: false,
      }),
    ).toEqual({ action: "skip", reason: "pull_would_clobber_local" });
  });

  it("allows forced full pull when local is clean", () => {
    expect(
      evaluateBulkPullGate({
        force: true,
        hadLocalUserTables: true,
        localDirty: false,
        staleConsumer: false,
      }),
    ).toEqual({ action: "full_pull" });
  });
});

describe("shouldSkipBulkReconcileWhileMerging", () => {
  it("skips snapshot reconcile during merge pull while dirty", () => {
    expect(
      shouldSkipBulkReconcileWhileMerging({
        mergeWhileLocalDirty: true,
        localDirty: true,
      }),
    ).toBe(true);
  });

  it("allows reconcile when clean or not merging", () => {
    expect(
      shouldSkipBulkReconcileWhileMerging({
        mergeWhileLocalDirty: true,
        localDirty: false,
      }),
    ).toBe(false);
    expect(
      shouldSkipBulkReconcileWhileMerging({
        mergeWhileLocalDirty: false,
        localDirty: true,
      }),
    ).toBe(false);
  });
});

describe("isBidirectionalWriteAuthority", () => {
  it("defaults to bidirectional when writeAuthority is absent", () => {
    expect(isBidirectionalWriteAuthority(undefined)).toBe(true);
    expect(isBidirectionalWriteAuthority("bidirectional")).toBe(true);
  });

  it("treats desktop as non-bidirectional", () => {
    expect(isBidirectionalWriteAuthority("desktop")).toBe(false);
  });
});

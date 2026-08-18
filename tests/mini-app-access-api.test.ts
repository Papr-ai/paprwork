import { describe, expect, it } from "vitest";
import {
  buildLocalDesktopAccessResponse,
  buildMiniAppAccessResponse,
  mergeVerifiedCallerJobParams,
  VERIFIED_CALLER_EMAIL_PARAM,
  VERIFIED_CALLER_USER_ID_PARAM,
} from "../src/gateway/services/appRuntime/miniAppAccess.js";
import type { AppAccessContext } from "../src/gateway/services/appRuntime/types.js";

describe("miniAppAccess", () => {
  it("desktop response is always owner with full access", () => {
    const access = buildLocalDesktopAccessResponse("app-123");
    expect(access).toEqual({
      mode: "owner",
      canRead: true,
      canWrite: true,
      loggedIn: true,
      isOwner: true,
      appId: "app-123",
    });
  });

  it("desktop response includes caller identity when provided", () => {
    expect(
      buildLocalDesktopAccessResponse("app-123", {
        userId: "user-abc",
        email: "dev@papr.ai",
      }),
    ).toEqual({
      mode: "owner",
      canRead: true,
      canWrite: true,
      loggedIn: true,
      isOwner: true,
      appId: "app-123",
      userId: "user-abc",
      email: "dev@papr.ai",
    });
  });

  it("cloud owner access sets isOwner and userId when logged in", () => {
    const ctx: AppAccessContext = {
      orgId: "org",
      namespaceId: "ns",
      userId: "user-42",
      appId: "app-1",
      mode: "owner",
      canRead: true,
      canWrite: true,
    };
    expect(
      buildMiniAppAccessResponse(ctx, true, undefined, { email: "owner@papr.ai" }),
    ).toEqual({
      mode: "owner",
      canRead: true,
      canWrite: true,
      loggedIn: true,
      isOwner: true,
      appId: "app-1",
      userId: "user-42",
      email: "owner@papr.ai",
    });
  });

  it("team member access exposes userId for per-user authorization", () => {
    const ctx: AppAccessContext = {
      orgId: "org",
      namespaceId: "ns",
      userId: "teammate-9",
      appId: "app-1",
      mode: "team",
      canRead: true,
      canWrite: true,
    };
    expect(buildMiniAppAccessResponse(ctx, true)).toMatchObject({
      mode: "team",
      isOwner: false,
      loggedIn: true,
      userId: "teammate-9",
    });
  });

  it("public_read visitor is not owner and omits userId when logged out", () => {
    const ctx: AppAccessContext = {
      orgId: "org",
      namespaceId: "ns",
      userId: "anon",
      appId: "app-1",
      mode: "public_read",
      canRead: true,
      canWrite: false,
    };
    expect(buildMiniAppAccessResponse(ctx, false)).toEqual({
      mode: "public_read",
      canRead: true,
      canWrite: false,
      loggedIn: false,
      isOwner: false,
      appId: "app-1",
    });
  });

  it("denied access returns null mode", () => {
    expect(buildMiniAppAccessResponse(null, false)).toEqual({
      mode: null,
      canRead: false,
      canWrite: false,
      loggedIn: false,
      isOwner: false,
    });
  });

  it("mergeVerifiedCallerJobParams overrides client identity claims", () => {
    expect(
      mergeVerifiedCallerJobParams(
        {
          PAPR_CALLER_USER_ID: "spoofed",
          THREAD_ID: "abc",
        },
        true,
        { userId: "verified-user", email: "dev@papr.ai" },
      ),
    ).toEqual({
      THREAD_ID: "abc",
      [VERIFIED_CALLER_USER_ID_PARAM]: "verified-user",
      [VERIFIED_CALLER_EMAIL_PARAM]: "dev@papr.ai",
    });
  });

  it("mergeVerifiedCallerJobParams skips injection when logged out", () => {
    expect(
      mergeVerifiedCallerJobParams({ THREAD_ID: "abc" }, false, { userId: "user-1" }),
    ).toEqual({ THREAD_ID: "abc" });
  });
});

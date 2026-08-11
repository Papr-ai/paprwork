import { describe, expect, it } from "vitest";
import {
  buildLocalDesktopAccessResponse,
  buildMiniAppAccessResponse,
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

  it("cloud owner access sets isOwner", () => {
    const ctx: AppAccessContext = {
      orgId: "org",
      namespaceId: "ns",
      userId: "user",
      appId: "app-1",
      mode: "owner",
      canRead: true,
      canWrite: true,
    };
    expect(buildMiniAppAccessResponse(ctx, true)).toMatchObject({
      mode: "owner",
      isOwner: true,
      loggedIn: true,
    });
  });

  it("public_read visitor is not owner", () => {
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
});
